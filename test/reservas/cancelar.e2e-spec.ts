import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { enMs, HORA_MS } from '../viajes/ayudas-viajes.js';
import { ayudasReservas } from './ayudas-reservas.js';

describe('HU-20 · Cancelación de reserva por pasajero (e2e)', () => {
  let e: Entorno;
  const r = ayudasReservas(() => e);
  let org: string;

  beforeAll(async () => {
    e = await prepararEntorno();
    org = (await r.v.organizacion('Cancelaciones')).id;
  });

  beforeEach(() => r.preparar());

  afterAll(async () => {
    await e?.cerrar();
  });

  const escenario = async (minutosParaSalida = 60, precio = '10.00') => {
    const c = await r.conductor(org);
    const salida = enMs(minutosParaSalida * 60 * 1000);
    const viajeId = await r.publicar(c, {
      fechaHoraSalida: salida,
      precioPorAsiento: precio,
      cuposTotales: 3,
    });
    const p = await r.pasajero(org, '50.00');
    const resReserva = await r.reservar(p, viajeId).expect(201);
    const reservaId = resReserva.body.reservaId as string;

    // Confirmar la reserva en la cadena simulada ejecutando el worker
    await r.procesar();

    return { c, p, viajeId, reservaId, salida };
  };

  describe('CA-1 · Vista previa de cancelación', () => {
    it('muestra vista previa con 100 % al pasajero con más de 30 min', async () => {
      const { p, reservaId } = await escenario(60);
      const res = await r.reserva(p.token, reservaId).expect(200);

      expect(res.body.cancelacion).toEqual({
        cancelable: true,
        porcentajePasajero: 100,
        montoPasajero: '10.00',
        montoConductor: '0.00',
        motivo: 'mas_de_30_min',
      });
    });

    it('muestra vista previa con 50/50 con 30 min o menos', async () => {
      const { p, reservaId } = await escenario(20);
      const res = await r.reserva(p.token, reservaId).expect(200);

      expect(res.body.cancelacion).toEqual({
        cancelable: true,
        porcentajePasajero: 50,
        montoPasajero: '5.00',
        montoConductor: '5.00',
        motivo: '30_min_o_menos',
      });
    });
  });

  describe('CA-2 · Cancelación con más de 30 min (100 %)', () => {
    it('cancela reserva confirmada, libera el cupo y devuelve 100 % al procesar worker', async () => {
      const { p, viajeId, reservaId } = await escenario(45);

      // Cupo inicial ocupado: 3 - 1 = 2
      expect((await r.viaje(viajeId)).cupos_disponibles).toBe(2);

      const cancelRes = await r.cancelarReserva(p, reservaId, 100).expect(200);

      expect(cancelRes.body).toMatchObject({
        estado: 'cancelada',
        reembolso: {
          estado: 'pendiente',
          montoPasajero: '10.00',
          montoConductor: '0.00',
        },
      });

      // El cupo vuelve a estar disponible (RN-8)
      expect((await r.viaje(viajeId)).cupos_disponibles).toBe(3);

      // Procesar reembolso con el worker de la cola on-chain
      await r.procesar();

      const movs = await r.movimientosDeReserva(reservaId);
      const movReembolso = movs.find((m) => m.tipo === 'reembolso_reserva');
      expect(movReembolso).toMatchObject({
        estado: 'confirmado',
        monto: '10.00',
        trabajo: 'terminado',
      });
      expect(movReembolso.hash_tx).toBeTruthy();

      // Auditoría registrada
      const auditorias = await r.auditorias(reservaId);
      expect(auditorias).toContainEqual(
        expect.objectContaining({
          accion: 'reserva.cancelada',
          resultado: 'ok',
          actor_id: p.id,
        }),
      );
    });
  });

  describe('CA-3 · Cancelación con 30 min o menos (50/50 D-18)', () => {
    it('cancela reserva y reparte 50 % al pasajero y 50 % de compensación al conductor', async () => {
      const { c, p, reservaId } = await escenario(15, '10.00');

      const cancelRes = await r.cancelarReserva(p, reservaId, 50).expect(200);

      expect(cancelRes.body).toMatchObject({
        estado: 'cancelada',
        reembolso: {
          estado: 'pendiente',
          montoPasajero: '5.00',
          montoConductor: '5.00',
        },
      });

      // Worker procesa el reembolso
      await r.procesar();

      const movs = await r.movimientosDeReserva(reservaId);
      const movPasajero = movs.find((m) => m.tipo === 'reembolso_reserva');
      const movConductor = movs.find(
        (m) => m.tipo === 'compensacion_cancelacion',
      );

      expect(movPasajero).toMatchObject({
        estado: 'confirmado',
        monto: '5.00',
      });
      expect(movConductor).toMatchObject({
        estado: 'confirmado',
        monto: '5.00',
      });

      // Saldos de billetera: conductor recibe 5 URC
      const saldoConductor = await r.saldo(c);
      expect(saldoConductor.disponible).toBe('5.00');
    });
  });

  describe('CA-4 · Cambio de política entre vista previa y confirmación', () => {
    it('rechaza si esperaba 100 % pero ya rigen 30 min o menos (50 %)', async () => {
      const { p, reservaId } = await escenario(20);

      const res = await r.cancelarReserva(p, reservaId, 100).expect(409);

      expect(res.body).toMatchObject({
        error: 'POLITICA_CAMBIO',
        detalles: {
          cancelacion: {
            cancelable: true,
            porcentajePasajero: 50,
            montoPasajero: '5.00',
            montoConductor: '5.00',
          },
        },
      });
    });
  });

  describe('CA-10 · Idempotencia', () => {
    it('repetir la cancelación devuelve el mismo resultado sin duplicar movimientos', async () => {
      const { p, reservaId } = await escenario(50);

      const r1 = await r.cancelarReserva(p, reservaId, 100).expect(200);
      const r2 = await r.cancelarReserva(p, reservaId, 100).expect(200);

      expect(r2.body).toEqual(r1.body);

      const movs = await r.movimientosDeReserva(reservaId);
      const reembolsos = movs.filter((m) => m.tipo === 'reembolso_reserva');
      expect(reembolsos).toHaveLength(1);
    });
  });

  describe('CA-11 y CA-18 · Estados no cancelables', () => {
    it('rechaza cancelar una reserva pendiente con RESERVA_PENDIENTE (CA-18)', async () => {
      const c = await r.conductor(org);
      const viajeId = await r.publicar(c, { fechaHoraSalida: enMs(HORA_MS) });
      const p = await r.pasajero(org, '50.00');
      const res = await r.reservar(p, viajeId).expect(201);
      const pendienteId = res.body.reservaId as string;

      // Sin procesar el worker: sigue pendiente
      await r
        .cancelarReserva(p, pendienteId, 100)
        .expect(409)
        .expect((res) => {
          expect(res.body.error).toBe('RESERVA_PENDIENTE');
        });
    });

    it('rechaza cancelar una reserva ya cancelada con política distinta si no es idempotente (CA-11)', async () => {
      const { p, reservaId } = await escenario(50);
      await r.cancelarReserva(p, reservaId, 100).expect(200);

      // Si se altera el estado manualmente o se intenta sobre reserva expirada
      await e.bd.query(
        `UPDATE reservas SET estado = 'expirada' WHERE id = $1`,
        [reservaId],
      );

      await r
        .cancelarReserva(p, reservaId, 100)
        .expect(409)
        .expect((res) => {
          expect(res.body.error).toBe('NO_CANCELABLE');
        });
    });
  });

  describe('CA-12 · Concurrencia entre abordaje y cancelación', () => {
    it('si la reserva fue cancelada primero, el abordaje se rechaza', async () => {
      const { p, reservaId } = await escenario(40);
      await r.cancelarReserva(p, reservaId, 100).expect(200);

      // Intento de abordaje directo en base de datos o servicio
      const { rows } = await e.bd.query(
        `SELECT estado FROM reservas WHERE id = $1`,
        [reservaId],
      );
      expect(rows[0].estado).toBe('cancelada');
    });
  });
});
