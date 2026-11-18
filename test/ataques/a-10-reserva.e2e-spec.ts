import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasReservas, type Persona } from '../reservas/ayudas-reservas.js';
import { enMs, HORA_MS } from '../viajes/ayudas-viajes.js';

/** HU-19 CA-15 · A-10: reservar solo mueve saldo; los viajes, simulados o no, nunca lo crean. */
describe('A-10 · reservar no crea saldo (e2e)', () => {
  let e: Entorno;
  const r = ayudasReservas(() => e);
  let org: string;

  beforeAll(async () => {
    e = await prepararEntorno();
    org = (await r.v.organizacion('Reservas A10')).id;
  });
  beforeEach(() => r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  const centavos = (urc: string) => Math.round(Number(urc) * 100);
  /** Total de la persona (disponible + en garantía) y lo que tiene en garantía. */
  const totales = async (p: Persona) => {
    const { body } = await r.saldo(p).expect(200);
    return {
      total: centavos(body.saldoTotal),
      garantia: centavos(body.saldoBloqueadoEscrow),
    };
  };

  it('el total del pasajero, del conductor y de la garantía es el mismo antes, con el bloqueo pendiente y después', async () => {
    const c = await r.conductor(org);
    await r.fondear(c, '5.00');
    const viajeId = await r.publicar(c);
    const p = await r.pasajero(org, '50.00');

    const antes = [await totales(p), await totales(c)];
    expect(antes.map((t) => t.total)).toEqual([5000, 500]);

    await r.reservar(p, viajeId).expect(201);
    const pendiente = [await totales(p), await totales(c)];
    expect(pendiente.map((t) => t.total)).toEqual([5000, 500]);

    await r.procesar();
    const despues = [await totales(p), await totales(c)];
    // El pasajero conserva el total pero 10,50 pasaron a «En garantía»; el conductor no cobra hasta HU-24.
    expect(despues.map((t) => t.total)).toEqual([5000, 500]);
    expect(despues[0].garantia).toBe(1050);
    expect(despues[1].garantia).toBe(0);
    expect(despues[0].total + despues[1].total).toBe(
      antes[0].total + antes[1].total,
    );
  });

  it('el libro tampoco inventa nada: el bloqueo resta al pasajero y no suma a nadie', async () => {
    const c = await r.conductor(org);
    const viajeId = await r.publicar(c);
    const p = await r.pasajero(org, '50.00');
    const { reservaId } = (await r.reservar(p, viajeId).expect(201)).body;
    await r.procesar();

    const { rows } = await e.bd.query(
      `SELECT b.usuario_id,
              COALESCE(SUM(CASE m.tipo WHEN 'bloqueo_reserva' THEN -m.monto ELSE m.monto END)
                FILTER (WHERE m.estado = 'confirmado'), 0)::text AS contable
       FROM billeteras b LEFT JOIN movimientos_billetera m ON m.billetera_id = b.id
       WHERE b.usuario_id IN ($1, $2) GROUP BY b.usuario_id`,
      [p.id, c.id],
    );
    const contable = Object.fromEntries(
      rows.map((x) => [x.usuario_id, x.contable]),
    );
    expect(Number(contable[p.id])).toBe(39.5);
    expect(Number(contable[c.id])).toBe(0);
    const movs = await r.movimientosDeReserva(reservaId);
    expect(movs.map((m) => m.tipo)).toEqual(['bloqueo_reserva']);
  });

  it('colusión: reservar y reservar viajes sin parar no le da un URC al conductor', async () => {
    const c = await r.conductor(org);
    const viajes = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        // Más de 2 h entre una salida y otra: el conductor no se solapa (HU-17 CA-5).
        r.publicar(c, { fechaHoraSalida: enMs(n * 4 * HORA_MS) }),
      ),
    );
    const p = await r.pasajero(org, '50.00');
    for (const viajeId of viajes) await r.reservar(p, viajeId).expect(201);
    expect(await r.procesar()).toBe(4);

    expect((await totales(c)).total).toBe(0);
    const del = await totales(p);
    expect(del.total).toBe(5000);
    expect(del.garantia).toBe(4200);
  });

  it('una reserva que no se completa deja el total intacto: nada se descuenta', async () => {
    const c = await r.conductor(org);
    const viajeId = await r.publicar(c);
    const p = await r.pasajero(org, '0.00');
    await r.b.asiento(p.billetera, { monto: '50.00' });
    await r.reservar(p, viajeId).expect(201);
    await r.procesar();
    expect((await r.filasReserva(viajeId))[0].estado).toBe('fallida');
    // Sin bloqueo en la cadena ni en garantía: el libro conserva sus 50 URC y la cadena sigue como estaba.
    expect((await totales(p)).garantia).toBe(0);
    expect(r.cadena().saldos.get(p.direccion) ?? 0n).toBe(0n);
    const { rows } = await e.bd.query(
      `SELECT COALESCE(SUM(monto) FILTER (WHERE estado = 'confirmado' AND tipo = 'recarga'), 0)::float AS recargas,
              COALESCE(SUM(monto) FILTER (WHERE estado = 'confirmado' AND tipo = 'bloqueo_reserva'), 0)::float AS bloqueos
       FROM movimientos_billetera WHERE billetera_id = $1`,
      [p.billetera],
    );
    expect(rows[0]).toEqual({ recargas: 50, bloqueos: 0 });
    expect((await totales(c)).total).toBe(0);
  });
});
