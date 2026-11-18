import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasPresencia, par, traza } from '../presencia/ayudas-presencia.js';

/** HU-23 CA-8 · A-08: posiciones sin firma válida o de quien no participa se rechazan y no cuentan. */
describe('A-08 · posiciones por la API sin la app (e2e)', () => {
  let e: Entorno;
  const h = ayudasPresencia(() => e);
  let org: string;

  beforeAll(async () => {
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno();
    org = (await h.r.v.organizacion('Atq A08 posiciones')).id;
  });
  beforeEach(() => h.r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  const puntos = async (viajeId: string) =>
    (
      await e.bd.query(
        `SELECT count(*)::int AS n FROM puntos_gps WHERE viaje_id = $1`,
        [viajeId],
      )
    ).rows[0].n as number;
  const invalida = (res: { body: { codigo: string } }) =>
    expect(res.body.codigo).toBe('FIRMA_TRAYECTO_INVALIDA');

  it('sin firma: 401 y nada guardado', async () => {
    const { s } = await h.enViaje(org);
    const p = s.pasajeros[0];
    const res = await e
      .api()
      .post(h.rutaPasajero(p.reservaId))
      .set(h.r.b.conToken(p.token))
      .send({ puntos: traza(1) })
      .expect(401);
    invalida(res);
    expect(await puntos(s.viajeId)).toBe(0);
  });

  it('firma de otro cuerpo (posiciones cambiadas después de firmar): 401', async () => {
    const { s, pasajeros } = await h.enViaje(org);
    const p = s.pasajeros[0];
    const ruta = h.rutaPasajero(p.reservaId);
    const firmado = { puntos: traza(1) };
    const res = await e
      .api()
      .post(ruta)
      .set(h.r.b.conToken(p.token))
      .set(h.firmarTrayecto(ruta, pasajeros[0], JSON.stringify(firmado)))
      .send({ puntos: traza(1, { desplazamientoM: 900 }) })
      .expect(401);
    invalida(res);
    expect(await puntos(s.viajeId)).toBe(0);
  });

  it('una llave inventada con un id real: 401', async () => {
    const { s, pasajeros } = await h.enViaje(org);
    const p = s.pasajeros[0];
    const falsa = { id: pasajeros[0].id, llave: par() };
    invalida(
      await h
        .posiciones(p.token, h.rutaPasajero(p.reservaId), falsa, traza(1))
        .expect(401),
    );
  });

  it('la llave del pasajero no envía la traza del conductor, ni la del conductor la del pasajero', async () => {
    const { s, conductor, pasajeros } = await h.enViaje(org);
    const p = s.pasajeros[0];
    // El pasajero firma con su llave pero en la ruta del viaje (haciéndose pasar por el conductor).
    invalida(
      await h
        .posiciones(p.token, h.rutaConductor(s.viajeId), pasajeros[0], traza(1))
        .expect(401),
    );
    invalida(
      await h
        .posiciones(
          s.conductor.token,
          h.rutaPasajero(p.reservaId),
          conductor,
          traza(1),
        )
        .expect(401),
    );
    expect(await puntos(s.viajeId)).toBe(0);
  });

  it('con la llave de su reserva no envía por la reserva de otro pasajero', async () => {
    const { s, pasajeros } = await h.enViaje(org, 2);
    const [p1, p2] = s.pasajeros;
    invalida(
      await h
        .posiciones(
          p1.token,
          h.rutaPasajero(p2.reservaId),
          pasajeros[0],
          traza(1),
        )
        .expect(401),
    );
    expect(await puntos(s.viajeId)).toBe(0);
  });

  it('una persona ajena con la llave robada de un pasajero: 401 (la llave es de la cuenta)', async () => {
    const { s, pasajeros } = await h.enViaje(org);
    const p = s.pasajeros[0];
    const ajeno = await h.r.pasajero(org);
    invalida(
      await h
        .posiciones(
          ajeno.token,
          h.rutaPasajero(p.reservaId),
          pasajeros[0],
          traza(1),
        )
        .expect(401),
    );
  });

  it('una llave de trayecto revocada (el pasajero volvió a escanear) ya no firma posiciones', async () => {
    const { s, conductor, pasajeros } = await h.enViaje(org);
    const p = s.pasajeros[0];
    const nueva = await h.abordarConLlave(s, p, conductor);
    invalida(
      await h
        .posiciones(
          p.token,
          h.rutaPasajero(p.reservaId),
          pasajeros[0],
          traza(1),
        )
        .expect(401),
    );
    await h
      .posiciones(p.token, h.rutaPasajero(p.reservaId), nueva, traza(1))
      .expect(202);
  });

  it('el estado de la reserva lo fija el servidor: un `estado` en el cuerpo no se acepta', async () => {
    const { s, pasajeros } = await h.enViaje(org);
    const p = s.pasajeros[0];
    const ruta = h.rutaPasajero(p.reservaId);
    const cuerpo = { puntos: traza(1), estado: 'verificada' };
    await e
      .api()
      .post(ruta)
      .set(h.r.b.conToken(p.token))
      .set(h.firmarTrayecto(ruta, pasajeros[0], JSON.stringify(cuerpo)))
      .send(cuerpo)
      .expect(400);
    expect(await h.estadoReserva(p.reservaId)).toBe('abordada');
  });
});
