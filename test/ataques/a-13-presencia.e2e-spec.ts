import { PrismaService } from '../../src/comun/prisma.service.js';
import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasPresencia, traza } from '../presencia/ayudas-presencia.js';

/** HU-22 CA-9, CA-10 · A-13: sin reserva propia y confirmada no se aborda; lo de otra organización no existe. */
describe('A-13 · presencia entre organizaciones y reservas ajenas (e2e)', () => {
  let e: Entorno;
  const h = ayudasPresencia(() => e);
  let a: string;
  let b: string;

  beforeAll(async () => {
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno();
    a = (await h.r.v.organizacion('Presencia Atq A')).id;
    b = (await h.r.v.organizacion('Presencia Atq B')).id;
  });
  beforeEach(() => h.r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  it('CA-10: un código de un viaje de otra organización se rechaza igual que uno inválido, sin gastarlo', async () => {
    const enB = await h.escenario(b);
    const nonceB = await h.codigo(enB, await h.llaveConductor(enB));
    const enA = await h.escenario(a);
    const p = enA.pasajeros[0];

    const ajeno = await h.abordar(p, p.reservaId, nonceB).expect(409);
    const inventado = await h
      .abordar(p, p.reservaId, 'B'.repeat(43))
      .expect(409);
    expect(ajeno.body).toEqual(inventado.body);
    // RLS: el código de B ni se vio ni se gastó; su pasajero aborda con él.
    const pb = enB.pasajeros[0];
    await h.abordar(pb, pb.reservaId, nonceB).expect(200);
  });

  it('CA-9: con la reserva de otra persona: «No tienes una reserva en este viaje»', async () => {
    const s = await h.escenario(a, 2);
    const [p1, p2] = s.pasajeros;
    const nonce = await h.codigo(s, await h.llaveConductor(s));
    const res = await h.abordar(p2, p1.reservaId, nonce).expect(409);
    expect(res.body).toMatchObject({
      codigo: 'SIN_RESERVA',
      mensaje: 'No tienes una reserva en este viaje.',
    });
    expect(await h.estadoReserva(p1.reservaId)).toBe('confirmada');
  });

  it('CA-9: con su reserva de otro viaje y el código de este: SIN_RESERVA', async () => {
    const s = await h.escenario(a);
    const otro = await h.escenario(a);
    const p = otro.pasajeros[0];
    const nonce = await h.codigo(s, await h.llaveConductor(s));
    const res = await h.abordar(p, p.reservaId, nonce).expect(409);
    expect(res.body.codigo).toBe('SIN_RESERVA');
  });

  it('CA-9: con una reserva todavía pendiente: SIN_RESERVA', async () => {
    const s = await h.escenario(a);
    const p = await h.r.pasajero(a);
    const { reservaId } = (await h.r.reservar(p, s.viajeId).expect(201)).body;
    const nonce = await h.codigo(s, await h.llaveConductor(s));
    const res = await h.abordar(p, reservaId, nonce).expect(409);
    expect(res.body.codigo).toBe('SIN_RESERVA');
    expect(await h.estadoReserva(reservaId)).toBe('pendiente');
  });

  it('el conductor de otra organización no registra llave ni pide códigos de este viaje', async () => {
    const s = await h.escenario(a);
    const conductorB = await h.r.conductor(b);
    await h.registrarLlave(conductorB, s.viajeId).peticion.expect(404);
  });

  it('con el rol de la API, en el contexto de A no se ven llaves, desafíos ni pruebas de B', async () => {
    const enB = await h.escenario(b);
    const pb = enB.pasajeros[0];
    await h
      .abordar(
        pb,
        pb.reservaId,
        await h.codigo(enB, await h.llaveConductor(enB)),
      )
      .expect(200);

    const prisma = e.app.get(PrismaService);
    const cuenta = (org: string) =>
      prisma.enOrganizacion(org, async (tx) => ({
        llaves: await tx.llaveTrayecto.count({
          where: { viajeId: enB.viajeId },
        }),
        desafios: await tx.desafioHandshake.count({
          where: { viajeId: enB.viajeId },
        }),
        pruebas: await tx.pruebaPresencia.count({
          where: { reservaId: pb.reservaId },
        }),
      }));
    expect(await cuenta(a)).toEqual({ llaves: 0, desafios: 0, pruebas: 0 });
    expect(await cuenta(b)).toEqual({ llaves: 2, desafios: 1, pruebas: 1 });
  });

  it('HU-23 CA-14: bajada sobre una reserva de otra organización = reserva inexistente', async () => {
    const enB = await h.enViaje(b);
    const pb = enB.s.pasajeros[0];
    const enA = await h.enViaje(a);
    const pa = enA.s.pasajeros[0];
    const nonceA = await h.codigoBajada(enA.s, enA.conductor);
    const ajena = await h.bajar(pa, pb.reservaId, nonceA).expect(409);
    const inexistente = await h
      .bajar(
        pa,
        '00000000-0000-4000-8000-000000000000',
        await h.codigoBajada(enA.s, enA.conductor),
      )
      .expect(409);
    expect(ajena.body).toEqual(inexistente.body);
    expect(ajena.body.codigo).toBe('SIN_RESERVA');
    expect(await h.estadoReserva(pb.reservaId)).toBe('abordada');
  });

  it('HU-23 CA-14: posiciones con la llave de A sobre el viaje o la reserva de B se rechazan sin guardar nada', async () => {
    const enB = await h.enViaje(b);
    const pb = enB.s.pasajeros[0];
    const enA = await h.enViaje(a);
    const pa = enA.s.pasajeros[0];
    await h
      .posiciones(
        pa.token,
        h.rutaPasajero(pb.reservaId),
        enA.pasajeros[0],
        traza(1),
      )
      .expect(401);
    await h
      .posiciones(
        enA.s.conductor.token,
        h.rutaConductor(enB.s.viajeId),
        enA.conductor,
        traza(1),
      )
      .expect(401);
    // La llave de B usada con el token de A (otra organización): tampoco.
    await h
      .posiciones(
        pa.token,
        h.rutaPasajero(pb.reservaId),
        enB.pasajeros[0],
        traza(1),
      )
      .expect(401);
    const { rows } = await e.bd.query(
      `SELECT 1 FROM puntos_gps WHERE viaje_id = $1`,
      [enB.s.viajeId],
    );
    expect(rows).toEqual([]);
  });

  it('HU-23: con el rol de la API, en el contexto de A no se ven los puntos de B', async () => {
    const enB = await h.enViaje(b);
    const pb = enB.s.pasajeros[0];
    await h
      .posiciones(
        pb.token,
        h.rutaPasajero(pb.reservaId),
        enB.pasajeros[0],
        traza(2),
      )
      .expect(202);
    const prisma = e.app.get(PrismaService);
    const cuenta = (org: string) =>
      prisma.enOrganizacion(org, (tx) =>
        tx.puntoGps.count({ where: { viajeId: enB.s.viajeId } }),
      );
    expect(await cuenta(a)).toBe(0);
    expect(await cuenta(b)).toBe(2);
  });
});
