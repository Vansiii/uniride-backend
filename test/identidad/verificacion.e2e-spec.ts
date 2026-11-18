import { hashDocumento } from '../../src/identidad/documento.js';
import { MAXIMO_FOTO_BYTES } from '../../src/vehiculos/foto.js';
import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import {
  ayudasIdentidad,
  carnet,
  MARCA,
  type AlmacenFalso,
  type MotorControlable,
} from './ayudas-identidad.js';

const CLAVE = /^identidades\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

describe('HU-08 · Verificación de identidad (e2e)', () => {
  let e: Entorno;
  let motor: MotorControlable;
  let almacen: AlmacenFalso;
  const logs: string[] = [];
  const a = ayudasIdentidad(() => e);
  const archivosDe = (id: string) =>
    [...almacen.archivos.keys()].filter((k) =>
      k.startsWith(`identidades/${id}/`),
    );

  beforeAll(async () => {
    e = await prepararEntorno();
    // CA-8: todo lo que la API escribe en consola queda aquí para revisarlo.
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
  beforeEach(() => ({ motor, almacen } = a.preparar()));
  afterAll(() => e.cerrar());

  describe('Autenticación y estado inicial', () => {
    it.each([
      ['post', '/api/v1/identidad/liveness-sesion'],
      ['post', '/api/v1/identidad/verificar'],
      ['get', '/api/v1/identidad/estado'],
    ] as const)('401 sin sesión: %s %s', async (metodo, ruta) => {
      const r = await e.api()[metodo](ruta).expect(401);
      expect(r.body.codigo).toBe('NO_AUTENTICADO');
    });

    it('una cuenta nueva figura como no_verificada, sin fecha ni bloqueo', async () => {
      const p = await a.persona();
      const r = await a.estado(p).expect(200);
      expect(r.body).toEqual({
        estado: 'no_verificada',
        verificadoEn: null,
        bloqueadoHasta: null,
      });
    });
  });

  describe('CA-1 · verificación exitosa', () => {
    it('foto de carnet + vivacidad + similitud ≥ 90 → verificada, con carnet cifrado, rostro indexado y auditoría', async () => {
      const p = await a.persona();
      const r = await (await a.intento(p, { rostro: 'ana' })).expect(200);
      expect(r.body).toEqual({
        estado: 'verificada',
        verificadoEn: expect.any(String),
      });

      const fila = await a.fila(p.id);
      expect(fila).toMatchObject({
        estado: 'verificada',
        documento_hash: hashDocumento(p.numero),
        intentos_fallidos: 0,
        bloqueado_hasta: null,
      });
      expect(Number(fila.similitud_facial)).toBe(98);
      expect(fila.clave_s3_carnet).toMatch(CLAVE);
      expect(fila.clave_s3_carnet).toContain(p.id);
      expect(fila.face_id_coleccion).toMatch(/^sim-face-/);
      // El carnet quedó en S3 con su tipo, y el rostro en la colección.
      expect(almacen.archivos.get(fila.clave_s3_carnet)).toMatchObject({
        tipo: 'image/jpeg',
      });
      expect(motor.indexados.get(fila.face_id_coleccion)).toMatchObject({
        usuarioId: p.id,
      });

      const estado = await a.estado(p).expect(200);
      expect(estado.body).toMatchObject({
        estado: 'verificada',
        bloqueadoHasta: null,
      });
      expect(new Date(estado.body.verificadoEn).getTime()).toBe(
        new Date(r.body.verificadoEn).getTime(),
      );

      const auditoria = await a.auditoriasDe(p.id);
      expect(auditoria).toHaveLength(1);
      expect(auditoria[0]).toMatchObject({
        resultado: 'ok',
        entidad: 'identidad',
        entidad_id: fila.id,
        organizacion_id: null,
      });
    });

    it('el documento se normaliza: mayúsculas, espacios y guiones no cambian el hash', async () => {
      const p = await a.persona();
      await (
        await a.intento(p, {
          numero: ` ${p.numero.toLowerCase().replace('-', ' ')} `,
        })
      ).expect(200);
      expect((await a.fila(p.id)).documento_hash).toBe(hashDocumento(p.numero));
    });

    it('una identidad ya verificada no se puede verificar de nuevo (400) ni pedir otra sesión', async () => {
      const p = await a.persona();
      await (await a.intento(p)).expect(200);
      const antes = motor.llamadas.liveness;
      const otra = await a
        .verificar(
          p,
          {
            numeroDocumento: '99999999',
            aceptaConsentimiento: 'true',
            sesionId: 'sim-00000000-0000-4000-8000-000000000000',
          },
          { contenido: carnet() },
        )
        .expect(400);
      expect(otra.body.codigo).toBe('IDENTIDAD_YA_VERIFICADA');
      const sesion = await e
        .api()
        .post('/api/v1/identidad/liveness-sesion')
        .set(a.conToken(p.token))
        .expect(400);
      expect(sesion.body.codigo).toBe('IDENTIDAD_YA_VERIFICADA');
      expect(motor.llamadas.liveness).toBe(antes);
      expect(archivosDe(p.id)).toHaveLength(1);
    });
  });

  describe('RN-3 · consentimiento y validación', () => {
    it.each([['false'], [undefined]])(
      'CONSENTIMIENTO_REQUERIDO (400) con aceptaConsentimiento=%s: no se toca la BD, S3 ni el motor',
      async (consentimiento) => {
        const p = await a.persona();
        const sesion = await a.sesion(p);
        const r = await a
          .verificar(
            p,
            {
              numeroDocumento: p.numero,
              sesionId: sesion,
              aceptaConsentimiento: consentimiento,
            },
            { contenido: carnet() },
          )
          .expect(400);
        expect(r.body.codigo).toBe('CONSENTIMIENTO_REQUERIDO');
        expect(await a.fila(p.id)).toBeUndefined();
        expect(almacen.archivos.size).toBe(0);
        expect(motor.llamadas).toEqual({
          liveness: 0,
          comparar: 0,
          buscar: 0,
          indexar: 0,
        });
      },
    );

    it.each([
      ['sin numeroDocumento', { numeroDocumento: undefined }],
      ['documento con símbolos', { numeroDocumento: '12$%^&' }],
      ['sin sesionId', { sesionId: undefined }],
      ['campo desconocido', { otro: 'x' }],
    ])('400 VALIDACION_FALLIDA %s, sin contar intento', async (_, cambios) => {
      const p = await a.persona();
      const r = await a
        .verificar(p, {
          numeroDocumento: p.numero,
          aceptaConsentimiento: 'true',
          sesionId: 'sim-x',
          ...cambios,
        })
        .expect(400);
      expect(r.body.codigo).toBe('VALIDACION_FALLIDA');
      expect(await a.fila(p.id)).toBeUndefined();
    });
  });

  describe('CA-2 · A-01 spoofing: foto impresa, pantalla o máscara', () => {
    it('sin vivacidad → 422 PRUEBA_VIDA_FALLIDA; sigue no verificada, sin carnet en S3 ni rostro indexado', async () => {
      const p = await a.persona();
      const r = await (
        await a.intento(p, { sesionSufijo: '~spoof' })
      ).expect(422);
      expect(r.body.codigo).toBe('PRUEBA_VIDA_FALLIDA');
      expect(motor.llamadas.comparar).toBe(0);
      expect(almacen.archivos.size).toBe(0);
      expect(motor.indexados.size).toBe(0);
      expect(await a.fila(p.id)).toMatchObject({
        estado: 'no_verificada',
        documento_hash: null,
        clave_s3_carnet: null,
        intentos_fallidos: 1,
      });
      expect((await a.estado(p)).body.estado).toBe('no_verificada');
    });

    it('una sesión inventada o ajena al motor tampoco sirve', async () => {
      const p = await a.persona();
      const r = await a
        .verificar(
          p,
          {
            numeroDocumento: p.numero,
            aceptaConsentimiento: 'true',
            sesionId: 'sesion-inventada',
          },
          { contenido: carnet() },
        )
        .expect(422);
      expect(r.body.codigo).toBe('PRUEBA_VIDA_FALLIDA');
    });
  });

  describe('CA-3 · A-01 carnet con el rostro de otra persona', () => {
    it('similitud < 90 → 422 ROSTRO_NO_COINCIDE; cuenta no verificada, nada guardado', async () => {
      const p = await a.persona();
      const r = await (
        await a.intento(p, { sesionSufijo: '~ana', foto: carnet('beto') })
      ).expect(422);
      expect(r.body.codigo).toBe('ROSTRO_NO_COINCIDE');
      expect(almacen.archivos.size).toBe(0);
      expect(motor.indexados.size).toBe(0);
      expect(await a.fila(p.id)).toMatchObject({
        estado: 'no_verificada',
        intentos_fallidos: 1,
      });
    });
  });

  describe('CA-4 · A-02 documento duplicado', () => {
    it('otro usuario con el mismo carnet (aunque lo escriba distinto) → 409 antes de gastar llamadas biométricas', async () => {
      const dueno = await a.persona();
      await (await a.intento(dueno, { rostro: 'ana' })).expect(200);
      const intruso = await a.persona();
      const sesion = await a.sesion(intruso, '~beto');
      const antes = { ...motor.llamadas };
      const r = await a
        .verificar(
          intruso,
          {
            numeroDocumento: ` ${dueno.numero.toLowerCase().replace('-', ' ')} `,
            aceptaConsentimiento: 'true',
            sesionId: sesion,
          },
          { contenido: carnet('beto') },
        )
        .expect(409);
      expect(r.body.codigo).toBe('DOCUMENTO_DUPLICADO');
      expect(motor.llamadas).toEqual(antes);
      expect(archivosDe(intruso.id)).toHaveLength(0);
      expect(await a.fila(intruso.id)).toMatchObject({
        estado: 'no_verificada',
        documento_hash: null,
      });
      // El dueño no se ve afectado.
      expect((await a.estado(dueno)).body.estado).toBe('verificada');
    });

    it('un intento fallido no reserva el carnet: su dueño real puede verificarse después', async () => {
      const atacante = await a.persona();
      await (
        await a.intento(atacante, { sesionSufijo: '~spoof', numero: '7654321' })
      ).expect(422);
      expect((await a.fila(atacante.id)).documento_hash).toBeNull();
      const dueno = await a.persona();
      await (
        await a.intento(dueno, { rostro: 'carla', numero: '7654321' })
      ).expect(200);
    });

    it('en paralelo: dos cuentas envían el mismo carnet a la vez → una sola queda verificada, la otra recibe 409 y no deja nada', async () => {
      const [x, y] = [await a.persona(), await a.persona()];
      const sx = await a.sesion(x, '~xavi');
      const sy = await a.sesion(y, '~yuri');
      almacen.demoraMs = 80; // ambas pasan la comprobación previa antes de que alguna guarde
      const enviar = (p: typeof x, sesionId: string, rostro: string) =>
        a.verificar(
          p,
          {
            numeroDocumento: '5550001',
            aceptaConsentimiento: 'true',
            sesionId,
          },
          { contenido: carnet(rostro) },
        );
      const [rx, ry] = await Promise.all([
        enviar(x, sx, 'xavi'),
        enviar(y, sy, 'yuri'),
      ]);
      const estados = [rx.status, ry.status].sort();
      expect(estados).toEqual([200, 409]);
      const perdedora = rx.status === 409 ? rx : ry;
      expect(perdedora.body.codigo).toBe('DOCUMENTO_DUPLICADO');
      const { rows } = await e.bd.query(
        `SELECT usuario_id FROM identidades WHERE documento_hash = $1`,
        [hashDocumento('5550001')],
      );
      expect(rows).toHaveLength(1);
      // Compensación: solo queda el carnet y el rostro de la ganadora.
      expect(almacen.archivos.size).toBe(1);
      expect(motor.indexados.size).toBe(1);
      const ganadora = rows[0].usuario_id === x.id ? x : y;
      expect(archivosDe(ganadora.id)).toHaveLength(1);
      expect([...motor.indexados.values()][0].usuarioId).toBe(ganadora.id);
    });

    it('en paralelo: el mismo usuario envía dos veces → una verificación y un 400; sin archivos ni rostros huérfanos', async () => {
      const p = await a.persona();
      const s1 = await a.sesion(p, '~zoe');
      const s2 = await a.sesion(p, '~zoe');
      almacen.demoraMs = 60;
      const enviar = (sesionId: string) =>
        a.verificar(
          p,
          {
            numeroDocumento: '5550002',
            aceptaConsentimiento: 'true',
            sesionId,
          },
          { contenido: carnet('zoe') },
        );
      const [r1, r2] = await Promise.all([enviar(s1), enviar(s2)]);
      expect([r1.status, r2.status].sort()).toEqual([200, 400]);
      expect((r1.status === 400 ? r1 : r2).body.codigo).toBe(
        'IDENTIDAD_YA_VERIFICADA',
      );
      expect(almacen.archivos.size).toBe(1);
      expect(motor.indexados.size).toBe(1);
      expect(await a.auditoriasDe(p.id)).toHaveLength(1);
    });
  });

  describe('CA-5 · A-02 rostro duplicado', () => {
    it('el mismo rostro con otro carnet y otro documento → 409 ROSTRO_DUPLICADO; nada guardado', async () => {
      const dueno = await a.persona();
      await (await a.intento(dueno, { rostro: 'ana' })).expect(200);
      const segunda = await a.persona();
      const r = await (
        await a.intento(segunda, { rostro: 'ana', numero: '8888888' })
      ).expect(409);
      expect(r.body.codigo).toBe('ROSTRO_DUPLICADO');
      expect(archivosDe(segunda.id)).toHaveLength(0);
      expect(motor.indexados.size).toBe(1);
      expect(await a.fila(segunda.id)).toMatchObject({
        estado: 'no_verificada',
        documento_hash: null,
        face_id_coleccion: null,
        intentos_fallidos: 1,
      });
    });

    it('en paralelo: la misma cara con dos documentos a la vez nunca deja las dos cuentas verificadas', async () => {
      const [x, y] = [await a.persona(), await a.persona()];
      const sx = await a.sesion(x, '~lola');
      const sy = await a.sesion(y, '~lola');
      almacen.demoraMs = 60;
      const enviar = (p: typeof x, sesionId: string, numeroDocumento: string) =>
        a.verificar(
          p,
          { numeroDocumento, aceptaConsentimiento: 'true', sesionId },
          { contenido: carnet('lola') },
        );
      const respuestas = await Promise.all([
        enviar(x, sx, '6660001'),
        enviar(y, sy, '6660002'),
      ]);
      const exitos = respuestas.filter((r) => r.status === 200).length;
      expect(exitos).toBeLessThanOrEqual(1);
      for (const r of respuestas.filter((r) => r.status !== 200))
        expect(r.body.codigo).toBe('ROSTRO_DUPLICADO');
      expect(almacen.archivos.size).toBe(exitos);
      expect(motor.indexados.size).toBe(exitos);
      const { rows } = await e.bd.query(
        `SELECT count(*)::int AS n FROM identidades WHERE usuario_id = ANY($1) AND estado = 'verificada'`,
        [[x.id, y.id]],
      );
      expect(rows[0].n).toBe(exitos);
    });
  });

  describe('CA-7 · imagen ilegible', () => {
    it.each([
      ['carnet borroso', carnet('ana', 'BORROSA')],
      ['sin rostro detectable', carnet('ana', 'SIN_ROSTRO')],
      ['no es una imagen JPEG/PNG', Buffer.from('%PDF-1.4 no es una imagen')],
    ])(
      '%s → 400 IMAGEN_ILEGIBLE, nada guardado, cuenta intento',
      async (_, foto) => {
        const p = await a.persona();
        const r = await (
          await a.intento(p, { sesionSufijo: '~ana', foto })
        ).expect(400);
        expect(r.body.codigo).toBe('IMAGEN_ILEGIBLE');
        expect(r.body.mensaje).toContain('nítida');
        expect(almacen.archivos.size).toBe(0);
        expect(motor.indexados.size).toBe(0);
        expect(await a.fila(p.id)).toMatchObject({
          estado: 'no_verificada',
          intentos_fallidos: 1,
        });
      },
    );

    it('sin archivo → 400 IMAGEN_ILEGIBLE', async () => {
      const p = await a.persona();
      const r = await (await a.intento(p, { foto: null })).expect(400);
      expect(r.body.codigo).toBe('IMAGEN_ILEGIBLE');
    });

    it('más de 5 MB → 400 IMAGEN_ILEGIBLE (no 413); se corta antes del servicio y no cuenta intento', async () => {
      const p = await a.persona();
      const grande = Buffer.concat([carnet(), Buffer.alloc(MAXIMO_FOTO_BYTES)]);
      const r = await (await a.intento(p, { foto: grande })).expect(400);
      expect(r.body.codigo).toBe('IMAGEN_ILEGIBLE');
      expect(await a.fila(p.id)).toBeUndefined();
    });
  });

  describe('CA-9 · bloqueo tras 3 fallos consecutivos', () => {
    it('el tercer fallo bloquea 24 h (429); durante el bloqueo no se llama al motor; vencido, se puede reintentar', async () => {
      const p = await a.persona();
      const spoof = { sesionSufijo: '~spoof' };
      const primero = await (await a.intento(p, spoof)).expect(422);
      const segundo = await (await a.intento(p, spoof)).expect(422);
      expect([primero.body.codigo, segundo.body.codigo]).toEqual([
        'PRUEBA_VIDA_FALLIDA',
        'PRUEBA_VIDA_FALLIDA',
      ]);
      expect((await a.estado(p)).body.estado).toBe('no_verificada');

      const antes = Date.now();
      const tercero = await (await a.intento(p, spoof)).expect(429);
      expect(tercero.body.codigo).toBe('INTENTOS_AGOTADOS');
      const hasta = new Date(tercero.body.bloqueadoHasta).getTime();
      expect(hasta).toBeGreaterThanOrEqual(antes + 24 * 3600 * 1000 - 5000);
      expect(hasta).toBeLessThanOrEqual(Date.now() + 24 * 3600 * 1000 + 5000);
      expect(await a.fila(p.id)).toMatchObject({
        estado: 'bloqueada_temporal',
        intentos_fallidos: 3,
      });
      const estado = await a.estado(p).expect(200);
      expect(estado.body.estado).toBe('bloqueada_temporal');
      expect(new Date(estado.body.bloqueadoHasta).getTime()).toBe(hasta);

      // Con el bloqueo vigente, ni siquiera un intento válido llega al motor.
      // La sesión de liveness también se niega (403).
      const sesion = await e
        .api()
        .post('/api/v1/identidad/liveness-sesion')
        .set(a.conToken(p.token))
        .expect(403);
      expect(sesion.body.codigo).toBe('IDENTIDAD_BLOQUEADA_TEMPORAL');
      const llamadas = { ...motor.llamadas };
      const bloqueado = await a
        .verificar(
          p,
          {
            numeroDocumento: p.numero,
            aceptaConsentimiento: 'true',
            sesionId: 'sim-00000000-0000-4000-8000-000000000000~ana',
          },
          { contenido: carnet('ana') },
        )
        .expect(429);
      expect(bloqueado.body.codigo).toBe('INTENTOS_AGOTADOS');
      expect(motor.llamadas).toEqual(llamadas);
      expect((await a.fila(p.id)).intentos_fallidos).toBe(3);

      // Vence el bloqueo: vuelve a poder intentar, con 3 intentos nuevos.
      await e.bd.query(
        `UPDATE identidades SET bloqueado_hasta = now() - interval '1 minute' WHERE usuario_id = $1`,
        [p.id],
      );
      expect((await a.estado(p)).body).toMatchObject({
        estado: 'no_verificada',
        bloqueadoHasta: null,
      });
      await (await a.intento(p, { rostro: 'ana' })).expect(200);
      expect(await a.fila(p.id)).toMatchObject({
        estado: 'verificada',
        intentos_fallidos: 0,
        bloqueado_hasta: null,
      });
    });

    it('mezcla de motivos: rostro ajeno, imagen ilegible y documento duplicado suman para el bloqueo', async () => {
      const dueno = await a.persona();
      await (
        await a.intento(dueno, { numero: '4440001', rostro: 'dora' })
      ).expect(200);
      const p = await a.persona();
      await (
        await a.intento(p, { sesionSufijo: '~ana', foto: carnet('beto') })
      ).expect(422);
      await (
        await a.intento(p, {
          foto: carnet('ana', 'BORROSA'),
          sesionSufijo: '~ana',
        })
      ).expect(400);
      const r = await (await a.intento(p, { numero: '4440001' })).expect(429);
      expect(r.body.codigo).toBe('INTENTOS_AGOTADOS');
      const motivos = (await a.auditoriasDe(p.id)).map((x) => x.detalle.motivo);
      expect(motivos).toEqual([
        'rostro_no_coincide',
        'imagen_ilegible',
        'documento_duplicado',
      ]);
    });

    it('los bloqueos son por cuenta: otra cuenta no se ve afectada', async () => {
      const bloqueada = await a.persona();
      for (let i = 0; i < 3; i++)
        await a.intento(bloqueada, { sesionSufijo: '~spoof' });
      const otra = await a.persona();
      await (await a.intento(otra, { rostro: 'eva' })).expect(200);
    });
  });

  describe('Falla de servicios externos: estado consistente', () => {
    it('falla del motor → 503 SERVICIO_NO_DISPONIBLE; no cuenta intento, no guarda nada ni filtra detalles', async () => {
      const p = await a.persona();
      const sesion = await a.sesion(p, '~ana');
      motor.fallar = true;
      const r = await a
        .verificar(
          p,
          {
            numeroDocumento: p.numero,
            aceptaConsentimiento: 'true',
            sesionId: sesion,
          },
          { contenido: carnet('ana') },
        )
        .expect(503);
      expect(r.body.codigo).toBe('SERVICIO_NO_DISPONIBLE');
      expect(JSON.stringify(r.body)).not.toContain(MARCA);
      expect(almacen.archivos.size).toBe(0);
      expect((await a.fila(p.id))?.intentos_fallidos ?? 0).toBe(0);
      expect((await a.estado(p)).body.estado).toBe('no_verificada');
    });

    it('falla del motor al crear la sesión → 503', async () => {
      const p = await a.persona();
      motor.fallar = true;
      const r = await e
        .api()
        .post('/api/v1/identidad/liveness-sesion')
        .set(a.conToken(p.token))
        .expect(503);
      expect(r.body.codigo).toBe('SERVICIO_NO_DISPONIBLE');
    });

    it('falla de S3 → 503; nada indexado ni guardado, sin intento contado', async () => {
      const p = await a.persona();
      almacen.fallarSubida = true;
      const r = await (await a.intento(p, { rostro: 'ana' })).expect(503);
      expect(r.body.codigo).toBe('SERVICIO_NO_DISPONIBLE');
      expect(JSON.stringify(r.body)).not.toContain('identidades/');
      expect(motor.indexados.size).toBe(0);
      expect((await a.fila(p.id))?.intentos_fallidos ?? 0).toBe(0);
      // Recuperado el servicio, la misma persona puede verificarse.
      almacen.fallarSubida = false;
      await (await a.intento(p, { rostro: 'ana' })).expect(200);
    });
  });

  describe('CA-8 · privacidad: la foto, el hash, el documento y el face id no salen de la API', () => {
    it('ni respuestas, ni logs, ni auditoría los contienen (éxito y fallos)', async () => {
      const dueno = await a.persona();
      const respuestas: unknown[] = [];
      const guardar = async (
        r: Promise<{ body: unknown }> | { body: unknown },
      ) => respuestas.push((await r).body);

      await guardar(
        a.intento(dueno, { rostro: 'ana', sesionSufijo: '~spoof' }),
      );
      await guardar(a.intento(dueno, { rostro: 'ana' }));
      await guardar(a.estado(dueno));
      await guardar(
        a.verificar(
          dueno,
          {
            numeroDocumento: dueno.numero,
            aceptaConsentimiento: 'true',
            sesionId: 'sim-00000000-0000-4000-8000-000000000000',
          },
          { contenido: carnet('ana') },
        ),
      ); // ya verificada
      const otro = await a.persona();
      await guardar(a.intento(otro, { rostro: 'ana', numero: '3330002' })); // rostro duplicado
      await guardar(a.intento(otro, { numero: dueno.numero, rostro: 'beto' })); // documento duplicado
      await guardar(a.estado(otro));

      const fila = await a.fila(dueno.id);
      const secretos = [
        MARCA,
        'ROSTRO:ana',
        dueno.numero,
        dueno.numero.split('-')[0],
        hashDocumento(dueno.numero),
        fila.documento_hash,
        fila.face_id_coleccion,
        fila.clave_s3_carnet,
        fila.clave_s3_carnet.split('/')[2],
      ];
      const auditorias = JSON.stringify([
        ...(await a.auditoriasDe(dueno.id)),
        ...(await a.auditoriasDe(otro.id)),
      ]);
      const texto = {
        respuestas: JSON.stringify(respuestas),
        logs: logs.join('\n'),
        auditoria: auditorias,
      };
      for (const [donde, contenido] of Object.entries(texto))
        for (const secreto of secretos)
          expect(contenido, `${donde} contiene ${secreto}`).not.toContain(
            secreto,
          );
      // Las respuestas de éxito y estado solo traen estado y fechas.
      expect(Object.keys((await a.estado(dueno)).body).sort()).toEqual([
        'bloqueadoHasta',
        'estado',
        'verificadoEn',
      ]);
    });
  });
});
