import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/comun/prisma.service.js';
import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import {
  ayudasViajes,
  cuerpoViaje,
  type Conductor,
} from '../viajes/ayudas-viajes.js';

/** A-13: un viaje solo existe para su organización, en la API y en PostgreSQL con el rol de la API. */
describe('A-13 · aislamiento de viajes (e2e)', () => {
  let e: Entorno;
  const v = ayudasViajes(() => e);
  let a: string;
  let b: string;
  let conductorA: Conductor;
  let viajeA: string;
  let prisma: PrismaService;

  beforeAll(async () => {
    e = await prepararEntorno();
    prisma = e.app.get(PrismaService);
    a = (await v.organizacion('Viajes Atq A')).id;
    b = (await v.organizacion('Viajes Atq B')).id;
    conductorA = await v.conductor(a);
    viajeA = (await v.publicar(conductorA).expect(201)).body.id;
  });
  afterAll(async () => {
    await e.cerrar();
  });

  describe('por la API', () => {
    it('un miembro de otra organización no ve el detalle: 404, como si no existiera', async () => {
      const ajeno = await v.conductor(b);
      const r = await v.detalle(ajeno.token, viajeA).expect(404);
      expect(r.body.codigo).toBe('VIAJE_NO_ENCONTRADO');
    });

    it('un miembro de la misma organización sí lo ve', async () => {
      const vecino = await v.conductor(a);
      await v.detalle(vecino.token, viajeA).expect(200);
    });

    it('sin membresía aprobada no ve el detalle', async () => {
      const pendiente = await v.conductor(a, { membresia: 'pendiente' });
      await v.detalle(pendiente.token, viajeA).expect(403);
    });

    it('revocar la membresía surte efecto con la misma sesión', async () => {
      const c = await v.conductor(a);
      await e.bd.query(
        `UPDATE membresias SET estado = 'rechazada' WHERE usuario_id = $1`,
        [c.id],
      );
      await v.detalle(c.token, viajeA).expect(403);
      await v.publicar(c).expect(403);
      expect(await v.filas(c.id)).toEqual([]);
    });

    it('`mis-viajes` solo trae los propios: los de otro conductor, ni de su organización', async () => {
      const vecino = await v.conductor(a);
      const r = await v.misViajes(vecino.token).expect(200);
      expect(r.body).toEqual([]);
    });

    it('`mis-viajes` trae los suyos de todas sus organizaciones, aunque la activa sea otra', async () => {
      const enB = await v.cambiarOrganizacion(conductorA, b);
      const r = await v.misViajes(enB.token).expect(200);
      expect(r.body.map((x: { id: string }) => x.id)).toEqual([viajeA]);
      // Su propio viaje de A tampoco se abre desde la organización B.
      await v.detalle(enB.token, viajeA).expect(404);
    });

    it.each([
      ['organizacionId', () => b],
      ['conductorId', () => randomUUID()],
      ['vehiculoId', () => randomUUID()],
      ['estado', () => 'pagado'],
      ['cuposDisponibles', () => 6],
    ])(
      '`%s` en el cuerpo se rechaza: lo decide el servidor',
      async (campo, valor) => {
        const c = await v.conductor(a);
        await v.publicar(c, cuerpoViaje({ [campo]: valor() })).expect(400);
        expect(await v.filas(c.id)).toEqual([]);
      },
    );

    it('se publica en la organización activa del token', async () => {
      const c = await v.conductor(a);
      const enB = await v.cambiarOrganizacion(c, b);
      await v.publicar(enB).expect(201);
      const [fila] = await v.filas(c.id);
      expect(fila.organizacion_id).toBe(b);
    });
  });

  describe('en PostgreSQL con el rol de la API', () => {
    const datos = (organizacionId: string) => ({
      organizacionId,
      conductorId: conductorA.id,
      vehiculoId: '',
      origenNombre: 'x',
      origenLat: 0,
      origenLng: 0,
      destinoNombre: 'y',
      destinoLat: 0,
      destinoLng: 0,
      fechaHoraSalida: new Date(Date.now() + 3_600_000),
      cuposTotales: 1,
      cuposDisponibles: 1,
      precioPorAsiento: 1,
    });
    const vehiculoId = async () =>
      (
        await e.bd.query(`SELECT id FROM vehiculos WHERE propietario_id = $1`, [
          conductorA.id,
        ])
      ).rows[0].id as string;

    it('sin contexto de organización no se ve ninguna fila', async () => {
      expect(await prisma.viaje.findMany({ where: { id: viajeA } })).toEqual(
        [],
      );
    });

    it('con el contexto de otra organización no se ve la fila, ni pidiéndola por id', async () => {
      const filas = await prisma.enOrganizacion(b, (tx) =>
        tx.viaje.findMany({ where: { id: viajeA } }),
      );
      expect(filas).toEqual([]);
    });

    it('con su organización sí se ve', async () => {
      const filas = await prisma.enOrganizacion(a, (tx) =>
        tx.viaje.findMany({ where: { id: viajeA } }),
      );
      expect(filas).toHaveLength(1);
    });

    it('no se puede insertar en otra organización', async () => {
      const vehiculo = await vehiculoId();
      await expect(
        prisma.enOrganizacion(b, (tx) =>
          tx.viaje.create({ data: { ...datos(a), vehiculoId: vehiculo } }),
        ),
      ).rejects.toThrow();
    });

    it('el rol de la API no puede cambiar ni borrar un viaje: aún no hay transición que lo pida', async () => {
      await expect(
        prisma.enOrganizacion(a, (tx) =>
          tx.viaje.update({
            where: { id: viajeA },
            data: { estado: 'pagado' },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        prisma.enOrganizacion(a, (tx) =>
          tx.viaje.delete({ where: { id: viajeA } }),
        ),
      ).rejects.toThrow();
      const { rows } = await e.bd.query(
        `SELECT estado FROM viajes WHERE id = $1`,
        [viajeA],
      );
      expect(rows).toEqual([{ estado: 'publicado' }]);
    });

    it('la BD rechaza cupos y precios fuera de rango aunque la API falle', async () => {
      const vehiculo = await vehiculoId();
      for (const malo of [
        { cuposTotales: 7, cuposDisponibles: 7 },
        { cuposTotales: 2, cuposDisponibles: 3 },
        { cuposDisponibles: -1 },
        { precioPorAsiento: 0.5 },
        { origenLat: 91 },
      ])
        await expect(
          prisma.enOrganizacion(a, (tx) =>
            tx.viaje.create({
              data: { ...datos(a), vehiculoId: vehiculo, ...malo },
            }),
          ),
        ).rejects.toThrow();
    });
  });
});
