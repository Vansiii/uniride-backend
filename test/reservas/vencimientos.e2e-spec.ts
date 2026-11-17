import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { VencimientosService } from '../../src/reservas/vencimientos.service.js';
import { ayudasReservas } from './ayudas-reservas.js';

describe('HU-20 · Tic de vencimientos y expiración (e2e)', () => {
  let e: Entorno;
  const r = ayudasReservas(() => e);
  let org: string;
  let vencimientosService: VencimientosService;

  beforeAll(async () => {
    e = await prepararEntorno();
    org = (await r.v.organizacion('VencimientosE2E')).id;
    vencimientosService = e.app.get(VencimientosService);
  });

  beforeEach(() => r.preparar());

  afterAll(async () => {
    await e?.cerrar();
  });

  it('CA-6 · expira reservas confirmadas pasados 15 min de salida y el viaje pasa a expirado', async () => {
    const ahora = new Date('2026-11-15T12:00:00.000Z');
    const salidaPasada = new Date(ahora.getTime() - 20 * 60 * 1000); // 20 min atrás > 15 min

    const c = await r.conductor(org);
    const viajeId = await r.publicar(c, {
      fechaHoraSalida: salidaPasada.toISOString(),
      precioPorAsiento: '10.00',
    });

    const p = await r.pasajero(org, '50.00');
    const res = await r.reservar(p, viajeId).expect(201);
    const reservaId = res.body.reservaId as string;

    // Confirmar en cadena simulada
    await r.procesar();

    // Ejecutar tic de vencimientos simulando 'ahora'
    const resumen = await vencimientosService.procesarVencimientos(ahora);

    expect(resumen.reservasExpiradas).toBe(1);
    expect(resumen.viajesExpirados).toBe(1);

    // Estado en base de datos
    expect((await r.viaje(viajeId)).estado).toBe('expirado');
    const { rows: filas } = await e.bd.query(
      `SELECT estado, motivo FROM reservas WHERE id = $1`,
      [reservaId],
    );
    expect(filas[0]).toMatchObject({
      estado: 'expirada',
      motivo: 'expirada_sin_abordaje',
    });

    // Procesar worker on-chain para verificar reembolso
    await r.procesar();
    const movs = await r.movimientosDeReserva(reservaId);
    const movReembolso = movs.find((m) => m.tipo === 'reembolso_reserva');
    expect(movReembolso).toMatchObject({
      estado: 'confirmado',
      monto: '10.00',
    });
  });

  it('CA-7 · viaje publicado sin reservas pasa a expirado sin mover dinero', async () => {
    const ahora = new Date('2026-11-15T12:00:00.000Z');
    const salidaPasada = new Date(ahora.getTime() - 25 * 60 * 1000);

    const c = await r.conductor(org);
    const viajeId = await r.publicar(c, {
      fechaHoraSalida: salidaPasada.toISOString(),
      precioPorAsiento: '15.00',
    });

    const resumen = await vencimientosService.procesarVencimientos(ahora);
    expect(resumen.viajesExpirados).toBe(1);
    expect((await r.viaje(viajeId)).estado).toBe('expirado');
  });

  it('CA-8 · viaje con pasajero abordado no expira el viaje, solo la reserva sin abordar', async () => {
    const ahora = new Date('2026-11-15T12:00:00.000Z');
    const salidaPasada = new Date(ahora.getTime() - 20 * 60 * 1000);

    const c = await r.conductor(org);
    const viajeId = await r.publicar(c, {
      fechaHoraSalida: salidaPasada.toISOString(),
      cuposTotales: 3,
    });

    const p1 = await r.pasajero(org, '50.00');
    const p2 = await r.pasajero(org, '50.00');

    const res1 = await r.reservar(p1, viajeId).expect(201);
    const res2 = await r.reservar(p2, viajeId).expect(201);

    await r.procesar();

    // Marcar p1 como abordada y viaje en curso
    await e.bd.query(`UPDATE reservas SET estado = 'abordada' WHERE id = $1`, [
      res1.body.reservaId,
    ]);
    await e.bd.query(`UPDATE viajes SET estado = 'en_curso' WHERE id = $1`, [
      viajeId,
    ]);

    const resumen = await vencimientosService.procesarVencimientos(ahora);

    // Solo expira res2, el viaje sigue en_curso
    expect(resumen.reservasExpiradas).toBe(1);
    expect(resumen.viajesExpirados).toBe(0);

    expect((await r.viaje(viajeId)).estado).toBe('en_curso');

    const { rows: r2Fila } = await e.bd.query(
      `SELECT estado FROM reservas WHERE id = $1`,
      [res2.body.reservaId],
    );
    expect(r2Fila[0].estado).toBe('expirada');
  });

  it('CA-9 · reserva en verificacion fallida devuelve el 100 % tras 24 h', async () => {
    const ahora = new Date('2026-11-15T12:00:00.000Z');
    const salida = new Date(ahora.getTime() - 30 * 60 * 60 * 1000); // 30 h atrás

    const c = await r.conductor(org);
    const viajeId = await r.publicar(c, {
      fechaHoraSalida: salida.toISOString(),
      precioPorAsiento: '20.00',
    });

    const p = await r.pasajero(org, '50.00');
    const res = await r.reservar(p, viajeId).expect(201);
    const reservaId = res.body.reservaId as string;

    await r.procesar();

    // Colocar la reserva en 'verificacion_fallida' con actualizado_en de hace 26 h
    const hace26h = new Date(ahora.getTime() - 26 * 60 * 60 * 1000);
    await e.bd.query(
      `UPDATE reservas SET estado = 'verificacion_fallida', actualizado_en = $1 WHERE id = $2`,
      [hace26h, reservaId],
    );

    const resumen = await vencimientosService.procesarVencimientos(ahora);
    expect(resumen.reembolsosFallidos).toBe(1);

    // Reserva sigue en verificacion_fallida
    const { rows } = await e.bd.query(
      `SELECT estado FROM reservas WHERE id = $1`,
      [reservaId],
    );
    expect(rows[0].estado).toBe('verificacion_fallida');

    // Procesar worker para efectivizar reembolso
    await r.procesar();
    const movs = await r.movimientosDeReserva(reservaId);
    const reembolso = movs.find((m) => m.tipo === 'reembolso_reserva');
    expect(reembolso).toMatchObject({
      estado: 'confirmado',
      monto: '20.00',
    });
  });

  it('CA-19 · reserva confirmada en viaje ya cancelado pasa a cancelada con reembolso 100 %', async () => {
    const ahora = new Date('2026-11-15T12:00:00.000Z');
    const salida = new Date(ahora.getTime() + 60 * 60 * 1000);

    const c = await r.conductor(org);
    const viajeId = await r.publicar(c, {
      fechaHoraSalida: salida.toISOString(),
      precioPorAsiento: '10.00',
    });
    const p = await r.pasajero(org, '50.00');
    const res = await r.reservar(p, viajeId).expect(201);
    const reservaId = res.body.reservaId as string;

    // Confirmar en cadena
    await r.procesar();

    // Simular que el viaje fue cancelado mientras la reserva quedó confirmada
    await e.bd.query(`UPDATE viajes SET estado = 'cancelado' WHERE id = $1`, [
      viajeId,
    ]);

    const resumen = await vencimientosService.procesarVencimientos(ahora);
    expect(resumen.reservasCanceladasPorViaje).toBe(1);

    const { rows } = await e.bd.query(
      `SELECT estado, motivo FROM reservas WHERE id = $1`,
      [reservaId],
    );
    expect(rows[0]).toMatchObject({
      estado: 'cancelada',
      motivo: 'cancelada_conductor',
    });
  });
});
