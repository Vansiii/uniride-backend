import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import {
  ENCUENTRO,
  ayudasPresencia,
  posicion,
  traza,
} from './ayudas-presencia.js';

describe('HU-28 · distancia del conductor (e2e)', () => {
  let e: Entorno;
  const h = ayudasPresencia(() => e);
  let org: string;

  beforeAll(async () => {
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno();
    org = (await h.r.v.organizacion('Distancia Conductor')).id;
  });
  beforeEach(() => h.r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  const consultar = (token: string, reservaId: string) =>
    e()
      .api()
      .get(`/api/v1/reservas/${reservaId}/conductor`)
      .set(h.r.b.conToken(token));

  it('CA-4: reserva confirmada sin posiciones del conductor responde disponible: false', async () => {
    const s = await h.escenario(org);
    const p = s.pasajeros[0];

    const { body } = await consultar(p.token, p.reservaId).expect(200);
    expect(body).toEqual({
      disponible: false,
      distanciaM: null,
      enPuntoDeEncuentro: false,
      haceSegundos: null,
    });
  });

  it('CA-3: con desafío reciente responde distancia calculada y enPuntoDeEncuentro', async () => {
    const s = await h.escenario(org);
    const l = await h.llaveConductor(s);
    const p = s.pasajeros[0];

    // Conductor emite desafío a ~300 m del punto de encuentro
    // 0,0027° latitud ≈ 300 m
    const pos = posicion({ lat: ENCUENTRO.lat + 0.0027 });
    await h.desafio(s.conductor.token, s.viajeId, l, {
      tipo: 'abordaje',
      posicion: pos,
    }).expect(201);

    const { body } = await consultar(p.token, p.reservaId).expect(200);
    expect(body.disponible).toBe(true);
    expect(body.distanciaM).toBe(300);
    expect(body.enPuntoDeEncuentro).toBe(false);
    expect(body.haceSegundos).toBeLessThanOrEqual(5);
    // Privacidad: nunca devuelve coordenadas
    expect(body).not.toHaveProperty('lat');
    expect(body).not.toHaveProperty('lng');
  });

  it('CA-3: con posición a ≤ 50 m marca enPuntoDeEncuentro: true', async () => {
    const s = await h.escenario(org);
    const l = await h.llaveConductor(s);
    const p = s.pasajeros[0];

    // Conductor emite desafío a ~20 m del punto de encuentro
    const pos = posicion({ lat: ENCUENTRO.lat + 0.00018 });
    await h.desafio(s.conductor.token, s.viajeId, l, {
      tipo: 'abordaje',
      posicion: pos,
    }).expect(201);

    const { body } = await consultar(p.token, p.reservaId).expect(200);
    expect(body.disponible).toBe(true);
    expect(body.distanciaM).toBe(20);
    expect(body.enPuntoDeEncuentro).toBe(true);
  });

  it('toma el punto GPS si es más reciente que el desafío', async () => {
    const enViaje = await h.enViaje(org);
    const s = enViaje.s;

    // Conductor envía puntos GPS a ~100 m
    const puntos = traza(2, { hastaHaceS: 5, desplazamientoM: 100 });
    await h
      .posiciones(
        s.conductor.token,
        h.rutaConductor(s.viajeId),
        enViaje.conductor,
        puntos,
      )
      .expect(202);

    // Creamos una nueva reserva confirmada en ese viaje (simulando pasajero esperando)
    // Para probar que la posición tomada de punto_gps funciona:
    const pNuevo = await h.r.pasajero(org);
    const { reservaId } = (await h.r.reservar(pNuevo, s.viajeId).expect(201)).body;
    await h.r.procesar();

    const { body } = await consultar(pNuevo.token, reservaId).expect(200);
    expect(body.disponible).toBe(true);
    expect(body.haceSegundos).toBeLessThanOrEqual(10);
    expect(body.distanciaM).toBeGreaterThanOrEqual(90);
    expect(body.distanciaM).toBeLessThanOrEqual(120);
  });

  it('posición de hace más de 60 s responde disponible: false', async () => {
    const s = await h.escenario(org);
    const l = await h.llaveConductor(s);
    const p = s.pasajeros[0];

    await h.desafio(s.conductor.token, s.viajeId, l).expect(201);

    // Forzamos en la BD que el desafío tenga 65 s de antigüedad
    await e.bd.query(
      `UPDATE desafios_handshake SET conductor_tomada_en = now() - interval '65 seconds' WHERE viaje_id = $1`,
      [s.viajeId],
    );

    const { body } = await consultar(p.token, p.reservaId).expect(200);
    expect(body).toEqual({
      disponible: false,
      distanciaM: null,
      enPuntoDeEncuentro: false,
      haceSegundos: null,
    });
  });
});
