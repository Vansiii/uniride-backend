import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasPresencia, traza } from './ayudas-presencia.js';

/** HU-23: posiciones firmadas con la llave de trayecto (CA-1, CA-2, CA-9, CA-12). */
describe('HU-23 · posiciones del trayecto (e2e)', () => {
  let e: Entorno;
  const h = ayudasPresencia(() => e);
  let org: string;

  beforeAll(async () => {
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno();
    org = (await h.r.v.organizacion('Posiciones')).id;
  });
  beforeEach(() => h.r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  const puntosGuardados = async (viajeId: string, usuarioId: string) =>
    (
      await e.bd.query(
        `SELECT organizacion_id, tomada_en, simulada FROM puntos_gps WHERE viaje_id = $1 AND usuario_id = $2 ORDER BY tomada_en`,
        [viajeId, usuarioId],
      )
    ).rows;

  it('CA-1: conductor y pasajero envían su posición con la llave de trayecto, sin huella', async () => {
    const { s, conductor, pasajeros } = await h.enViaje(org);
    const p = s.pasajeros[0];

    const c = await h
      .posiciones(
        s.conductor.token,
        h.rutaConductor(s.viajeId),
        conductor,
        traza(1),
      )
      .expect(202);
    expect(c.body).toEqual({ aceptados: 1, ignorados: 0 });
    const r = await h
      .posiciones(p.token, h.rutaPasajero(p.reservaId), pasajeros[0], traza(1))
      .expect(202);
    expect(r.body).toEqual({ aceptados: 1, ignorados: 0 });

    const [guardado] = await puntosGuardados(s.viajeId, p.id);
    expect(guardado.organizacion_id).toBe(org);
    expect(await puntosGuardados(s.viajeId, s.conductor.id)).toHaveLength(1);
  });

  it('CA-2: sin señal, el lote de lo guardado llega con su hora original y se acepta', async () => {
    const { s, pasajeros } = await h.enViaje(org);
    const p = s.pasajeros[0];
    // 4 min sin señal: 16 puntos, el más viejo de hace 4 min.
    const lote = traza(16, { hastaHaceS: 10 });
    const { body } = await h
      .posiciones(p.token, h.rutaPasajero(p.reservaId), pasajeros[0], lote)
      .expect(202);
    expect(body).toEqual({ aceptados: 16, ignorados: 0 });
    const guardados = await puntosGuardados(s.viajeId, p.id);
    expect(guardados.map((g) => new Date(g.tomada_en).getTime())).toEqual(
      lote.map((x) => x.tomadaEn),
    );
  });

  it('CA-9: repetidos, del futuro y anteriores al abordaje se ignoran sin error', async () => {
    const { s, pasajeros } = await h.enViaje(org);
    const p = s.pasajeros[0];
    const ruta = h.rutaPasajero(p.reservaId);
    const [bueno] = traza(1);
    await h.posiciones(p.token, ruta, pasajeros[0], [bueno]).expect(202);

    const { body } = await h
      .posiciones(p.token, ruta, pasajeros[0], [
        bueno, // repetido
        { ...bueno, tomadaEn: Date.now() + 60_000 }, // un minuto en el futuro
        { ...bueno, tomadaEn: Date.now() - 10 * 60_000 }, // antes del abordaje (hace 5 min)
        { ...bueno, tomadaEn: bueno.tomadaEn + 1 },
      ])
      .expect(202);
    expect(body).toEqual({ aceptados: 1, ignorados: 3 });
    expect(await puntosGuardados(s.viajeId, p.id)).toHaveLength(2);
  });

  it('RN-6: un punto marcado como simulado se guarda, para que la evaluación lo invalide', async () => {
    const { s, pasajeros } = await h.enViaje(org);
    const p = s.pasajeros[0];
    await h
      .posiciones(
        p.token,
        h.rutaPasajero(p.reservaId),
        pasajeros[0],
        traza(1, { simulada: true }),
      )
      .expect(202);
    expect(await puntosGuardados(s.viajeId, p.id)).toEqual([
      expect.objectContaining({ simulada: true }),
    ]);
  });

  it('lotes de 1 a 60 puntos: vacío o de 61 → VALIDACION_FALLIDA', async () => {
    const { s, conductor } = await h.enViaje(org);
    const ruta = h.rutaConductor(s.viajeId);
    await h.posiciones(s.conductor.token, ruta, conductor, []).expect(400);
    await h
      .posiciones(s.conductor.token, ruta, conductor, traza(61, { kmh: 1 }))
      .expect(400);
    await h
      .posiciones(s.conductor.token, ruta, conductor, [
        { ...traza(1)[0], lat: 91 },
      ])
      .expect(400);
  });

  it('CA-12: tras la bajada se rechazan las del pasajero y, sin nadie a bordo, las del conductor', async () => {
    const { s, conductor, pasajeros } = await h.enViaje(org);
    const p = s.pasajeros[0];
    await h
      .bajar(p, p.reservaId, await h.codigoBajada(s, conductor))
      .expect(200);

    const pas = await h
      .posiciones(p.token, h.rutaPasajero(p.reservaId), pasajeros[0], traza(1))
      .expect(409);
    expect(pas.body).toMatchObject({
      codigo: 'RESERVA_NO_ABORDADA',
      mensaje:
        'Esta reserva ya no está en viaje: dejamos de compartir tu ubicación.',
    });
    const con = await h
      .posiciones(
        s.conductor.token,
        h.rutaConductor(s.viajeId),
        conductor,
        traza(1),
      )
      .expect(409);
    expect(con.body.codigo).toBe('VIAJE_NO_EN_CURSO');
  });

  it('antes del abordaje no hay trayecto: el conductor recibe VIAJE_NO_EN_CURSO', async () => {
    const s = await h.escenario(org);
    const l = await h.llaveConductor(s);
    const res = await h
      .posiciones(s.conductor.token, h.rutaConductor(s.viajeId), l, traza(1))
      .expect(409);
    expect(res.body.codigo).toBe('VIAJE_NO_EN_CURSO');
  });

  it('con dos pasajeros, la posición del conductor se guarda una sola vez para el viaje', async () => {
    const { s, conductor } = await h.enViaje(org, 2);
    await h
      .posiciones(
        s.conductor.token,
        h.rutaConductor(s.viajeId),
        conductor,
        traza(3),
      )
      .expect(202);
    expect(await puntosGuardados(s.viajeId, s.conductor.id)).toHaveLength(3);
  });
});
