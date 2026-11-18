import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import {
  ayudasPresencia,
  gradosLat,
  traza,
} from '../presencia/ayudas-presencia.js';

/** HU-23 CA-5, CA-6, CA-7 · A-07: trazas falsas enviadas por la API no verifican el viaje ni liberan el pago. */
describe('A-07 · trayecto falso (e2e)', () => {
  let e: Entorno;
  const h = ayudasPresencia(() => e);
  let org: string;

  beforeAll(async () => {
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno();
    org = (await h.r.v.organizacion('Atq A07 trayecto')).id;
  });
  beforeEach(() => h.r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  /** Envía las dos trazas y baja; devuelve la respuesta de la bajada. */
  const viajeCon = async (pasajero: object[], conductor: object[]) => {
    const v = await h.enViaje(org);
    const p = v.s.pasajeros[0];
    await h
      .posiciones(
        v.s.conductor.token,
        h.rutaConductor(v.s.viajeId),
        v.conductor,
        conductor,
      )
      .expect(202);
    await h
      .posiciones(
        p.token,
        h.rutaPasajero(p.reservaId),
        v.pasajeros[0],
        pasajero,
      )
      .expect(202);
    const { body } = await h
      .bajar(p, p.reservaId, await h.codigoBajada(v.s, v.conductor))
      .expect(200);
    return { body, v, p };
  };

  it('CA-5: un salto de más de 150 km/h → verificación fallida y el viaje no se verifica', async () => {
    const pasajero = traza(20, { desplazamientoM: 20 });
    // Un punto 2 km más allá, 15 s después del anterior: 480 km/h.
    pasajero[10] = { ...pasajero[10], lat: pasajero[10].lat + gradosLat(2000) };
    const { body, v, p } = await viajeCon(pasajero, traza(20));
    expect(body).toMatchObject({
      estado: 'verificacion_fallida',
      motivo: 'salto_imposible',
    });
    expect(await h.estadoViaje(v.s.viajeId)).toBe('en_curso');
    expect(await h.estadoReserva(p.reservaId)).toBe('verificacion_fallida');
  });

  it('CA-6: trayectorias que se separan (75 % a ≤ 100 m) → trayectos_separados', async () => {
    const conductor = traza(20);
    // Los últimos 5 puntos del pasajero, 300 m al oeste: se bajó antes y siguió por otro lado.
    const pasajero = traza(20, { desplazamientoM: 20 }).map((x, i) =>
      i >= 15 ? { ...x, lng: x.lng - 0.003 } : x,
    );
    const { body } = await viajeCon(pasajero, conductor);
    expect(body).toMatchObject({ motivo: 'trayectos_separados' });
  });

  it('CA-7: un solo punto simulado del conductor invalida la verificación', async () => {
    const conductor = traza(20);
    conductor[7] = { ...conductor[7], simulada: true };
    const { body } = await viajeCon(
      traza(20, { desplazamientoM: 20 }),
      conductor,
    );
    expect(body).toMatchObject({ motivo: 'ubicacion_simulada' });
  });

  it('el pasajero que envía la traza del conductor pero nunca estuvo cerca al bajar no baja (A-06 en la bajada)', async () => {
    const v = await h.enViaje(org);
    const p = v.s.pasajeros[0];
    const res = await h
      .bajar(p, p.reservaId, await h.codigoBajada(v.s, v.conductor), {
        posicion: {
          ...traza(1)[0],
          tomadaEn: Date.now(),
          lat: traza(1)[0].lat + gradosLat(5000),
        },
      })
      .expect(422);
    expect(res.body.codigo).toBe('DISTANCIA');
    expect(await h.estadoReserva(p.reservaId)).toBe('abordada');
  });
});
