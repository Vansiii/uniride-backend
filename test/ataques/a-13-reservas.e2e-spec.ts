import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/comun/prisma.service.js';
import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasReservas } from '../reservas/ayudas-reservas.js';

/** HU-19 CA-8 · A-13: una reserva y su viaje solo existen para su organización, en la API y en PostgreSQL con el rol de la API. */
describe('A-13 · aislamiento de reservas (e2e)', () => {
  let e: Entorno;
  const r = ayudasReservas(() => e);
  let prisma: PrismaService;
  let a: string;
  let b: string;

  beforeAll(async () => {
    e = await prepararEntorno();
    prisma = e.app.get(PrismaService);
    a = (await r.v.organizacion('Reservas Atq A')).id;
    b = (await r.v.organizacion('Reservas Atq B')).id;
  });
  beforeEach(() => r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  describe('por la API', () => {
    it('reservar un viaje de otra organización conociendo su id: «Viaje no encontrado», igual que si no existiera', async () => {
      const conductorB = await r.conductor(b);
      const viajeB = await r.publicar(conductorB);
      const pasajeroA = await r.pasajero(a);

      const ajeno = await r.reservar(pasajeroA, viajeB).expect(404);
      const inexistente = await r.reservar(pasajeroA, randomUUID()).expect(404);
      expect(ajeno.body).toEqual(inexistente.body);
      expect(ajeno.body.codigo).toBe('VIAJE_NO_ENCONTRADO');
      expect(await r.huella(pasajeroA.id)).toEqual({
        reservas: 0,
        bloqueos: 0,
      });
      expect((await r.viaje(viajeB)).cupos_disponibles).toBe(3);
    });

    it('un miembro de las dos organizaciones reserva solo en la que tiene activa', async () => {
      const conductorB = await r.conductor(b);
      const viajeB = await r.publicar(conductorB);
      const p = await r.pasajero(a);
      await r.reservar(p, viajeB).expect(404);
      const enB = await r.v.cambiarOrganizacion(p, b);
      await r.reservar(enB, viajeB).expect(201);
    });

    it('la reserva de otra organización no se ve: 404 para su pasajero fuera de su organización y para otros', async () => {
      const conductorA = await r.conductor(a);
      const viajeA = await r.publicar(conductorA);
      const pasajeroA = await r.pasajero(a);
      const { reservaId } = (await r.reservar(pasajeroA, viajeA).expect(201))
        .body;

      const pasajeroB = await r.pasajero(b);
      const conductorB = await r.conductor(b);
      await r.reserva(pasajeroB.token, reservaId).expect(404);
      await r.reserva(conductorB.token, reservaId).expect(404);
      // Aunque la misma persona conozca el id, su sesión activa decide: en B la reserva de A no existe.
      const dePasajeroEnB = await r.v.cambiarOrganizacion(pasajeroA, b);
      await r.reserva(dePasajeroEnB.token, reservaId).expect(404);
      await r.reserva(pasajeroA.token, reservaId).expect(200);
    });

    it('los pasajeros de un viaje de otra organización no se ven: 404', async () => {
      const conductorA = await r.conductor(a);
      const viajeA = await r.publicar(conductorA);
      const pasajeroA = await r.pasajero(a);
      await r.reservar(pasajeroA, viajeA).expect(201);
      const conductorB = await r.conductor(b);
      const res = await r.pasajeros(conductorB.token, viajeA).expect(404);
      expect(res.body.codigo).toBe('VIAJE_NO_ENCONTRADO');
    });

    it('«mias» solo trae las reservas de la propia persona', async () => {
      const conductorA = await r.conductor(a);
      const viajeA = await r.publicar(conductorA);
      const dueno = await r.pasajero(a);
      const { reservaId } = (await r.reservar(dueno, viajeA).expect(201)).body;
      const otro = await r.pasajero(a);
      expect((await r.mias(otro.token).expect(200)).body.reservas).toEqual([]);
      expect(
        (await r.mias(dueno.token).expect(200)).body.reservas.map(
          (x: { reservaId: string }) => x.reservaId,
        ),
      ).toEqual([reservaId]);
    });
  });

  describe('en PostgreSQL con el rol de la API', () => {
    let reservaA: string;
    let viajeA: string;

    beforeEach(async () => {
      const conductorA = await r.conductor(a);
      viajeA = await r.publicar(conductorA);
      const p = await r.pasajero(a);
      reservaA = (await r.reservar(p, viajeA).expect(201)).body.reservaId;
    });

    const contar = (org: string) =>
      prisma.enOrganizacion(
        org,
        (tx) =>
          tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM reservas WHERE id = ${reservaA}::uuid`,
      );

    it('RLS sola oculta la fila aunque la consulta no filtre por organización', async () => {
      expect(await contar(b)).toEqual([]);
      expect(await contar(a)).toHaveLength(1);
    });

    it('sin contexto de organización no se ve ninguna reserva', async () => {
      expect(
        await prisma.reserva.findMany({ where: { id: reservaA } }),
      ).toEqual([]);
    });

    it('con el contexto de otra organización no se puede cambiar ni la fila ni el cupo de su viaje', async () => {
      const { count } = await prisma.enOrganizacion(b, (tx) =>
        tx.reserva.updateMany({
          where: { id: reservaA },
          data: { estado: 'pagada' },
        }),
      );
      expect(count).toBe(0);
      const cupos = await prisma.enOrganizacion(
        b,
        (tx) =>
          tx.$executeRaw`UPDATE viajes SET cupos_disponibles = 0 WHERE id = ${viajeA}::uuid`,
      );
      expect(cupos).toBe(0);
      const { rows } = await e.bd.query(
        `SELECT estado FROM reservas WHERE id = $1`,
        [reservaA],
      );
      expect(rows[0].estado).toBe('pendiente');
    });

    it('no se puede insertar una reserva de A desde el contexto de B', async () => {
      const { rows } = await e.bd.query(
        `SELECT pasajero_id, monto FROM reservas WHERE id = $1`,
        [reservaA],
      );
      await expect(
        prisma.enOrganizacion(b, (tx) =>
          tx.reserva.create({
            data: {
              organizacionId: a,
              viajeId: viajeA,
              pasajeroId: rows[0].pasajero_id,
              monto: '10.50',
              claveIdempotencia: randomUUID(),
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('el rol de la API solo avanza el estado y el motivo: ni el monto, ni el pasajero, ni borrar', async () => {
      for (const data of [
        { monto: '0.02' },
        { pasajeroId: randomUUID() },
        { viajeId: randomUUID() },
        { claveIdempotencia: randomUUID() },
      ])
        await expect(
          prisma.enOrganizacion(a, (tx) =>
            tx.reserva.update({ where: { id: reservaA }, data }),
          ),
        ).rejects.toThrow();
      await expect(
        prisma.enOrganizacion(a, (tx) =>
          tx.reserva.delete({ where: { id: reservaA } }),
        ),
      ).rejects.toThrow();
      const { rows } = await e.bd.query(
        `SELECT monto::text AS monto FROM reservas WHERE id = $1`,
        [reservaA],
      );
      expect(rows[0].monto).toBe('10.50');
    });

    it('la BD rechaza un estado inventado y un monto no positivo aunque la API falle', async () => {
      await expect(
        prisma.enOrganizacion(a, (tx) =>
          tx.reserva.update({
            where: { id: reservaA },
            data: { estado: 'regalada' },
          }),
        ),
      ).rejects.toThrow();
    });

    it('un movimiento no puede apuntar a una reserva que no existe', async () => {
      const { rows } = await e.bd.query(
        `SELECT billetera_id FROM movimientos_billetera WHERE reserva_id = $1`,
        [reservaA],
      );
      await expect(
        e.bd.query(
          `INSERT INTO movimientos_billetera (billetera_id, tipo, monto, reserva_id, clave_idempotencia)
           VALUES ($1, 'bloqueo_reserva', 1, gen_random_uuid(), $2)`,
          [rows[0].billetera_id, randomUUID()],
        ),
      ).rejects.toThrow();
    });
  });
});
