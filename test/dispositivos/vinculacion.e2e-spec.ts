import { generateKeyPairSync, sign } from 'node:crypto';
import { Body, Controller, HttpCode, Module, Post } from '@nestjs/common';
import {
  FirmaDispositivoModule,
  mensajeCanonico,
  RequiereFirmaDispositivo,
} from '../../src/comun/firma-dispositivo.guard.js';
import {
  DOMINIO,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';

/** Controlador SOLO de prueba: un endpoint sensible cualquiera protegido con el guard (HU-12/13/17 harán lo mismo). */
@Controller('prueba-firma')
class PruebaFirmaController {
  @Post('eco')
  @HttpCode(200)
  @RequiereFirmaDispositivo()
  eco(@Body() cuerpo: object) {
    return { recibido: cuerpo };
  }
}
@Module({
  imports: [FirmaDispositivoModule],
  controllers: [PruebaFirmaController],
})
class PruebaFirmaModule {}

const par = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pemPublico = (k: ReturnType<typeof par>) =>
  k.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const INTEGRO = 'simulado:integro';

let nonce = 0;
/** Lo que haría la app: firma METODO, RUTA, TIMESTAMP, NONCE y SHA256(CUERPO) con la llave del Keystore. */
function firmar(
  llave: ReturnType<typeof par>,
  dispositivoId: string,
  o: { ruta: string; cuerpo: string; marca?: number; nonce?: string },
) {
  const marca = String(o.marca ?? Date.now());
  const n = o.nonce ?? `nonce-e2e-${Date.now()}-${++nonce}`;
  const mensaje = mensajeCanonico(
    'POST',
    o.ruta,
    marca,
    n,
    Buffer.from(o.cuerpo),
  );
  return {
    'X-Dispositivo-Id': dispositivoId,
    'X-Timestamp': marca,
    'X-Nonce': n,
    'X-Firma': sign('sha256', Buffer.from(mensaje), llave.privateKey).toString(
      'base64',
    ),
  };
}

describe('HU-09 · vinculación de dispositivo y firma de peticiones (e2e)', () => {
  let e: Entorno;
  const modoAnterior = process.env.MODO_EMULADOR_DEV;
  const llaveAna = par();
  let tokenAna: string;
  let tokenBeto: string;
  let tokenCarla: string;
  let dispositivoAna: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const desafio = async (token: string) =>
    (
      await e
        .api()
        .post('/api/v1/dispositivos/desafio-atestacion')
        .set(auth(token))
        .expect(201)
    ).body.desafio as string;
  const vincular = (token: string, cuerpo: object) =>
    e
      .api()
      .post('/api/v1/dispositivos/vincular')
      .set(auth(token))
      .send({ modelo: 'Pixel 8', ...cuerpo });
  const filas = async (correo: string) =>
    (
      await e.bd.query(
        `SELECT d.* FROM dispositivos d JOIN usuarios u ON u.id = d.usuario_id WHERE u.correo = $1`,
        [correo],
      )
    ).rows;

  beforeAll(async () => {
    // Bypass de desarrollo: solo existe porque NODE_ENV no es production (ver play-integrity.service.spec.ts).
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno([PruebaFirmaModule]);
    for (const nombre of ['ana', 'beto', 'carla'])
      await e.crearUsuario(`disp.${nombre}${DOMINIO}`);
    tokenAna = await e.iniciar(`disp.ana${DOMINIO}`);
    tokenBeto = await e.iniciar(`disp.beto${DOMINIO}`);
    tokenCarla = await e.iniciar(`disp.carla${DOMINIO}`);
  });

  afterAll(async () => {
    if (modoAnterior === undefined) delete process.env.MODO_EMULADOR_DEV;
    else process.env.MODO_EMULADOR_DEV = modoAnterior;
    await e.cerrar();
  });

  it('exige sesión en los tres endpoints', async () => {
    await e.api().post('/api/v1/dispositivos/desafio-atestacion').expect(401);
    await e.api().post('/api/v1/dispositivos/vincular').send({}).expect(401);
    await e.api().get('/api/v1/dispositivos/mi-dispositivo').expect(401);
  });

  it('sin vincular, mi-dispositivo responde 404 NO_ENCONTRADO', async () => {
    const r = await e
      .api()
      .get('/api/v1/dispositivos/mi-dispositivo')
      .set(auth(tokenAna))
      .expect(404);
    expect(r.body.codigo).toBe('NO_ENCONTRADO');
  });

  describe('CA-1: vinculación con atestación válida', () => {
    it('guarda la llave pública y deja el dispositivo vinculado y auditado', async () => {
      const d = await desafio(tokenAna);
      const r = await vincular(tokenAna, {
        desafio: d,
        tokenIntegridad: INTEGRO,
        llavePublicaPem: pemPublico(llaveAna),
      }).expect(200);
      expect(r.body).toEqual({ id: expect.any(String), estado: 'vinculado' });
      dispositivoAna = r.body.id;

      const [fila] = await filas(`disp.ana${DOMINIO}`);
      expect(fila).toMatchObject({
        id: dispositivoAna,
        algoritmo: 'ECDSA_P256',
        activo: true,
        modelo_dispositivo: 'Pixel 8',
        veredicto_integridad: 'SIMULADO',
        llave_publica: pemPublico(llaveAna),
      });
      const { rows } = await e.bd.query(
        `SELECT resultado FROM registros_auditoria WHERE accion = 'dispositivo.vinculacion' AND entidad_id = $1`,
        [dispositivoAna],
      );
      expect(rows).toEqual([{ resultado: 'ok' }]);
    });

    it('mi-dispositivo muestra modelo y estado, nunca la llave', async () => {
      const r = await e
        .api()
        .get('/api/v1/dispositivos/mi-dispositivo')
        .set(auth(tokenAna))
        .expect(200);
      expect(r.body).toEqual({
        id: dispositivoAna,
        modelo: 'Pixel 8',
        vinculadoEn: expect.any(String),
        activo: true,
      });
    });

    it('un desafío que el servidor nunca emitió se rechaza', async () => {
      const r = await vincular(tokenBeto, {
        desafio: 'desafio-que-nadie-emitio',
        tokenIntegridad: INTEGRO,
        llavePublicaPem: pemPublico(par()),
      }).expect(400);
      expect(r.body.codigo).toBe('DESAFIO_INVALIDO');
    });

    it('un desafío emitido a otra cuenta no sirve y queda consumido', async () => {
      const deCarla = await desafio(tokenCarla);
      const r = await vincular(tokenBeto, {
        desafio: deCarla,
        tokenIntegridad: INTEGRO,
        llavePublicaPem: pemPublico(par()),
      }).expect(400);
      expect(r.body.codigo).toBe('DESAFIO_INVALIDO');
      expect(await filas(`disp.beto${DOMINIO}`)).toHaveLength(0);
    });
  });

  describe('CA-6: una cuenta, un dispositivo (A-02)', () => {
    it('quien ya tiene dispositivo no puede pedir otro desafío', async () => {
      const r = await e
        .api()
        .post('/api/v1/dispositivos/desafio-atestacion')
        .set(auth(tokenAna))
        .expect(400);
      expect(r.body.codigo).toBe('DISPOSITIVO_YA_VINCULADO');
    });

    it('tampoco vinculando con un desafío emitido antes de tener dispositivo', async () => {
      // Carla emite 2 desafíos: con uno vincula y con el otro intenta una segunda vez desde "otro teléfono".
      const primero = await desafio(tokenCarla);
      const segundo = await desafio(tokenCarla);
      await vincular(tokenCarla, {
        desafio: primero,
        tokenIntegridad: INTEGRO,
        llavePublicaPem: pemPublico(par()),
      }).expect(200);
      const reuso = await vincular(tokenCarla, {
        desafio: primero,
        tokenIntegridad: INTEGRO,
        llavePublicaPem: pemPublico(par()),
      }).expect(400);
      expect(reuso.body.codigo).toBe('DESAFIO_INVALIDO'); // A-05: un solo uso
      const r = await vincular(tokenCarla, {
        desafio: segundo,
        tokenIntegridad: INTEGRO,
        llavePublicaPem: pemPublico(par()),
      }).expect(400);
      expect(r.body.codigo).toBe('DISPOSITIVO_YA_VINCULADO');
      expect(await filas(`disp.carla${DOMINIO}`)).toHaveLength(1);
    });

    it('dos vinculaciones simultáneas: una gana, la otra recibe DISPOSITIVO_YA_VINCULADO y no queda nada a medias', async () => {
      await e.bd.query(
        `DELETE FROM dispositivos WHERE usuario_id = (SELECT id FROM usuarios WHERE correo = $1)`,
        [`disp.carla${DOMINIO}`],
      );
      const [d1, d2] = [await desafio(tokenCarla), await desafio(tokenCarla)];
      const intento = (d: string) =>
        vincular(tokenCarla, {
          desafio: d,
          tokenIntegridad: INTEGRO,
          llavePublicaPem: pemPublico(par()),
        });
      const respuestas = await Promise.all([intento(d1), intento(d2)]);
      expect(respuestas.map((r) => r.status).sort()).toEqual([200, 400]);
      expect(respuestas.find((r) => r.status === 400)?.body.codigo).toBe(
        'DISPOSITIVO_YA_VINCULADO',
      );
      expect(await filas(`disp.carla${DOMINIO}`)).toHaveLength(1);
    });
  });

  describe('CA-2 / A-03: dispositivo no íntegro', () => {
    it.each(['simulado:emulador', 'simulado:root', 'token-falso'])(
      '%s se rechaza con 422 DISPOSITIVO_NO_INTEGRO y no guarda nada',
      async (tokenIntegridad) => {
        const d = await desafio(tokenBeto);
        const r = await vincular(tokenBeto, {
          desafio: d,
          tokenIntegridad,
          llavePublicaPem: pemPublico(par()),
        }).expect(422);
        expect(r.body.codigo).toBe('DISPOSITIVO_NO_INTEGRO');
        expect(await filas(`disp.beto${DOMINIO}`)).toHaveLength(0);
        // el desafío quedó consumido: no se puede reintentar con el mismo
        const otra = await vincular(tokenBeto, {
          desafio: d,
          tokenIntegridad: INTEGRO,
          llavePublicaPem: pemPublico(par()),
        }).expect(400);
        expect(otra.body.codigo).toBe('DESAFIO_INVALIDO');
      },
    );

    it('la auditoría guarda el motivo; la respuesta no', async () => {
      const { rows } = await e.bd.query(
        `SELECT detalle FROM registros_auditoria WHERE accion = 'dispositivo.vinculacion' AND resultado = 'fallo' AND detalle->>'motivo' = 'simulado'`,
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it('si Google Play no responde: 503 SERVICIO_NO_DISPONIBLE y nada guardado', async () => {
      const d = await desafio(tokenBeto);
      const r = await vincular(tokenBeto, {
        desafio: d,
        tokenIntegridad: 'simulado:caido',
        llavePublicaPem: pemPublico(par()),
      }).expect(503);
      expect(r.body.codigo).toBe('SERVICIO_NO_DISPONIBLE');
      expect(await filas(`disp.beto${DOMINIO}`)).toHaveLength(0);
    });

    it('una llave que no es EC P-256 pública se rechaza con 400 LLAVE_INVALIDA', async () => {
      const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
        .publicKey.export({ type: 'spki', format: 'pem' })
        .toString();
      for (const llavePublicaPem of [rsa, 'no es una llave']) {
        const d = await desafio(tokenBeto);
        const r = await vincular(tokenBeto, {
          desafio: d,
          tokenIntegridad: INTEGRO,
          llavePublicaPem,
        }).expect(400);
        expect(r.body.codigo).toBe('LLAVE_INVALIDA');
      }
      expect(await filas(`disp.beto${DOMINIO}`)).toHaveLength(0);
    });

    it('campos faltantes: 400 VALIDACION_FALLIDA', async () => {
      const r = await e
        .api()
        .post('/api/v1/dispositivos/vincular')
        .set(auth(tokenBeto))
        .send({ desafio: 'x' })
        .expect(400);
      expect(r.body.codigo).toBe('VALIDACION_FALLIDA');
    });
  });

  describe('firma de peticiones sensibles de punta a punta (A-04, A-05, A-08)', () => {
    const RUTA = '/api/v1/prueba-firma/eco?x=1';
    const CUERPO = JSON.stringify({ monto: 10 });
    const enviar = (
      token: string,
      cabeceras: Record<string, string>,
      cuerpo = CUERPO,
      ruta = RUTA,
    ) =>
      e
        .api()
        .post(ruta)
        .set(auth(token))
        .set('Content-Type', 'application/json')
        .set(cabeceras)
        .send(cuerpo);
    const firmaAna = (extra: Partial<Parameters<typeof firmar>[2]> = {}) =>
      firmar(llaveAna, dispositivoAna, {
        ruta: RUTA,
        cuerpo: CUERPO,
        ...extra,
      });

    it('CA-4: bien firmada por el dispositivo de la cuenta responde 200 y marca el último uso', async () => {
      const r = await enviar(tokenAna, firmaAna()).expect(200);
      expect(r.body).toEqual({ recibido: { monto: 10 } });
      await vi.waitFor(async () => {
        const [fila] = await filas(`disp.ana${DOMINIO}`);
        expect(fila.ultimo_uso_en).not.toBeNull();
      });
    });

    it('CA-3 / A-08: sin encabezados de firma (curl, Postman) responde 401', async () => {
      const r = await enviar(tokenAna, {}).expect(401);
      expect(r.body.codigo).toBe('FIRMA_DISPOSITIVO_INVALIDA');
    });

    it('sin sesión responde 401 NO_AUTENTICADO antes de mirar la firma', async () => {
      const r = await e
        .api()
        .post(RUTA)
        .set('Content-Type', 'application/json')
        .set(firmaAna())
        .send(CUERPO)
        .expect(401);
      expect(r.body.codigo).toBe('NO_AUTENTICADO');
    });

    it('A-08: cuerpo alterado en tránsito', async () => {
      const r = await enviar(
        tokenAna,
        firmaAna(),
        JSON.stringify({ monto: 99999 }),
      ).expect(401);
      expect(r.body.codigo).toBe('FIRMA_DISPOSITIVO_INVALIDA');
    });

    it('A-08: ruta o query alterada', async () => {
      const r = await enviar(
        tokenAna,
        firmaAna(),
        CUERPO,
        '/api/v1/prueba-firma/eco?x=2',
      ).expect(401);
      expect(r.body.codigo).toBe('FIRMA_DISPOSITIVO_INVALIDA');
    });

    it('A-04: firma hecha con la llave de otro teléfono', async () => {
      const r = await enviar(
        tokenAna,
        firmar(par(), dispositivoAna, { ruta: RUTA, cuerpo: CUERPO }),
      ).expect(401);
      expect(r.body.codigo).toBe('FIRMA_DISPOSITIVO_INVALIDA');
    });

    it('A-04: usar el dispositivo de Ana desde la sesión de Beto no sirve', async () => {
      const r = await enviar(tokenBeto, firmaAna()).expect(401);
      expect(r.body.codigo).toBe('FIRMA_DISPOSITIVO_INVALIDA');
    });

    it('A-05: reenviar la misma petición (mismo nonce) se rechaza', async () => {
      const cabeceras = firmaAna();
      await enviar(tokenAna, cabeceras).expect(200);
      const r = await enviar(tokenAna, cabeceras).expect(401);
      expect(r.body.codigo).toBe('PETICION_EXPIRADA');
    });

    it('A-05: petición firmada hace más de 30 s se rechaza', async () => {
      const r = await enviar(
        tokenAna,
        firmaAna({ marca: Date.now() - 31_000 }),
      ).expect(401);
      expect(r.body.codigo).toBe('PETICION_EXPIRADA');
    });
  });
});
