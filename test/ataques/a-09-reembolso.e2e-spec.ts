import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { enMs } from '../viajes/ayudas-viajes.js';
import { ayudasReservas } from '../reservas/ayudas-reservas.js';

describe('Ataque A-09 · Doble reembolso y cobro indebido (e2e)', () => {
  let e: Entorno;
  const r = ayudasReservas(() => e);
  let org: string;

  beforeAll(async () => {
    e = await prepararEntorno();
    org = (await r.v.organizacion('AtaqueA09Reembolso')).id;
  });

  beforeEach(() => r.preparar());

  afterAll(async () => {
    await e?.cerrar();
  });

  it('A-09 · peticiones de cancelación repetidas no duplican movimientos ni reembolsos', async () => {
    const c = await r.conductor(org);
    const viajeId = await r.publicar(c, {
      fechaHoraSalida: enMs(60 * 60 * 1000),
      precioPorAsiento: '10.00',
    });
    const p = await r.pasajero(org, '50.00');
    const res = await r.reservar(p, viajeId).expect(201);
    const reservaId = res.body.reservaId as string;
    await r.procesar();

    // Enviar dos cancelaciones idénticas
    await r.cancelarReserva(p, reservaId, 100).expect(200);
    await r.cancelarReserva(p, reservaId, 100).expect(200);

    // Solo un movimiento de reembolso creado
    const { rows: movs } = await e.bd.query(
      `SELECT count(*)::int AS total FROM movimientos_billetera WHERE reserva_id = $1 AND tipo = 'reembolso_reserva'`,
      [reservaId],
    );
    expect(movs[0].total).toBe(1);

    // Solo un trabajo onchain creado
    const { rows: trabajos } = await e.bd.query(
      `SELECT count(*)::int AS total FROM trabajos_onchain WHERE operacion = 'reembolsar_reserva'`,
    );
    expect(trabajos[0].total).toBe(1);
  });

  it('A-09 · dos ejecuciones del worker sobre el mismo trabajo son idempotentes', async () => {
    const c = await r.conductor(org);
    const viajeId = await r.publicar(c, {
      fechaHoraSalida: enMs(60 * 60 * 1000),
      precioPorAsiento: '10.00',
    });
    const p = await r.pasajero(org, '50.00');
    const res = await r.reservar(p, viajeId).expect(201);
    const reservaId = res.body.reservaId as string;
    await r.procesar();

    await r.cancelarReserva(p, reservaId, 100).expect(200);

    // Procesar worker 1
    await r.procesar();

    // Forzar reprocesamiento sin alterar estado
    await r.procesar();

    const { rows: movs } = await e.bd.query(
      `SELECT estado, hash_tx FROM movimientos_billetera WHERE reserva_id = $1 AND tipo = 'reembolso_reserva'`,
      [reservaId],
    );
    expect(movs[0].estado).toBe('confirmado');
    expect(movs[0].hash_tx).toBeTruthy();
  });
});
