import type { Almacen } from '../../src/comun/almacenamiento.service.js';
import { AlmacenamientoService } from '../../src/comun/almacenamiento.service.js';
import {
  DOMINIO,
  miembroCon,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';

/** S3 simulado (plan §6). Sus errores llevan la clave a propósito: no debe llegar a logs ni respuestas. */
class AlmacenFalso implements Almacen {
  archivos = new Map<string, { contenido: Buffer; tipo: string }>();
  borradas: string[] = [];
  fallarSubida = false;
  fallarBorrado = false;
  demoraMs = 0;

  async subir(clave: string, contenido: Buffer, tipo: string) {
    await new Promise((listo) => setTimeout(listo, this.demoraMs));
    if (this.fallarSubida) throw new Error(`S3 caído al subir ${clave}`);
    this.archivos.set(clave, { contenido, tipo });
  }

  async borrar(clave: string) {
    this.borradas.push(clave);
    if (this.fallarBorrado) throw new Error(`S3 caído al borrar ${clave}`);
    this.archivos.delete(clave);
  }
}

const MARCA = 'CONTENIDO-PRIVADO-DE-LA-FOTO';
const jpeg = (relleno = 0) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from(MARCA),
    Buffer.alloc(relleno),
  ]);
const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(MARCA),
  ]);
const CLAVE = /^vehiculos\/[0-9a-f-]{36}$/;

describe('HU-11 · Registro de vehículo (e2e)', () => {
  let e: Entorno;
  let org: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let almacen: AlmacenFalso;
  let n = 0;
  const logs: string[] = [];
  const conToken = (t: string) => ({ Authorization: `Bearer ${t}` });

  const conductor = async () => {
    const correo = `conductor${++n}${DOMINIO}`;
    const token = await miembroCon(e, org.id, correo, 'aprobada');
    const { rows } = await e.bd.query(
      `SELECT id FROM usuarios WHERE correo = $1`,
      [correo],
    );
    return { token, id: rows[0].id as string, correo };
  };
  const datos = (extra: Record<string, string | undefined> = {}) => ({
    placa: '1234-abc',
    marca: 'Toyota',
    modelo: 'Corolla',
    color: 'Blanco',
    capacidad: '4',
    aceptaUsoFoto: 'true',
    ...extra,
  });
  const registrar = (
    token: string,
    campos: Record<string, string | undefined>,
    foto: { contenido: Buffer; nombre?: string; tipo?: string } | null = {
      contenido: jpeg(),
    },
  ) => {
    let r = e.api().post('/api/v1/vehiculos').set(conToken(token));
    for (const [campo, valor] of Object.entries(campos))
      if (valor !== undefined) r = r.field(campo, valor);
    if (foto)
      r = r.attach('foto', foto.contenido, {
        filename: foto.nombre ?? 'auto.jpg',
        contentType: foto.tipo ?? 'image/jpeg',
      });
    return r;
  };
  const vehiculosDe = async (propietarioId: string) =>
    (
      await e.bd.query(
        `SELECT id, placa, marca, modelo, color, capacidad, clave_s3_foto, consentimiento_foto_en
         FROM vehiculos WHERE propietario_id = $1`,
        [propietarioId],
      )
    ).rows;
  const auditoriasDe = async (actorId: string) =>
    (
      await e.bd.query(
        `SELECT entidad_id, resultado, organizacion_id, detalle FROM registros_auditoria
         WHERE accion = 'vehiculo.registro' AND actor_id = $1 ORDER BY creado_en`,
        [actorId],
      )
    ).rows;
  const placaUnica = () => `${String(1000 + n).slice(-4)}HUB`;

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    org = await organizacionConAdmin(
      e,
      await e.iniciar(`super${DOMINIO}`),
      'Veh A',
    );
    // CA-7: todo lo que la API escribe en consola queda aquí para revisarlo.
    for (const flujo of [process.stdout, process.stderr]) {
      const original = flujo.write.bind(flujo);
      vi.spyOn(flujo, 'write').mockImplementation(((
        trozo: string | Uint8Array,
        ...resto: never[]
      ) => {
        logs.push(String(trozo));
        return original(trozo, ...resto);
      }) as typeof flujo.write);
    }
  });
  beforeEach(() => {
    almacen = new AlmacenFalso();
    e.app.get(AlmacenamientoService, { strict: false }).almacen = almacen;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await e.cerrar();
  });

  it('CA-1: un miembro aprobado registra su vehículo; la foto queda en S3 y la respuesta no la trae', async () => {
    const c = await conductor();
    const antes = Date.now();
    const r = await registrar(
      c.token,
      datos({ placa: '4321ABC', marca: '  Toyota  ' }),
    ).expect(201);
    expect(r.body).toEqual({
      id: expect.any(String),
      placa: '4321ABC',
      marca: 'Toyota',
      modelo: 'Corolla',
      color: 'Blanco',
      capacidad: 4,
    });
    const [fila] = await vehiculosDe(c.id);
    expect(fila).toMatchObject({
      id: r.body.id,
      placa: '4321ABC',
      capacidad: 4,
    });
    expect(fila.clave_s3_foto).toMatch(CLAVE);
    // RN-5: el consentimiento queda con su fecha.
    expect(
      new Date(fila.consentimiento_foto_en).getTime(),
    ).toBeGreaterThanOrEqual(antes - 1000);
    // Tipo decidido por el contenido, con los mismos bytes que mandó la app.
    expect(almacen.archivos.get(fila.clave_s3_foto)).toEqual({
      contenido: jpeg(),
      tipo: 'image/jpeg',
    });
    expect(await auditoriasDe(c.id)).toEqual([
      {
        entidad_id: r.body.id,
        resultado: 'ok',
        organizacion_id: null,
        detalle: { placa: '4321ABC' },
      },
    ]);
    const mio = await e
      .api()
      .get('/api/v1/vehiculos/mio')
      .set(conToken(c.token))
      .expect(200);
    expect(mio.body).toEqual(r.body);
  });

  it('CA-1: también acepta PNG (por su contenido, aunque el nombre diga otra cosa)', async () => {
    const c = await conductor();
    await registrar(c.token, datos({ placa: '555XYZ' }), {
      contenido: png(),
      nombre: 'foto.bin',
      tipo: 'application/octet-stream',
    }).expect(201);
    const [fila] = await vehiculosDe(c.id);
    expect(almacen.archivos.get(fila.clave_s3_foto)?.tipo).toBe('image/png');
  });

  it('CA-2: una placa ya registrada por otra persona se rechaza, aunque venga escrita distinto, sin subir la foto', async () => {
    const a = await conductor();
    const b = await conductor();
    await registrar(a.token, datos({ placa: '7777KLM' })).expect(201);
    for (const placa of ['7777KLM', '7777-klm', ' 7777 klm ']) {
      const r = await registrar(b.token, datos({ placa })).expect(409);
      expect(r.body.codigo).toBe('VEHICULO_PLACA_DUPLICADA');
      // No revela de quién es.
      expect(JSON.stringify(r.body)).not.toContain(a.id);
    }
    expect(almacen.archivos.size).toBe(1);
    expect(await vehiculosDe(b.id)).toEqual([]);
    expect((await auditoriasDe(b.id)).map((f) => f.detalle)).toEqual(
      Array(3).fill({ motivo: 'placa_duplicada' }),
    );
  });

  it('CA-2: dos personas registran la misma placa a la vez: solo una lo logra y la foto de la otra se borra', async () => {
    almacen.demoraMs = 150;
    for (let ronda = 0; ronda < 5; ronda++) {
      const [a, b] = [await conductor(), await conductor()];
      const placa = `${600 + ronda}PAR`;
      const [r1, r2] = await Promise.all([
        registrar(a.token, datos({ placa })),
        registrar(b.token, datos({ placa: placa.toLowerCase() })),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([201, 409]);
      const perdedora = r1.status === 409 ? r1 : r2;
      expect(perdedora.body.codigo).toBe('VEHICULO_PLACA_DUPLICADA');
      const { rows } = await e.bd.query(
        `SELECT clave_s3_foto FROM vehiculos WHERE placa = $1`,
        [placa],
      );
      expect(rows).toHaveLength(1);
      // Compensación: en S3 solo queda la foto de quien ganó.
      expect([...almacen.archivos.keys()]).toEqual([rows[0].clave_s3_foto]);
      expect(almacen.borradas).toHaveLength(1);
      expect(almacen.borradas[0]).not.toBe(rows[0].clave_s3_foto);
      almacen.archivos.clear();
      almacen.borradas = [];
    }
  });

  it('RN-4 y RN-6: un vehículo por persona, el mismo en todas sus organizaciones', async () => {
    const c = await conductor();
    const r = await registrar(c.token, datos({ placa: '888AAA' })).expect(201);
    const otra = await registrar(c.token, datos({ placa: '889AAA' })).expect(
      409,
    );
    expect(otra.body.codigo).toBe('VEHICULO_YA_REGISTRADO');
    // Ya tiene vehículo: no importa que la placa sea de otra persona.
    const ajena = await registrar(c.token, datos({ placa: '7777KLM' })).expect(
      409,
    );
    expect(ajena.body.codigo).toBe('VEHICULO_YA_REGISTRADO');
    // En otra organización suya sigue siendo el mismo vehículo.
    const b = await organizacionConAdmin(
      e,
      await e.iniciar(`super${DOMINIO}`),
      `Veh B${n}`,
    );
    await e.bd.query(
      `INSERT INTO membresias (organizacion_id, usuario_id, rol, estado) VALUES ($1, $2, 'miembro', 'aprobada')`,
      [b.id, c.id],
    );
    const enB = await e
      .api()
      .put('/api/v1/yo/organizacion-activa')
      .set(conToken(c.token))
      .send({ organizacionId: b.id })
      .expect(200);
    const mio = await e
      .api()
      .get('/api/v1/vehiculos/mio')
      .set(conToken(enB.body.tokenAcceso))
      .expect(200);
    expect(mio.body).toEqual(r.body);
    const enOtra = await registrar(
      enB.body.tokenAcceso,
      datos({ placa: '890AAA' }),
    ).expect(409);
    expect(enOtra.body.codigo).toBe('VEHICULO_YA_REGISTRADO');
    expect(await vehiculosDe(c.id)).toHaveLength(1);
    expect(almacen.archivos.size).toBe(1);
  });

  it('CA-3: la placa se guarda normalizada (mayúsculas, sin espacios ni guiones)', async () => {
    for (const [escrita, guardada] of [
      ['1234-abc', '1234ABC'],
      [' 321 x-y z ', '321XYZ'],
    ]) {
      const c = await conductor();
      const r = await registrar(c.token, datos({ placa: escrita })).expect(201);
      expect(r.body.placa).toBe(guardada);
      expect((await vehiculosDe(c.id))[0].placa).toBe(guardada);
    }
  });

  it('CA-4: placa o capacidad inválidas se rechazan indicando el campo, sin subir ni guardar nada', async () => {
    const c = await conductor();
    for (const placa of [
      '12ABC',
      '12345ABC',
      'ABC1234',
      '1234AB',
      '1234ABCD',
      '1234ÑAB',
      '1234.ABC',
      '',
    ]) {
      const r = await registrar(c.token, datos({ placa })).expect(400);
      expect(r.body).toMatchObject({
        codigo: 'VEHICULO_DATO_INVALIDO',
        campo: 'placa',
      });
    }
    for (const capacidad of ['0', '7', '-1', '2.5', 'cuatro', '', '04']) {
      const r = await registrar(
        c.token,
        datos({ placa: placaUnica(), capacidad }),
      ).expect(400);
      expect(r.body).toMatchObject({
        codigo: 'VEHICULO_DATO_INVALIDO',
        campo: 'capacidad',
      });
    }
    expect(almacen.archivos.size).toBe(0);
    expect(await vehiculosDe(c.id)).toEqual([]);
  });

  it('CA-4: la capacidad acepta de 1 a 6', async () => {
    for (const capacidad of ['1', '6']) {
      const c = await conductor();
      const r = await registrar(
        c.token,
        datos({ placa: placaUnica(), capacidad }),
      ).expect(201);
      expect(r.body.capacidad).toBe(Number(capacidad));
    }
  });

  it('foto inválida: falta, no es JPEG/PNG (aunque lo diga su nombre) o pasa de 5 MB → indica el límite', async () => {
    const c = await conductor();
    const casos = [
      null,
      { contenido: Buffer.from('GIF89a' + MARCA), nombre: 'auto.jpg' },
      {
        contenido: Buffer.from('%PDF-1.7'),
        nombre: 'auto.png',
        tipo: 'image/png',
      },
      { contenido: Buffer.alloc(0) },
      { contenido: jpeg(5 * 1024 * 1024) },
    ];
    for (const foto of casos) {
      const r = await registrar(c.token, datos(), foto).expect(400);
      expect(r.body).toMatchObject({
        codigo: 'VEHICULO_FOTO_INVALIDA',
        maximoBytes: 5 * 1024 * 1024,
        tipos: ['image/jpeg', 'image/png'],
      });
    }
    // Justo 5 MB sí entra.
    const limite = jpeg(5 * 1024 * 1024 - 4 - MARCA.length);
    await registrar(c.token, datos({ placa: placaUnica() }), {
      contenido: limite,
    }).expect(201);
    expect(almacen.archivos.size).toBe(1);
  });

  it('RN-5: sin aceptar el uso de la foto no se registra', async () => {
    const c = await conductor();
    for (const aceptaUsoFoto of [undefined, 'false']) {
      const r = await registrar(c.token, datos({ aceptaUsoFoto })).expect(400);
      expect(r.body.codigo).toBe('CONSENTIMIENTO_REQUERIDO');
    }
    const otro = await registrar(
      c.token,
      datos({ aceptaUsoFoto: 'si' }),
    ).expect(400);
    expect(otro.body.codigo).toBe('VALIDACION_FALLIDA');
    expect(almacen.archivos.size).toBe(0);
    expect(await vehiculosDe(c.id)).toEqual([]);
  });

  it('validación: faltan datos o sobran campos → VALIDACION_FALLIDA', async () => {
    const c = await conductor();
    for (const campos of [
      datos({ marca: undefined }),
      datos({ modelo: '   ' }),
      datos({ color: 'x'.repeat(41) }),
      { ...datos(), propietarioId: c.id },
      { ...datos(), claveS3Foto: 'vehiculos/otra' },
    ]) {
      const r = await registrar(c.token, campos).expect(400);
      expect(r.body.codigo).toBe('VALIDACION_FALLIDA');
    }
    // Una segunda foto o con otro nombre de campo tampoco pasa.
    const dos = await registrar(c.token, datos()).attach(
      'foto',
      jpeg(),
      'b.jpg',
    );
    expect(dos.status).toBe(400);
    expect(dos.body.codigo).toBe('VALIDACION_FALLIDA');
    const otroCampo = await registrar(c.token, datos(), null).attach(
      'imagen',
      jpeg(),
      'auto.jpg',
    );
    expect(otroCampo.status).toBe(400);
    expect(otroCampo.body.codigo).toBe('VALIDACION_FALLIDA');
    expect(almacen.archivos.size).toBe(0);
  });

  it('falla el almacenamiento: 503 y no se registra nada a medias', async () => {
    const c = await conductor();
    almacen.fallarSubida = true;
    const r = await registrar(c.token, datos({ placa: '999FAL' })).expect(503);
    expect(r.body.codigo).toBe('ALMACENAMIENTO_NO_DISPONIBLE');
    expect(await vehiculosDe(c.id)).toEqual([]);
    // Al volver S3, puede registrarlo.
    almacen.fallarSubida = false;
    await registrar(c.token, datos({ placa: '999FAL' })).expect(201);
  });

  it('CA-7: la foto y su clave no aparecen en respuestas, mensajes de error, auditoría ni logs', async () => {
    const a = await conductor();
    const b = await conductor();
    const desde = logs.length;
    const respuestas = [
      await registrar(a.token, datos({ placa: '246CSE' })).expect(201),
      await e.api().get('/api/v1/vehiculos/mio').set(conToken(a.token)),
      await registrar(b.token, datos({ placa: '246CSE' })),
      await registrar(a.token, datos({ placa: '247CSE' })),
    ];
    // Compensación que además falla (choque en paralelo + S3 caído al borrar): se registra el error, sin la clave.
    almacen.demoraMs = 150;
    almacen.fallarBorrado = true;
    const [c, d] = [await conductor(), await conductor()];
    respuestas.push(
      ...(await Promise.all([
        registrar(c.token, datos({ placa: '248CSE' })),
        registrar(d.token, datos({ placa: '248CSE' })),
      ])),
    );
    almacen.fallarSubida = true;
    respuestas.push(await registrar(b.token, datos({ placa: '249CSE' })));
    expect(respuestas.map((r) => r.status)).toEqual(
      expect.arrayContaining([201, 200, 409, 503]),
    );
    expect(almacen.borradas).toHaveLength(1);

    const { rows } = await e.bd.query(
      `SELECT clave_s3_foto FROM vehiculos WHERE propietario_id = ANY($1)`,
      [[a.id, c.id, d.id]],
    );
    const claves = [...rows.map((f) => f.clave_s3_foto), ...almacen.borradas];
    expect(claves).toHaveLength(3);
    const auditoria = [];
    for (const p of [a, b, c, d]) auditoria.push(...(await auditoriasDe(p.id)));
    expect(auditoria.length).toBeGreaterThanOrEqual(4);
    const textos = [
      ...respuestas.map(
        (r) => JSON.stringify(r.body) + JSON.stringify(r.headers),
      ),
      JSON.stringify(auditoria),
      logs.slice(desde).join(''),
    ];
    // Hubo logs que revisar: el borrado fallido y la subida fallida.
    expect(logs.slice(desde).join('')).toContain('No se pudo borrar');
    expect(logs.slice(desde).join('')).toContain('No se pudo subir');
    for (const texto of textos) {
      for (const clave of claves) expect(texto).not.toContain(clave);
      expect(texto).not.toContain('vehiculos/');
      expect(texto).not.toContain(MARCA);
      expect(texto).not.toMatch(/claveS3Foto|clave_s3_foto|"foto"/);
    }
  });

  it('CA-8: con membresía pendiente, rechazada o sin organización activa no puede registrar', async () => {
    const tokens = [
      await miembroCon(e, org.id, `pendiente${DOMINIO}`, 'pendiente'),
      await miembroCon(e, org.id, `rechazada${DOMINIO}`, 'rechazada'),
    ];
    await e.crearUsuario(`sinorg${DOMINIO}`);
    tokens.push(await e.iniciar(`sinorg${DOMINIO}`));
    for (const t of tokens) {
      const r = await registrar(t, datos({ placa: '135NOP' })).expect(403);
      expect(r.body.codigo).toBe('NO_AUTORIZADO');
    }
    const { rows } = await e.bd.query(
      `SELECT count(*)::int AS n FROM vehiculos WHERE placa = '135NOP'`,
    );
    expect(rows[0].n).toBe(0);
    expect(almacen.archivos.size).toBe(0);
  });

  it('sin sesión: 401 en ambos endpoints', async () => {
    const r = await e
      .api()
      .post('/api/v1/vehiculos')
      .field('placa', '136NOP')
      .attach('foto', jpeg(), 'auto.jpg')
      .expect(401);
    expect(r.body.codigo).toBe('NO_AUTENTICADO');
    await e.api().get('/api/v1/vehiculos/mio').expect(401);
  });

  it('GET /vehiculos/mio: sin vehículo es 404 y nadie ve el vehículo de otra persona', async () => {
    const a = await conductor();
    await registrar(a.token, datos({ placa: '137MIO' })).expect(201);
    const b = await conductor();
    const r = await e
      .api()
      .get('/api/v1/vehiculos/mio')
      .set(conToken(b.token))
      .expect(404);
    expect(r.body.codigo).toBe('NO_ENCONTRADO');
    expect(JSON.stringify(r.body)).not.toContain('137MIO');
    // Sin organización activa también puede consultar el suyo (basta la sesión).
    await e.bd.query(
      `UPDATE usuarios SET ultima_organizacion_id = NULL WHERE id = $1`,
      [a.id],
    );
    const sinOrg = await e.iniciar(a.correo);
    const mio = await e
      .api()
      .get('/api/v1/vehiculos/mio')
      .set(conToken(sinOrg))
      .expect(200);
    expect(mio.body.placa).toBe('137MIO');
  });
});
