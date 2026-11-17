import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { enMs } from '../viajes/ayudas-viajes.js';
import { ayudasReservas } from '../reservas/ayudas-reservas.js';
import { VencimientosService } from '../../src/reservas/vencimientos.service.js';

describe('Ataque A-10 · Conservación contable de URC en cancelaciones y reembolsos (e2e)', () => {
  let e: Entorno;
  const r = ayudasReservas(() => e);
  let org: string;

  beforeAll(async () => {
    e = await prepararEntorno();
    org = (await r.v.organizacion('AtaqueA10Cancelacion')).id;
  });

  beforeEach(() => r.preparar());

  afterAll(async () => {
    await e?.cerrar();
  });

  const saldoTotal = async (
    pasajero: { token: string },
    conductor: { token: string },
  ) => {
    const sp = parseFloat(
      (await r.b.saldo(pasajero.token)).body.saldoDisponible,
    );
    const sc = parseFloat(
      (await r.b.saldo(conductor.token)).body.saldoDisponible,
    );
    return sp + sc;
  };

  it('A-10 · cancelación al 100 % conserva el total exacto de URC', async () => {
    const c = await r.conductor(org);
    const viajeId = await r.publicar(c, {
      fechaHoraSalida: enMs(60 * 60 * 1000),
      precioPorAsiento: '10.00',
    });
    const p = await r.pasajero(org, '50.00');

    const totalInicial = await saldoTotal(p, c);
    expect(totalInicial).toBe(50.0);

    const res = await r.reservar(p, viajeId).expect(201);
    await r.procesar();

    // Cancelar al 100 %
    await r.cancelarReserva(p, res.body.reservaId, 100).expect(200);
    await r.procesar();

    const totalFinal = await saldoTotal(p, c);
    expect(totalFinal).toBe(totalInicial);
  });

  it('A-10 · cancelación al 50/50 conserva el total exacto de URC', async () => {
    const c = await r.conductor(org);
    const viajeId = await r.publicar(c, {
      fechaHoraSalida: enMs(15 * 60 * 1000),
      precioPorAsiento: '10.00',
    });
    const p = await r.pasajero(org, '50.00');

    const totalInicial = await saldoTotal(p, c);
    expect(totalInicial).toBe(50.0);

    const res = await r.reservar(p, viajeId).expect(201);
    await r.procesar();

    // Cancelar al 50 %
    await r.cancelarReserva(p, res.body.reservaId, 50).expect(200);
    await r.procesar();

    const totalFinal = await saldoTotal(p, c);
    expect(totalFinal).toBe(totalInicial);

    // 45 para el pasajero (50 - 10 + 5) y 5 para el conductor
    expect(parseFloat((await r.b.saldo(p.token)).body.saldoDisponible)).toBe(
      45.0,
    );
    expect(parseFloat((await r.b.saldo(c.token)).body.saldoDisponible)).toBe(
      5.0,
    );
  });

  it('A-10 · expiración conserva el total exacto de URC', async () => {
    const ahora = new Date();
    const salidaPasada = new Date(ahora.getTime() - 20 * 60 * 1000);

    const c = await r.conductor(org);
    const viajeId = await r.publicar(c, {
      precioPorAsiento: '12.00',
    });
    const p = await r.pasajero(org, '50.00');

    const totalInicial = await saldoTotal(p, c);
    await r.reservar(p, viajeId).expect(201);
    await r.procesar();
    // La API solo publica salidas futuras: la salida pasada se fija directo en la BD.
    await e.bd.query(`UPDATE viajes SET fecha_hora_salida = $1 WHERE id = $2`, [
      salidaPasada,
      viajeId,
    ]);

    const vencimientosService = e.app.get(VencimientosService);
    await vencimientosService.procesarVencimientos(ahora);
    await r.procesar();

    const totalFinal = await saldoTotal(p, c);
    expect(totalFinal).toBe(totalInicial);
  });
});
