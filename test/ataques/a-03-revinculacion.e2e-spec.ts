import { generateKeyPairSync } from 'node:crypto';
import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasIdentidad } from '../identidad/ayudas-identidad.js';

const par = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pemPublico = (k: ReturnType<typeof par>) =>
  k.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const INTEGRO = 'simulado:integro';

describe('A-03 · Revinculación desde emulador o app modificada (e2e)', () => {
  let e: Entorno;
  const a = ayudasIdentidad(() => e);

  beforeAll(async () => {
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno();
  });

  beforeEach(() => {
    a.preparar();
  });

  afterAll(async () => {
    await e.cerrar();
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const vincularPrimero = async (token: string) => {
    const des = (
      await e
        .api()
        .post('/api/v1/dispositivos/desafio-atestacion')
        .set(auth(token))
        .expect(201)
    ).body.desafio;

    const r = await e
      .api()
      .post('/api/v1/dispositivos/vincular')
      .set(auth(token))
      .send({
        desafio: des,
        tokenIntegridad: INTEGRO,
        llavePublicaPem: pemPublico(par()),
        modelo: 'Pixel 7',
      })
      .expect(200);

    return r.body.id as string;
  };

  const pedirDesafioRevinculacion = (token: string) =>
    e.api().post('/api/v1/dispositivos/revinculacion').set(auth(token));

  const revincular = (token: string, cuerpo: object) =>
    e
      .api()
      .post('/api/v1/dispositivos/revincular')
      .set(auth(token))
      .send(cuerpo);

  it.each([
    ['emulador', 'simulado:emulador'],
    ['root', 'simulado:root'],
    ['app modificada', 'simulado:app_alterada'],
  ])(
    'CA-6 / A-03: intento de revinculación desde %s es rechazado con 422 DISPOSITIVO_NO_INTEGRO',
    async (_, tokenInvalido) => {
      const p = await a.persona();
      const d1Id = await vincularPrimero(p.token);

      const des = (await pedirDesafioRevinculacion(p.token).expect(201)).body
        .desafio;

      const rAtaque = await revincular(p.token, {
        desafio: des,
        tokenIntegridad: tokenInvalido,
        llavePublicaPem: pemPublico(par()),
        modelo: 'Dispositivo No Genuino',
      }).expect(422);

      expect(rAtaque.body.codigo).toBe('DISPOSITIVO_NO_INTEGRO');

      // El dispositivo original sigue activo
      const disp = (
        await e.bd.query(`SELECT * FROM dispositivos WHERE id = $1`, [d1Id])
      ).rows[0];
      expect(disp.activo).toBe(true);
      expect(disp.desactivado_en).toBeNull();
    },
  );

  it('CA-11: si Play Integrity no responde (503), nada cambia y el dispositivo sigue activo', async () => {
    const p = await a.persona();
    const d1Id = await vincularPrimero(p.token);

    const des = (await pedirDesafioRevinculacion(p.token).expect(201)).body
      .desafio;

    const rCaida = await revincular(p.token, {
      desafio: des,
      tokenIntegridad: 'simulado:caido',
      llavePublicaPem: pemPublico(par()),
      modelo: 'Pixel 8',
    }).expect(503);

    expect(rCaida.body.codigo).toBe('SERVICIO_NO_DISPONIBLE');

    // El dispositivo original sigue activo
    const disp = (
      await e.bd.query(`SELECT * FROM dispositivos WHERE id = $1`, [d1Id])
    ).rows[0];
    expect(disp.activo).toBe(true);
  });
});
