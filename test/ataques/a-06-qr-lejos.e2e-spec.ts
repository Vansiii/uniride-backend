import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import {
  A_60_M,
  ENCUENTRO,
  ayudasPresencia,
  posicion,
} from '../presencia/ayudas-presencia.js';

/** HU-22 CA-5 · A-06: la foto del QR enviada a alguien lejos no aborda. */
describe('A-06 · código enviado a alguien lejos (e2e)', () => {
  let e: Entorno;
  const h = ayudasPresencia(() => e);
  let org: string;

  beforeAll(async () => {
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno();
    org = (await h.r.v.organizacion('Atq A06')).id;
  });
  beforeEach(() => h.r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  it('a ~60 m: se rechaza con la distancia y el código queda consumido', async () => {
    const s = await h.escenario(org);
    const p = s.pasajeros[0];
    const nonce = await h.codigo(s, await h.llaveConductor(s));

    const lejos = posicion({ lat: ENCUENTRO.lat + A_60_M });
    const res = await h
      .abordar(p, p.reservaId, nonce, { posicion: lejos })
      .expect(422);
    expect(res.body.codigo).toBe('DISTANCIA');
    expect(res.body.distanciaM).toBeGreaterThanOrEqual(59);
    expect(res.body.distanciaM).toBeLessThanOrEqual(61);

    // Acercarse con el mismo código ya no sirve: hay que escanear el siguiente.
    await h.abordar(p, p.reservaId, nonce).expect(409);
    expect(await h.estadoReserva(p.reservaId)).toBe('confirmada');
    expect(await h.estadoViaje(s.viajeId)).toBe('reservado');
  });

  it('en el límite: a 50 m pasa, a 51 m no', async () => {
    const s = await h.escenario(org, 2);
    const [cerca, lejos] = s.pasajeros;
    const l = await h.llaveConductor(s);
    // 0,00045° de latitud ≈ 50,04 m: se usa 0,000449 (≈ 49,93 m) y 0,000459 (≈ 51,04 m).
    await h
      .abordar(cerca, cerca.reservaId, await h.codigo(s, l), {
        posicion: posicion({ lat: ENCUENTRO.lat + 0.000449 }),
      })
      .expect(200);
    await h
      .abordar(lejos, lejos.reservaId, await h.codigo(s, l), {
        posicion: posicion({ lat: ENCUENTRO.lat + 0.000459 }),
      })
      .expect(422);
  });

  it('HU-23: la bajada a ~60 m se rechaza, el código queda gastado y la reserva sigue abordada', async () => {
    const v = await h.enViaje(org);
    const p = v.s.pasajeros[0];
    const nonce = await h.codigoBajada(v.s, v.conductor);
    const res = await h
      .bajar(p, p.reservaId, nonce, {
        posicion: posicion({ lat: ENCUENTRO.lat + A_60_M }),
      })
      .expect(422);
    expect(res.body).toMatchObject({
      codigo: 'DISTANCIA',
      mensaje: 'Estás demasiado lejos del conductor para confirmar la bajada.',
    });
    await h.bajar(p, p.reservaId, nonce).expect(409);
    expect(await h.estadoReserva(p.reservaId)).toBe('abordada');
  });
});
