import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasPresencia } from '../presencia/ayudas-presencia.js';

/** HU-22 CA-3, CA-4 · A-05: un código capturado no sirve dos veces ni pasados 30 s. */
describe('A-05 · repetir un código de abordaje (e2e)', () => {
  let e: Entorno;
  const h = ayudasPresencia(() => e);
  let org: string;

  beforeAll(async () => {
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno();
    org = (await h.r.v.organizacion('Atq A05')).id;
  });
  beforeEach(() => h.r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  it('CA-3: un código ya usado por otro pasajero se rechaza con «Ese código ya no sirve»', async () => {
    const s = await h.escenario(org, 2);
    const [p1, p2] = s.pasajeros;
    const nonce = await h.codigo(s, await h.llaveConductor(s));
    await h.abordar(p1, p1.reservaId, nonce).expect(200);

    const res = await h.abordar(p2, p2.reservaId, nonce).expect(409);
    expect(res.body).toMatchObject({
      codigo: 'CODIGO_INVALIDO',
      mensaje:
        'Ese código ya no sirve. Escanea el que muestra ahora el conductor.',
    });
    expect(await h.estadoReserva(p2.reservaId)).toBe('confirmada');
    expect(await h.pruebas(p2.reservaId)).toEqual([
      expect.objectContaining({
        resultado: 'rechazada',
        motivo: 'codigo_invalido',
        desafio_id: null,
      }),
    ]);
  });

  it('CA-3: un código gastado en un intento rechazado tampoco vuelve a servir', async () => {
    const s = await h.escenario(org);
    const p = s.pasajeros[0];
    const nonce = await h.codigo(s, await h.llaveConductor(s));
    await h
      .abordar(p, p.reservaId, nonce, { tokenIntegridad: 'simulado:root' })
      .expect(422);
    const res = await h.abordar(p, p.reservaId, nonce).expect(409);
    expect(res.body.codigo).toBe('CODIGO_INVALIDO');
  });

  it('CA-4: un código emitido hace más de 30 s se rechaza', async () => {
    const s = await h.escenario(org);
    const p = s.pasajeros[0];
    const nonce = await h.codigo(s, await h.llaveConductor(s));
    await e.bd.query(
      `UPDATE desafios_handshake SET vence_en = now() - interval '1 second', creado_en = now() - interval '31 seconds' WHERE nonce = $1`,
      [nonce],
    );
    const res = await h.abordar(p, p.reservaId, nonce).expect(409);
    expect(res.body.codigo).toBe('CODIGO_INVALIDO');
    expect(await h.estadoReserva(p.reservaId)).toBe('confirmada');
  });

  it('dos escaneos simultáneos del mismo código: solo uno gana', async () => {
    const s = await h.escenario(org, 2);
    const nonce = await h.codigo(s, await h.llaveConductor(s));
    const respuestas = await Promise.all(
      s.pasajeros.map((p) => h.abordar(p, p.reservaId, nonce)),
    );
    expect(respuestas.map((x) => x.status).sort()).toEqual([200, 409]);
    const estados = await Promise.all(
      s.pasajeros.map((p) => h.estadoReserva(p.reservaId)),
    );
    expect(estados.sort()).toEqual(['abordada', 'confirmada']);
  });

  it('un código inventado se rechaza igual', async () => {
    const s = await h.escenario(org);
    const p = s.pasajeros[0];
    const res = await h.abordar(p, p.reservaId, 'A'.repeat(43)).expect(409);
    expect(res.body.codigo).toBe('CODIGO_INVALIDO');
  });

  it('HU-23: el código de bajada tampoco sirve dos veces', async () => {
    const v = await h.enViaje(org, 2);
    const [p1, p2] = v.s.pasajeros;
    const nonce = await h.codigoBajada(v.s, v.conductor);
    await h.bajar(p1, p1.reservaId, nonce).expect(200);
    const res = await h.bajar(p2, p2.reservaId, nonce).expect(409);
    expect(res.body).toMatchObject({
      codigo: 'CODIGO_INVALIDO',
      mensaje:
        'Ese código ya no sirve. Escanea el código de bajada que muestra ahora el conductor.',
    });
    expect(await h.estadoReserva(p2.reservaId)).toBe('abordada');
  });

  it('HU-23: un código de abordaje no sirve para bajar, ni uno de bajada para abordar', async () => {
    const v = await h.enViaje(org);
    const p = v.s.pasajeros[0];
    const deAbordaje = await h.codigo(v.s, v.conductor);
    expect(
      (await h.bajar(p, p.reservaId, deAbordaje).expect(409)).body.codigo,
    ).toBe('CODIGO_INVALIDO');

    const s = await h.escenario(org);
    const otro = await h.enViaje(org);
    const deBajada = await h.codigoBajada(otro.s, otro.conductor);
    const q = s.pasajeros[0];
    expect(
      (await h.abordar(q, q.reservaId, deBajada).expect(409)).body.codigo,
    ).toBe('CODIGO_INVALIDO');
    expect(await h.estadoReserva(q.reservaId)).toBe('confirmada');
    expect(await h.estadoReserva(p.reservaId)).toBe('abordada');
  });
});
