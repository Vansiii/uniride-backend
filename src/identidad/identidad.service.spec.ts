import { AuditoriaService } from '../auditoria/auditoria.service.js';
import type { BilleteraService } from '../billetera/billetera.service.js';
import { AlmacenamientoService } from '../comun/almacenamiento.service.js';
import { MotorFacialSimulado } from '../comun/motor-facial-simulado.js';
import { PrismaService } from '../comun/prisma.service.js';
import { RekognitionService } from '../comun/rekognition.service.js';
import { MAXIMO_FOTO_BYTES } from '../vehiculos/foto.js';
import type { VerificarIdentidadDto } from './dto/identidad.dto.js';
import { hashDocumento } from './documento.js';
import { BLOQUEO_MS, IdentidadService } from './identidad.service.js';

const USUARIO = '11111111-1111-4111-8111-111111111111';
const OTRO = '22222222-2222-4222-8222-222222222222';
const SESION = 'sim-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const jpeg = (marca = '') =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(marca)]);
const foto = (marca = '') => {
  const buffer = jpeg(marca);
  return { buffer, size: buffer.length };
};
const dto = (
  extra: Partial<VerificarIdentidadDto> = {},
): VerificarIdentidadDto => ({
  numeroDocumento: '1234567-1A',
  aceptaConsentimiento: true,
  sesionId: SESION,
  ...extra,
});
const hace = (ms: number) => new Date(Date.now() + ms);

interface Opciones {
  fila?: object | null;
  /** Fila de otra cuenta que ya tiene el documento. */
  duenoDocumento?: string;
  /** Lo que devuelve la lectura tras contar un intento fallido. */
  tras?: object;
}

function crear(o: Opciones = {}) {
  const identidad = {
    findUnique: vi.fn(
      ({ where }: { where: Record<string, string>; select?: object }) =>
        where.documentoHash
          ? Promise.resolve(
              o.duenoDocumento ? { usuarioId: o.duenoDocumento } : null,
            )
          : Promise.resolve(o.fila ?? null),
    ),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    createMany: vi.fn().mockResolvedValue({ count: 1 }),
    findUniqueOrThrow: vi.fn().mockResolvedValue({
      id: 'i1',
      estado: 'no_verificada',
      intentosFallidos: 1,
      bloqueadoHasta: null,
      ...o.tras,
    }),
  };
  const prisma = {
    identidad,
    $transaction: vi.fn((fn: (t: unknown) => unknown) => fn({ identidad })),
  };
  const auditoria = { registrar: vi.fn().mockResolvedValue(undefined) };
  const almacenamiento = {
    subir: vi.fn().mockResolvedValue(undefined),
    borrar: vi.fn().mockResolvedValue(undefined),
    descargar: vi.fn().mockResolvedValue(Buffer.from('carnet-bytes')),
  };
  const billetera = { crearAutomatica: vi.fn().mockResolvedValue(undefined) };
  const motor = new MotorFacialSimulado();
  const espias = {
    liveness: vi.spyOn(motor, 'obtenerResultadoLiveness'),
    comparar: vi.spyOn(motor, 'compararRostros'),
    buscar: vi.spyOn(motor, 'buscarRostroDuplicado'),
    indexar: vi.spyOn(motor, 'indexarRostro'),
    desindexar: vi.spyOn(motor, 'desindexarRostro'),
  };
  const servicio = new IdentidadService(
    prisma as unknown as PrismaService,
    auditoria as unknown as AuditoriaService,
    almacenamiento as unknown as AlmacenamientoService,
    { motor } as unknown as RekognitionService,
    billetera as unknown as BilleteraService,
  );
  return {
    servicio,
    billetera,
    identidad,
    prisma,
    auditoria,
    almacenamiento,
    motor,
    ...espias,
  };
}
type Contexto = ReturnType<typeof crear>;

const intentoContado = (c: Contexto) =>
  c.identidad.updateMany.mock.calls.some(
    ([a]) => a.data.intentosFallidos?.increment === 1,
  );
const bloqueoAplicado = (c: Contexto) =>
  c.identidad.updateMany.mock.calls
    .map(([a]) => a.data)
    .find((d) => d.estado === 'bloqueada_temporal');
const fallo = (promesa: Promise<unknown>) =>
  promesa.then(
    () => {
      throw new Error('debía fallar');
    },
    (e) => e,
  );
const rechazo = async (c: Contexto, esperado: [number, string]) => {
  const error = await fallo(c.servicio.verificar(USUARIO, dto(), foto()));
  expect([error.getStatus(), error.codigo]).toEqual(esperado);
  return error;
};

beforeEach(() => vi.stubEnv('IDENTIDAD_SECRETO', 'secreto-unitario'));
afterEach(() => vi.unstubAllEnvs());

describe('IdentidadService.verificar', () => {
  it('CA-1: vivacidad ok, similitud ≥ 90, sin duplicados → verificada, con foto cifrada, rostro indexado y auditoría', async () => {
    const c = crear();
    const r = await c.servicio.verificar(USUARIO, dto(), foto());
    expect(r).toEqual({ estado: 'verificada', verificadoEn: expect.any(Date) });

    const [clave, contenido, tipo] = c.almacenamiento.subir.mock.calls[0];
    expect(clave).toMatch(new RegExp(`^identidades/${USUARIO}/[0-9a-f-]{36}$`));
    expect([contenido, tipo]).toEqual([jpeg(), 'image/jpeg']);
    expect(c.indexar).toHaveBeenCalledWith(contenido, USUARIO);

    const { where, data } = c.identidad.updateMany.mock.calls[0][0];
    expect(where).toMatchObject({
      usuarioId: USUARIO,
      estado: { not: 'verificada' },
    });
    expect(data).toMatchObject({
      estado: 'verificada',
      documentoHash: hashDocumento('1234567-1A'),
      similitudFacial: 98,
      claveS3Carnet: clave,
      faceIdColeccion: expect.stringMatching(/^sim-face-/),
      intentosFallidos: 0,
      bloqueadoHasta: null,
      verificadoEn: r.verificadoEn,
    });
    expect(c.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'identidad.verificacion',
        resultado: 'ok',
        actorId: USUARIO,
        entidadId: 'i1',
      }),
      expect.anything(),
    );
    expect(intentoContado(c)).toBe(false);
  });

  it('RN-3: sin consentimiento responde 400 antes de tocar la BD, S3 o el motor', async () => {
    for (const aceptaConsentimiento of [undefined, false]) {
      const c = crear();
      const error = await fallo(
        c.servicio.verificar(USUARIO, dto({ aceptaConsentimiento }), foto()),
      );
      expect([error.getStatus(), error.codigo]).toEqual([
        400,
        'CONSENTIMIENTO_REQUERIDO',
      ]);
      expect(c.identidad.findUnique).not.toHaveBeenCalled();
      expect(c.prisma.$transaction).not.toHaveBeenCalled();
      expect(c.liveness).not.toHaveBeenCalled();
      expect(c.almacenamiento.subir).not.toHaveBeenCalled();
    }
  });

  it('una identidad ya verificada responde 400 IDENTIDAD_YA_VERIFICADA sin gastar llamadas', async () => {
    const c = crear({ fila: { estado: 'verificada', bloqueadoHasta: null } });
    await rechazo(c, [400, 'IDENTIDAD_YA_VERIFICADA']);
    expect(c.liveness).not.toHaveBeenCalled();
    expect(intentoContado(c)).toBe(false);
  });

  it('CA-9: con bloqueo vigente responde 429 INTENTOS_AGOTADOS con la fecha, sin tocar nada', async () => {
    const hasta = hace(60_000);
    const c = crear({
      fila: { estado: 'bloqueada_temporal', bloqueadoHasta: hasta },
    });
    const error = await rechazo(c, [429, 'INTENTOS_AGOTADOS']);
    expect(error.getResponse().bloqueadoHasta).toEqual(hasta);
    expect(c.liveness).not.toHaveBeenCalled();
    expect(c.identidad.updateMany).not.toHaveBeenCalled();
    expect(c.almacenamiento.subir).not.toHaveBeenCalled();
  });

  it('CA-9: vencido el bloqueo se reinician los intentos y se puede verificar', async () => {
    const c = crear({
      fila: { estado: 'bloqueada_temporal', bloqueadoHasta: hace(-1000) },
    });
    await expect(
      c.servicio.verificar(USUARIO, dto(), foto()),
    ).resolves.toMatchObject({ estado: 'verificada' });
    expect(c.identidad.updateMany.mock.calls[0][0]).toMatchObject({
      where: { usuarioId: USUARIO, estado: { not: 'verificada' } },
      data: {
        estado: 'no_verificada',
        intentosFallidos: 0,
        bloqueadoHasta: null,
      },
    });
  });

  it.each([
    ['falta la foto', undefined],
    ['no es JPEG ni PNG', { buffer: Buffer.from('GIF89a'), size: 6 }],
    ['pasa de 5 MB', { buffer: jpeg(), size: MAXIMO_FOTO_BYTES + 1 }],
  ])(
    'CA-7: si %s → 400 IMAGEN_ILEGIBLE, cuenta intento y no gasta el motor',
    async (_, f) => {
      const c = crear();
      const error = await fallo(c.servicio.verificar(USUARIO, dto(), f));
      expect([error.getStatus(), error.codigo]).toEqual([
        400,
        'IMAGEN_ILEGIBLE',
      ]);
      expect(intentoContado(c)).toBe(true);
      expect(c.liveness).not.toHaveBeenCalled();
      expect(c.almacenamiento.subir).not.toHaveBeenCalled();
    },
  );

  it('CA-7: carnet borroso o sin rostro (el motor no lo lee) → 400 IMAGEN_ILEGIBLE, nada se sube ni se indexa', async () => {
    for (const marca of ['BORROSA', 'SIN_ROSTRO']) {
      const c = crear();
      const error = await fallo(
        c.servicio.verificar(USUARIO, dto(), foto(marca)),
      );
      expect([error.getStatus(), error.codigo]).toEqual([
        400,
        'IMAGEN_ILEGIBLE',
      ]);
      expect(intentoContado(c)).toBe(true);
      expect(c.almacenamiento.subir).not.toHaveBeenCalled();
      expect(c.indexar).not.toHaveBeenCalled();
    }
  });

  it('CA-4 / A-02: documento de otra cuenta → 409 antes de gastar llamadas biométricas; cuenta intento', async () => {
    const c = crear({ duenoDocumento: OTRO });
    await rechazo(c, [409, 'DOCUMENTO_DUPLICADO']);
    expect(c.identidad.findUnique).toHaveBeenCalledWith({
      where: { documentoHash: hashDocumento('1234567-1A') },
      select: { usuarioId: true },
    });
    expect(c.liveness).not.toHaveBeenCalled();
    expect(c.comparar).not.toHaveBeenCalled();
    expect(intentoContado(c)).toBe(true);
  });

  it('CA-2 / A-01: spoofing (sesión sin vivacidad) → 422 PRUEBA_VIDA_FALLIDA; no se compara ni se sube nada', async () => {
    const c = crear();
    const error = await fallo(
      c.servicio.verificar(
        USUARIO,
        dto({ sesionId: `${SESION}~spoof` }),
        foto(),
      ),
    );
    expect([error.getStatus(), error.codigo]).toEqual([
      422,
      'PRUEBA_VIDA_FALLIDA',
    ]);
    expect(c.comparar).not.toHaveBeenCalled();
    expect(c.almacenamiento.subir).not.toHaveBeenCalled();
    expect(intentoContado(c)).toBe(true);
  });

  it.each([
    ['confianza 84 (< 85)', { exitosa: true, confianza: 84 }],
    ['Status distinto de SUCCEEDED', { exitosa: false, confianza: 99 }],
    ['sin imagen de referencia', { exitosa: true, confianza: 99 }],
  ])('A-01: %s → PRUEBA_VIDA_FALLIDA', async (_, resultado) => {
    const c = crear();
    c.liveness.mockResolvedValue({
      ...resultado,
      imagenReferencia: undefined,
    });
    await rechazo(c, [422, 'PRUEBA_VIDA_FALLIDA']);
  });

  it('A-01: confianza exactamente 85 aprueba', async () => {
    const c = crear();
    c.liveness.mockResolvedValue({
      exitosa: true,
      confianza: 85,
      imagenReferencia: Buffer.from('ROSTRO:generico'),
    });
    await expect(
      c.servicio.verificar(USUARIO, dto(), foto()),
    ).resolves.toMatchObject({ estado: 'verificada' });
  });

  it('CA-3 / A-01: carnet de otra persona → 422 ROSTRO_NO_COINCIDE; no se sube ni se indexa', async () => {
    const c = crear();
    const error = await fallo(
      c.servicio.verificar(
        USUARIO,
        dto({ sesionId: `${SESION}~ana` }),
        foto('ROSTRO:beto'),
      ),
    );
    expect([error.getStatus(), error.codigo]).toEqual([
      422,
      'ROSTRO_NO_COINCIDE',
    ]);
    expect(c.almacenamiento.subir).not.toHaveBeenCalled();
    expect(c.indexar).not.toHaveBeenCalled();
    expect(intentoContado(c)).toBe(true);
  });

  it('RN-1: similitud exactamente 90 coincide; 89.9 no', async () => {
    const c = crear();
    c.comparar.mockResolvedValue(90);
    await expect(
      c.servicio.verificar(USUARIO, dto(), foto()),
    ).resolves.toMatchObject({ estado: 'verificada' });
    const d = crear();
    d.comparar.mockResolvedValue(89.9);
    await rechazo(d, [422, 'ROSTRO_NO_COINCIDE']);
  });

  it('CA-5 / A-02: rostro de otra cuenta → 409 ROSTRO_DUPLICADO; no se sube ni se indexa', async () => {
    const c = crear();
    await c.motor.indexarRostro(jpeg(), OTRO);
    await rechazo(c, [409, 'ROSTRO_DUPLICADO']);
    expect(c.buscar).toHaveBeenCalledWith(jpeg(), USUARIO);
    expect(c.almacenamiento.subir).not.toHaveBeenCalled();
    expect(c.indexar).toHaveBeenCalledTimes(1); // solo el de preparación
    expect(intentoContado(c)).toBe(true);
  });

  it('A-02 en paralelo: si tras indexar aparece el mismo rostro de otra cuenta → 409 ROSTRO_DUPLICADO, se deshace todo y cuenta intento', async () => {
    const c = crear();
    c.buscar.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await rechazo(c, [409, 'ROSTRO_DUPLICADO']);
    const [clave] = c.almacenamiento.subir.mock.calls[0];
    expect(c.almacenamiento.borrar).toHaveBeenCalledWith(clave);
    expect(c.desindexar).toHaveBeenCalledTimes(1);
    expect(c.motor.indexados.size).toBe(0);
    expect(c.auditoria.registrar).toHaveBeenCalledTimes(1);
    expect(intentoContado(c)).toBe(true);
  });

  it('CA-9: el tercer fallo consecutivo bloquea 24 h y responde 429 con la fecha', async () => {
    const c = crear({ tras: { intentosFallidos: 3 } });
    c.liveness.mockResolvedValue({ exitosa: false, confianza: 1 });
    const antes = Date.now();
    const error = await rechazo(c, [429, 'INTENTOS_AGOTADOS']);
    const bloqueo = bloqueoAplicado(c);
    expect(bloqueo.bloqueadoHasta.getTime()).toBeGreaterThanOrEqual(
      antes + BLOQUEO_MS,
    );
    expect(bloqueo.bloqueadoHasta.getTime()).toBeLessThanOrEqual(
      Date.now() + BLOQUEO_MS,
    );
    expect(error.getResponse().bloqueadoHasta).toEqual(bloqueo.bloqueadoHasta);
    expect(c.auditoria.registrar.mock.calls[0][0]).toMatchObject({
      accion: 'identidad.verificacion',
      resultado: 'fallo',
      actorId: USUARIO,
      detalle: { motivo: 'prueba_vida_fallida', intentos: 3, bloqueada: true },
    });
  });

  it('CA-9: el primer y segundo fallo no bloquean y devuelven su propio error', async () => {
    for (const intentosFallidos of [1, 2]) {
      const c = crear({ tras: { intentosFallidos } });
      c.liveness.mockResolvedValue({ exitosa: false, confianza: 1 });
      await rechazo(c, [422, 'PRUEBA_VIDA_FALLIDA']);
      expect(bloqueoAplicado(c)).toBeUndefined();
    }
  });

  it('un fallo concurrente tras quedar verificada no bloquea ni cuenta sobre la identidad verificada', async () => {
    const c = crear({ tras: { estado: 'verificada', intentosFallidos: 9 } });
    c.liveness.mockResolvedValue({ exitosa: false, confianza: 1 });
    await rechazo(c, [422, 'PRUEBA_VIDA_FALLIDA']);
    expect(bloqueoAplicado(c)).toBeUndefined();
    for (const [a] of c.identidad.updateMany.mock.calls)
      expect(a.where.estado).toEqual({ not: 'verificada' });
  });

  it('la auditoría de un fallo no lleva documento, hash, foto ni face id', async () => {
    const c = crear();
    c.liveness.mockResolvedValue({ exitosa: false, confianza: 1 });
    await rechazo(c, [422, 'PRUEBA_VIDA_FALLIDA']);
    const evento = JSON.stringify(c.auditoria.registrar.mock.calls);
    expect(evento).not.toContain('1234567');
    expect(evento).not.toContain(hashDocumento('1234567-1A'));
  });

  it.each([
    ['la vivacidad', 'liveness'],
    ['la comparación', 'comparar'],
    ['la búsqueda de duplicados', 'buscar'],
  ] as const)(
    'falla del motor en %s → 503 SERVICIO_NO_DISPONIBLE; sin intento, sin S3, sin cambios',
    async (_, paso) => {
      const c = crear();
      c[paso].mockRejectedValue(
        Object.assign(new Error('detalle sensible'), {
          name: 'ThrottlingException',
        }),
      );
      const error = await rechazo(c, [503, 'SERVICIO_NO_DISPONIBLE']);
      expect(JSON.stringify(error.getResponse())).not.toContain(
        'detalle sensible',
      );
      expect(c.prisma.$transaction).not.toHaveBeenCalled();
      expect(c.almacenamiento.subir).not.toHaveBeenCalled();
    },
  );

  it('falla de S3 → 503 sin indexar ni guardar', async () => {
    const c = crear();
    c.almacenamiento.subir.mockRejectedValue(new Error('S3 caído'));
    await rechazo(c, [503, 'SERVICIO_NO_DISPONIBLE']);
    expect(c.indexar).not.toHaveBeenCalled();
    expect(c.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('falla al indexar → 503 y se borra la foto ya subida', async () => {
    const c = crear();
    c.indexar.mockRejectedValue(new Error('Rekognition caído'));
    await rechazo(c, [503, 'SERVICIO_NO_DISPONIBLE']);
    const [clave] = c.almacenamiento.subir.mock.calls[0];
    expect(c.almacenamiento.borrar).toHaveBeenCalledWith(clave);
    expect(c.prisma.$transaction).not.toHaveBeenCalled();
    expect(intentoContado(c)).toBe(false);
  });

  it('falla la BD al guardar → 503 y se deshace todo: foto borrada y rostro desindexado', async () => {
    const c = crear();
    c.prisma.$transaction.mockRejectedValueOnce(
      Object.assign(new Error('fila con hash y clave'), { code: 'P1001' }),
    );
    const error = await rechazo(c, [503, 'SERVICIO_NO_DISPONIBLE']);
    expect(JSON.stringify(error.getResponse())).not.toContain('hash');
    const [clave] = c.almacenamiento.subir.mock.calls[0];
    const faceId = await c.indexar.mock.results[0].value;
    expect(c.almacenamiento.borrar).toHaveBeenCalledWith(clave);
    expect(c.desindexar).toHaveBeenCalledWith(faceId);
    expect(await c.motor.buscarRostroDuplicado(jpeg(), OTRO)).toBe(false);
  });

  it('A-02 en paralelo: si el UNIQUE del documento salta al guardar → 409, se deshace todo y cuenta intento', async () => {
    const c = crear();
    c.prisma.$transaction.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint'), { code: 'P2002' }),
    );
    await rechazo(c, [409, 'DOCUMENTO_DUPLICADO']);
    expect(c.almacenamiento.borrar).toHaveBeenCalledTimes(1);
    expect(c.desindexar).toHaveBeenCalledTimes(1);
    expect(intentoContado(c)).toBe(true);
  });

  it('dos verificaciones paralelas del mismo usuario: la que llega tarde recibe 400 y se deshace', async () => {
    const c = crear({ tras: { estado: 'verificada' } });
    c.identidad.updateMany.mockResolvedValueOnce({ count: 0 });
    await rechazo(c, [400, 'IDENTIDAD_YA_VERIFICADA']);
    expect(c.almacenamiento.borrar).toHaveBeenCalledTimes(1);
    expect(c.desindexar).toHaveBeenCalledTimes(1);
    expect(c.auditoria.registrar).not.toHaveBeenCalled();
  });

  it('un bloqueo aplicado en paralelo impide guardar la verificación', async () => {
    const hasta = hace(3_600_000);
    const c = crear({
      tras: { estado: 'bloqueada_temporal', bloqueadoHasta: hasta },
    });
    c.identidad.updateMany.mockResolvedValueOnce({ count: 0 });
    const error = await rechazo(c, [429, 'INTENTOS_AGOTADOS']);
    expect(error.getResponse().bloqueadoHasta).toEqual(hasta);
    expect(c.almacenamiento.borrar).toHaveBeenCalledTimes(1);
  });

  it('si desindexar también falla, el error original no se pierde', async () => {
    const c = crear();
    c.prisma.$transaction.mockRejectedValueOnce(new Error('BD caída'));
    c.desindexar.mockRejectedValue(new Error('Rekognition caído'));
    await rechazo(c, [503, 'SERVICIO_NO_DISPONIBLE']);
  });

  it('sin IDENTIDAD_SECRETO falla claro y antes de tocar el motor', async () => {
    vi.stubEnv('IDENTIDAD_SECRETO', '');
    const c = crear();
    await expect(c.servicio.verificar(USUARIO, dto(), foto())).rejects.toThrow(
      'IDENTIDAD_SECRETO',
    );
    expect(c.liveness).not.toHaveBeenCalled();
  });
});

describe('IdentidadService.crearSesionLiveness', () => {
  it('devuelve el id de la sesión del motor', async () => {
    const c = crear();
    const r = await c.servicio.crearSesionLiveness(USUARIO);
    expect(r.sesionId).toMatch(/^sim-/);
  });

  it('ya verificada → 400 IDENTIDAD_YA_VERIFICADA', async () => {
    const c = crear({ fila: { estado: 'verificada', bloqueadoHasta: null } });
    const error = await fallo(c.servicio.crearSesionLiveness(USUARIO));
    expect([error.getStatus(), error.codigo]).toEqual([
      400,
      'IDENTIDAD_YA_VERIFICADA',
    ]);
  });

  it('con bloqueo vigente → 403 IDENTIDAD_BLOQUEADA_TEMPORAL con la fecha', async () => {
    const hasta = hace(5000);
    const c = crear({
      fila: { estado: 'bloqueada_temporal', bloqueadoHasta: hasta },
    });
    const error = await fallo(c.servicio.crearSesionLiveness(USUARIO));
    expect([error.getStatus(), error.codigo]).toEqual([
      403,
      'IDENTIDAD_BLOQUEADA_TEMPORAL',
    ]);
    expect(error.getResponse().bloqueadoHasta).toEqual(hasta);
  });

  it('con bloqueo vencido deja crear la sesión', async () => {
    const c = crear({
      fila: { estado: 'bloqueada_temporal', bloqueadoHasta: hace(-1) },
    });
    await expect(
      c.servicio.crearSesionLiveness(USUARIO),
    ).resolves.toBeDefined();
  });

  it('falla del motor → 503 SERVICIO_NO_DISPONIBLE', async () => {
    const c = crear();
    vi.spyOn(c.motor, 'crearSesionLiveness').mockRejectedValue(new Error('x'));
    const error = await fallo(c.servicio.crearSesionLiveness(USUARIO));
    expect([error.getStatus(), error.codigo]).toEqual([
      503,
      'SERVICIO_NO_DISPONIBLE',
    ]);
  });
});

describe('IdentidadService.estado', () => {
  it('CA-8: sin fila es no_verificada', async () => {
    await expect(crear().servicio.estado(USUARIO)).resolves.toEqual({
      estado: 'no_verificada',
      verificadoEn: null,
      bloqueadoHasta: null,
    });
  });

  it('CA-8: solo expone estado y fechas', async () => {
    const verificadoEn = new Date();
    const c = crear({
      fila: {
        estado: 'verificada',
        verificadoEn,
        bloqueadoHasta: null,
        documentoHash: 'h',
        claveS3Carnet: 'c',
        faceIdColeccion: 'f',
      },
    });
    const r = await c.servicio.estado(USUARIO);
    expect(r).toEqual({
      estado: 'verificada',
      verificadoEn,
      bloqueadoHasta: null,
    });
    expect(c.identidad.findUnique.mock.calls[0][0].select).toEqual({
      estado: true,
      bloqueadoHasta: true,
      verificadoEn: true,
    });
  });

  it('bloqueo vigente: bloqueada_temporal con la fecha; vencido: no_verificada sin fecha', async () => {
    const hasta = hace(10_000);
    await expect(
      crear({
        fila: {
          estado: 'bloqueada_temporal',
          bloqueadoHasta: hasta,
          verificadoEn: null,
        },
      }).servicio.estado(USUARIO),
    ).resolves.toEqual({
      estado: 'bloqueada_temporal',
      verificadoEn: null,
      bloqueadoHasta: hasta,
    });
    await expect(
      crear({
        fila: {
          estado: 'bloqueada_temporal',
          bloqueadoHasta: hace(-10_000),
          verificadoEn: null,
        },
      }).servicio.estado(USUARIO),
    ).resolves.toEqual({
      estado: 'no_verificada',
      verificadoEn: null,
      bloqueadoHasta: null,
    });
  });
});

describe('IdentidadService.onModuleInit', () => {
  it('fuera de pruebas exige IDENTIDAD_SECRETO', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('IDENTIDAD_SECRETO', '');
    expect(() => crear().servicio.onModuleInit()).toThrow('IDENTIDAD_SECRETO');
    vi.stubEnv('IDENTIDAD_SECRETO', 'x');
    expect(() => crear().servicio.onModuleInit()).not.toThrow();
  });

  it('en pruebas no lo exige', () => {
    vi.stubEnv('IDENTIDAD_SECRETO', '');
    expect(() => crear().servicio.onModuleInit()).not.toThrow();
  });
});

describe('HU-10 · comprobarRostroDelTitular y revinculacion', () => {
  it('tieneIdentidadAprobada: true solo si estado es verificada', async () => {
    const c1 = crear({ fila: { estado: 'verificada' } });
    expect(await c1.servicio.tieneIdentidadAprobada(USUARIO)).toBe(true);

    const c2 = crear({ fila: { estado: 'no_verificada' } });
    expect(await c2.servicio.tieneIdentidadAprobada(USUARIO)).toBe(false);

    const c3 = crear({ fila: null });
    expect(await c3.servicio.tieneIdentidadAprobada(USUARIO)).toBe(false);
  });

  it('crearSesionLivenessRevinculacion: con bloqueo lanza 429 INTENTOS_AGOTADOS', async () => {
    const hasta = new Date(Date.now() + 3_600_000);
    const c = crear({ fila: { estado: 'verificada', bloqueadoHasta: hasta } });
    await expect(
      c.servicio.crearSesionLivenessRevinculacion(USUARIO),
    ).rejects.toMatchObject({
      status: 429,
      response: { codigo: 'INTENTOS_AGOTADOS' },
    });
  });

  it('crearSesionLivenessRevinculacion: sin bloqueo devuelve id de sesion', async () => {
    const c = crear({ fila: { estado: 'verificada', bloqueadoHasta: null } });
    const id = await c.servicio.crearSesionLivenessRevinculacion(USUARIO);
    expect(typeof id).toBe('string');
  });

  it('comprobarRostroDelTitular: si no está verificada no hace nada', async () => {
    const c = crear({ fila: { estado: 'no_verificada' } });
    await expect(
      c.servicio.comprobarRostroDelTitular(USUARIO, 'sesion-1'),
    ).resolves.toBeUndefined();
    expect(c.almacenamiento.descargar).not.toHaveBeenCalled();
  });

  it('comprobarRostroDelTitular: con bloqueo vigente responde 429 INTENTOS_AGOTADOS', async () => {
    const hasta = new Date(Date.now() + 3_600_000);
    const c = crear({
      fila: {
        id: 'i1',
        estado: 'verificada',
        claveS3Carnet: 'identidades/carnet.jpg',
        intentosFallidos: 3,
        bloqueadoHasta: hasta,
      },
    });
    await expect(
      c.servicio.comprobarRostroDelTitular(USUARIO, 'sesion-1'),
    ).rejects.toMatchObject({
      status: 429,
      response: { codigo: 'INTENTOS_AGOTADOS' },
    });
    expect(c.almacenamiento.descargar).not.toHaveBeenCalled();
  });

  it('comprobarRostroDelTitular: sin sesionLivenessId lanza PRUEBA_VIDA_FALLIDA y suma intento', async () => {
    const c = crear({
      fila: {
        id: 'i1',
        estado: 'verificada',
        claveS3Carnet: 'identidades/carnet.jpg',
        intentosFallidos: 0,
        bloqueadoHasta: null,
      },
      tras: {
        id: 'i1',
        intentosFallidos: 1,
      },
    });
    await expect(
      c.servicio.comprobarRostroDelTitular(USUARIO, undefined),
    ).rejects.toMatchObject({
      status: 422,
      response: { codigo: 'PRUEBA_VIDA_FALLIDA' },
    });
    expect(c.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'dispositivo.revinculacion',
        resultado: 'fallo',
        detalle: expect.objectContaining({ motivo: 'prueba_vida_fallida' }),
      }),
      expect.anything(),
    );
  });

  it('comprobarRostroDelTitular: falla al descargar carnet de S3 lanza 503 sin contar intento', async () => {
    const c = crear({
      fila: {
        id: 'i1',
        estado: 'verificada',
        claveS3Carnet: 'identidades/carnet.jpg',
        intentosFallidos: 0,
        bloqueadoHasta: null,
      },
    });
    c.almacenamiento.descargar.mockRejectedValue(new Error('S3 error'));
    await expect(
      c.servicio.comprobarRostroDelTitular(USUARIO, 'sesion-1'),
    ).rejects.toMatchObject({
      status: 503,
      response: { codigo: 'SERVICIO_NO_DISPONIBLE' },
    });
    expect(c.identidad.updateMany).not.toHaveBeenCalled();
  });

  it('comprobarRostroDelTitular: vivacidad fallida suma intento y audita', async () => {
    const c = crear({
      fila: {
        id: 'i1',
        estado: 'verificada',
        claveS3Carnet: 'identidades/carnet.jpg',
        intentosFallidos: 0,
        bloqueadoHasta: null,
      },
      tras: {
        id: 'i1',
        intentosFallidos: 1,
      },
    });
    c.liveness.mockResolvedValueOnce({
      exitosa: false,
      confianza: 50,
      imagenReferencia: null,
    });
    await expect(
      c.servicio.comprobarRostroDelTitular(USUARIO, 'sesion-1'),
    ).rejects.toMatchObject({
      status: 422,
      response: { codigo: 'PRUEBA_VIDA_FALLIDA' },
    });
  });

  it('comprobarRostroDelTitular: rostro no coincide suma intento y audita', async () => {
    const c = crear({
      fila: {
        id: 'i1',
        estado: 'verificada',
        claveS3Carnet: 'identidades/carnet.jpg',
        intentosFallidos: 0,
        bloqueadoHasta: null,
      },
      tras: {
        id: 'i1',
        intentosFallidos: 1,
      },
    });
    c.liveness.mockResolvedValueOnce({
      exitosa: true,
      confianza: 99,
      imagenReferencia: Buffer.from('ref'),
    });
    c.comparar.mockResolvedValueOnce(60); // < 90%
    await expect(
      c.servicio.comprobarRostroDelTitular(USUARIO, 'sesion-1'),
    ).rejects.toMatchObject({
      status: 422,
      response: { codigo: 'ROSTRO_NO_COINCIDE' },
    });
  });

  it('comprobarRostroDelTitular: tercer intento fallido bloquea 24 h y responde 429 INTENTOS_AGOTADOS', async () => {
    const c = crear({
      fila: {
        id: 'i1',
        estado: 'verificada',
        claveS3Carnet: 'identidades/carnet.jpg',
        intentosFallidos: 2,
        bloqueadoHasta: null,
      },
      tras: {
        id: 'i1',
        intentosFallidos: 3,
      },
    });
    c.liveness.mockResolvedValueOnce({
      exitosa: true,
      confianza: 99,
      imagenReferencia: Buffer.from('ref'),
    });
    c.comparar.mockResolvedValueOnce(50);
    await expect(
      c.servicio.comprobarRostroDelTitular(USUARIO, 'sesion-1'),
    ).rejects.toMatchObject({
      status: 429,
      response: { codigo: 'INTENTOS_AGOTADOS' },
    });
    expect(c.identidad.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { usuarioId: USUARIO },
        data: expect.objectContaining({
          bloqueadoHasta: expect.any(Date),
        }),
      }),
    );
  });

  it('comprobarRostroDelTitular: vivacidad y comparacion exitosas resuelven y resetean fallos', async () => {
    const c = crear({
      fila: {
        id: 'i1',
        estado: 'verificada',
        claveS3Carnet: 'identidades/carnet.jpg',
        intentosFallidos: 1,
        bloqueadoHasta: null,
      },
    });
    c.liveness.mockResolvedValueOnce({
      exitosa: true,
      confianza: 95,
      imagenReferencia: Buffer.from('ref'),
    });
    c.comparar.mockResolvedValueOnce(95);
    await expect(
      c.servicio.comprobarRostroDelTitular(USUARIO, 'sesion-1'),
    ).resolves.toBeUndefined();
    expect(c.identidad.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { usuarioId: USUARIO },
        data: { intentosFallidos: 0, bloqueadoHasta: null },
      }),
    );
  });
});
