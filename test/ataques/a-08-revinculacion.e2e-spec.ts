import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasIdentidad } from '../identidad/ayudas-identidad.js';

const par = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pemPublico = (k: ReturnType<typeof par>) =>
  k.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const INTEGRO = 'simulado:integro';

/**
 * A-08 (llamar a la API sin la app): quien tiene la contraseña arma las peticiones a mano. Sin una
 * prueba de vida hecha con el desafío que pidió, ni la integridad del teléfono, no reemplaza al dueño.
 */
describe('A-08 · revincular armando las peticiones sin la app (e2e)', () => {
  let e: Entorno;
  const a = ayudasIdentidad(() => e);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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

  const desafio = async (token: string) =>
    (
      await e
        .api()
        .post('/api/v1/dispositivos/revinculacion')
        .set(auth(token))
        .expect(201)
    ).body as { desafio: string; sesionLivenessId: string };

  const revincular = (token: string, cuerpo: object) =>
    e
      .api()
      .post('/api/v1/dispositivos/revincular')
      .set(auth(token))
      .send({
        tokenIntegridad: INTEGRO,
        llavePublicaPem: pemPublico(par()),
        modelo: 'Script',
        ...cuerpo,
      });

  /** Dueño con identidad verificada (rostro `carlos`) y su teléfono vinculado. */
  const duenoVinculado = async () => {
    const p = await a.persona();
    (await a.intento(p, { rostro: 'carlos' })).expect(200);
    const { desafio: d } = (
      await e
        .api()
        .post('/api/v1/dispositivos/desafio-atestacion')
        .set(auth(p.token))
        .expect(201)
    ).body;
    const { id } = (
      await e
        .api()
        .post('/api/v1/dispositivos/vincular')
        .set(auth(p.token))
        .send({
          desafio: d,
          tokenIntegridad: INTEGRO,
          llavePublicaPem: pemPublico(par()),
          modelo: 'Pixel 7',
        })
        .expect(200)
    ).body;
    return { p, dispositivoId: id as string };
  };

  const sigueActivo = async (usuarioId: string, dispositivoId: string) => {
    const { rows } = await e.bd.query(
      `SELECT id FROM dispositivos WHERE usuario_id = $1 AND activo`,
      [usuarioId],
    );
    expect(rows.map((r) => r.id)).toEqual([dispositivoId]);
  };

  it('una prueba de vida de otro desafío (repetida o inventada) no vale: 422 PRUEBA_VIDA_FALLIDA y cuenta como intento', async () => {
    const { p, dispositivoId } = await duenoVinculado();

    const anterior = await desafio(p.token);
    const actual = await desafio(p.token);
    for (const sesionLivenessId of [
      `${anterior.sesionLivenessId}~carlos`,
      `sim-${randomUUID()}~carlos`,
    ]) {
      const r = await revincular(p.token, {
        desafio: (await desafio(p.token)).desafio,
        sesionLivenessId,
      }).expect(422);
      expect(r.body.codigo).toBe('PRUEBA_VIDA_FALLIDA');
    }
    expect((await a.fila(p.id)).intentos_fallidos).toBe(2);

    // La sesión emitida con su desafío sí sirve: el control no rompe el camino legítimo.
    await revincular(p.token, {
      desafio: actual.desafio,
      sesionLivenessId: `${actual.sesionLivenessId}~carlos`,
    }).expect(201);
    expect((await a.fila(p.id)).intentos_fallidos).toBe(0);
    const { rows } = await e.bd.query(
      `SELECT id FROM dispositivos WHERE usuario_id = $1 AND activo`,
      [p.id],
    );
    expect(rows.map((r) => r.id)).not.toContain(dispositivoId);
  });

  it('sin prueba de vida ni token de integridad se rechaza y el teléfono del dueño sigue', async () => {
    const { p, dispositivoId } = await duenoVinculado();

    const sinVida = await revincular(p.token, {
      desafio: (await desafio(p.token)).desafio,
    }).expect(422);
    expect(sinVida.body.codigo).toBe('PRUEBA_VIDA_FALLIDA');

    const d = await desafio(p.token);
    await revincular(p.token, {
      desafio: d.desafio,
      sesionLivenessId: `${d.sesionLivenessId}~carlos`,
      tokenIntegridad: undefined,
    }).expect(400);

    await sigueActivo(p.id, dispositivoId);
  });
});
