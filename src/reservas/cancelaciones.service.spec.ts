import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { EstadoViaje } from '../generated/prisma/client.js';
import type { AuditoriaService } from '../auditoria/auditoria.service.js';
import type { BlockchainService } from '../blockchain/blockchain.service.js';
import type { PrismaService } from '../comun/prisma.service.js';
import type { CorreosService } from '../notificaciones/correos.service.js';
import type { PushService } from '../notificaciones/push.service.js';
import type { EstadoViajeService } from '../viajes/estado-viaje.service.js';
import { CancelacionesService } from './cancelaciones.service.js';

describe('CancelacionesService', () => {
  const BASE = new Date('2026-11-15T12:00:00.000Z');
  const SALIDA_LEJOS = new Date(BASE.getTime() + 60 * 60 * 1000); // 60 min > 30 min
  const SALIDA_CERCA = new Date(BASE.getTime() + 15 * 60 * 1000); // 15 min <= 30 min

  function crearContexto(
    o: {
      reserva?: Record<string, unknown> | null;
      viaje?: Record<string, unknown> | null;
      reservasConfirmadas?: Array<Record<string, unknown>>;
      billeteraPasajero?: Record<string, unknown>;
      billeteraConductor?: Record<string, unknown>;
      cancelarViajeExito?: boolean;
      updateManyReservaCount?: number;
    } = {},
  ) {
    const tx = {
      reserva: {
        findFirst: vi.fn().mockResolvedValue(
          o.reserva !== undefined
            ? o.reserva
            : {
                id: 'r1',
                pasajeroId: 'u1',
                estado: 'confirmada',
                monto: new Prisma.Decimal('10.00'),
                pasajero: { nombreCompleto: 'Ana Pérez' },
                viaje: {
                  id: 'v1',
                  conductorId: 'c1',
                  fechaHoraSalida: SALIDA_LEJOS,
                  cuposTotales: 4,
                  cuposDisponibles: 3,
                  estado: EstadoViaje.reservado,
                },
              },
        ),
        findUniqueOrThrow: vi.fn().mockResolvedValue(
          o.reserva !== undefined
            ? o.reserva
            : {
                id: 'r1',
                estado: 'cancelada',
                monto: new Prisma.Decimal('10.00'),
                organizacionId: 'o1',
                viajeId: 'v1',
              },
        ),
        findMany: vi.fn().mockResolvedValue(o.reservasConfirmadas ?? []),
        updateMany: vi.fn().mockResolvedValue({
          count: o.updateManyReservaCount ?? 1,
        }),
      },
      viaje: {
        findFirst: vi.fn().mockResolvedValue(
          o.viaje !== undefined
            ? o.viaje
            : {
                id: 'v1',
                conductorId: 'c1',
                estado: EstadoViaje.publicado,
                fechaHoraSalida: SALIDA_LEJOS,
              },
        ),
      },
      billetera: {
        findUniqueOrThrow: vi.fn().mockImplementation(({ where }) => {
          if (where.usuarioId === 'c1') {
            return Promise.resolve(
              o.billeteraConductor ?? { id: 'b-cond', usuarioId: 'c1' },
            );
          }
          return Promise.resolve(
            o.billeteraPasajero ?? { id: 'b-pas', usuarioId: 'u1' },
          );
        }),
        findMany: vi.fn().mockResolvedValue([
          { id: 'b-pas1', usuarioId: 'p1' },
          { id: 'b-pas2', usuarioId: 'p2' },
        ]),
      },
      movimientoBilletera: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'm1',
          monto: new Prisma.Decimal('10.00'),
          estado: 'pendiente',
          hashTx: null,
        }),
        create: vi.fn().mockResolvedValue({ id: 'm-nuevo' }),
      },
      trabajoOnchain: {
        create: vi.fn().mockResolvedValue({ id: 't-nuevo' }),
      },
      $executeRaw: vi.fn().mockResolvedValue(1),
    };

    const prisma = {
      enOrganizacion: vi.fn((_orgId, cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    const auditoria = { registrar: vi.fn().mockResolvedValue(undefined) };
    const estadoViaje = {
      cancelar: vi.fn().mockResolvedValue(o.cancelarViajeExito ?? true),
      expirar: vi.fn().mockResolvedValue(true),
    };
    const correos = { encolar: vi.fn().mockResolvedValue(undefined) };
    const blockchain = {
      cadena: {
        exploradorTxUrl: vi
          .fn()
          .mockReturnValue('https://explorer.test/tx/0x1'),
      },
    };

    const push = { encolar: vi.fn() };
    const servicio = new CancelacionesService(
      prisma as unknown as PrismaService,
      auditoria as unknown as AuditoriaService,
      estadoViaje as unknown as EstadoViajeService,
      correos as unknown as CorreosService,
      blockchain as unknown as BlockchainService,
      push as unknown as PushService,
    );

    return {
      servicio,
      push,
      prisma,
      tx,
      auditoria,
      estadoViaje,
      correos,
      blockchain,
    };
  }

  describe('cancelarReserva (HU-20 CA-1…CA-4, CA-10…CA-15)', () => {
    it('lanza 404 RESERVA_NO_ENCONTRADA si la reserva no existe', async () => {
      const c = crearContexto({ reserva: null });
      await expect(
        c.servicio.cancelarReserva(
          'u1',
          'o1',
          'r1',
          { porcentajeEsperado: 100 },
          BASE,
        ),
      ).rejects.toMatchObject({
        status: 404,
        response: expect.objectContaining({ codigo: 'RESERVA_NO_ENCONTRADA' }),
      });
    });

    it('A-13: lanza 404 si la reserva le pertenece a otro usuario', async () => {
      const c = crearContexto({
        reserva: {
          id: 'r1',
          pasajeroId: 'otro-usuario',
          estado: 'confirmada',
          monto: new Prisma.Decimal('10.00'),
          viaje: { id: 'v1', conductorId: 'c1', fechaHoraSalida: SALIDA_LEJOS },
        },
      });
      await expect(
        c.servicio.cancelarReserva(
          'u1',
          'o1',
          'r1',
          { porcentajeEsperado: 100 },
          BASE,
        ),
      ).rejects.toMatchObject({
        status: 404,
        response: expect.objectContaining({ codigo: 'RESERVA_NO_ENCONTRADA' }),
      });
    });

    it('CA-18: lanza 409 RESERVA_PENDIENTE si la reserva está en pendiente', async () => {
      const c = crearContexto({
        reserva: {
          id: 'r1',
          pasajeroId: 'u1',
          estado: 'pendiente',
          monto: new Prisma.Decimal('10.00'),
          viaje: { id: 'v1', conductorId: 'c1', fechaHoraSalida: SALIDA_LEJOS },
        },
      });
      await expect(
        c.servicio.cancelarReserva(
          'u1',
          'o1',
          'r1',
          { porcentajeEsperado: 100 },
          BASE,
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ codigo: 'RESERVA_PENDIENTE' }),
      });
    });

    it('CA-11: lanza 409 NO_CANCELABLE si la reserva está abordada o pagada', async () => {
      const c = crearContexto({
        reserva: {
          id: 'r1',
          pasajeroId: 'u1',
          estado: 'abordada',
          monto: new Prisma.Decimal('10.00'),
          viaje: { id: 'v1', conductorId: 'c1', fechaHoraSalida: SALIDA_LEJOS },
        },
      });
      await expect(
        c.servicio.cancelarReserva(
          'u1',
          'o1',
          'r1',
          { porcentajeEsperado: 100 },
          BASE,
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ codigo: 'NO_CANCELABLE' }),
      });
    });

    it('CA-4: lanza 409 POLITICA_CAMBIO si se esperaba 100 % y rige el 50 %', async () => {
      const c = crearContexto({
        reserva: {
          id: 'r1',
          pasajeroId: 'u1',
          estado: 'confirmada',
          monto: new Prisma.Decimal('10.00'),
          pasajero: { nombreCompleto: 'Ana Pérez' },
          viaje: {
            id: 'v1',
            conductorId: 'c1',
            fechaHoraSalida: SALIDA_CERCA, // 15 min rige 50%
            cuposTotales: 4,
            cuposDisponibles: 3,
            estado: EstadoViaje.reservado,
          },
        },
      });
      await expect(
        c.servicio.cancelarReserva(
          'u1',
          'o1',
          'r1',
          { porcentajeEsperado: 100 },
          BASE,
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({
          codigo: 'POLITICA_CAMBIO',
          cancelacion: expect.objectContaining({
            porcentajePasajero: 50,
            montoPasajero: '5.00',
            montoConductor: '5.00',
          }),
        }),
      });
    });

    it('CA-2: cancela al 100 % con más de 30 min, registra movimientos, encola trabajo y devuelve resultado', async () => {
      const c = crearContexto();
      const res = await c.servicio.cancelarReserva(
        'u1',
        'o1',
        'r1',
        { porcentajeEsperado: 100 },
        BASE,
      );

      expect(res.estado).toBe('cancelada');
      expect(res.reembolso.estado).toBe('pendiente');
      expect(res.reembolso.montoPasajero).toBe('10.00');
      // PB-09: avisa al conductor.
      expect(c.push.encolar).toHaveBeenCalledWith(
        c.tx,
        'c1',
        'reserva_cancelada',
        expect.objectContaining({ pasajero: 'Ana', ruta: '/viajes/v1' }),
      );
      expect(res.reembolso.montoConductor).toBe('0.00');

      // Verifica movimiento del pasajero al 100 %
      expect(c.tx.movimientoBilletera.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tipo: 'reembolso_reserva',
            monto: new Prisma.Decimal('10.00'),
            estado: 'pendiente',
            claveIdempotencia: 'reembolso:r1',
          }),
        }),
      );

      // Encola trabajo onchain reembolsar_reserva
      expect(c.tx.trabajoOnchain.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          operacion: 'reembolsar_reserva',
          estado: 'pendiente',
        }),
      });

      // Libera cupo del viaje si no ha salido
      expect(c.tx.$executeRaw).toHaveBeenCalled();

      // Audita reserva.cancelada
      expect(c.auditoria.registrar).toHaveBeenCalledWith(
        expect.objectContaining({
          accion: 'reserva.cancelada',
          entidadId: 'r1',
          actorId: 'u1',
          detalle: expect.objectContaining({ porcentajePasajero: 100 }),
        }),
        c.tx,
      );
    });

    it('CA-3: cancela al 50 % con 30 min o menos, compensa al conductor (D-18)', async () => {
      const c = crearContexto({
        reserva: {
          id: 'r1',
          pasajeroId: 'u1',
          estado: 'confirmada',
          monto: new Prisma.Decimal('12.00'),
          pasajero: { nombreCompleto: 'Ana Pérez' },
          viaje: {
            id: 'v1',
            conductorId: 'c1',
            fechaHoraSalida: SALIDA_CERCA,
            cuposTotales: 4,
            cuposDisponibles: 3,
            estado: EstadoViaje.reservado,
          },
        },
      });

      const res = await c.servicio.cancelarReserva(
        'u1',
        'o1',
        'r1',
        { porcentajeEsperado: 50 },
        BASE,
      );

      expect(res.estado).toBe('cancelada');
      expect(res.reembolso.montoPasajero).toBe('6.00');
      expect(res.reembolso.montoConductor).toBe('6.00');

      // Movimiento pasajero 6.00 y compensación conductor 6.00
      expect(c.tx.movimientoBilletera.create).toHaveBeenCalledTimes(2);
      expect(c.tx.movimientoBilletera.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tipo: 'compensacion_cancelacion',
            monto: new Prisma.Decimal('6.00'),
            claveIdempotencia: 'compensacion:r1',
          }),
        }),
      );
    });

    it('CA-10: si ya fue cancelada devuelve el resultado previo de forma idempotente', async () => {
      const c = crearContexto({
        reserva: {
          id: 'r1',
          pasajeroId: 'u1',
          estado: 'cancelada',
          monto: new Prisma.Decimal('10.00'),
          viaje: { id: 'v1', conductorId: 'c1', fechaHoraSalida: SALIDA_LEJOS },
        },
      });

      const res = await c.servicio.cancelarReserva(
        'u1',
        'o1',
        'r1',
        { porcentajeEsperado: 100 },
        BASE,
      );
      expect(res.estado).toBe('cancelada');
      expect(c.tx.reserva.updateMany).not.toHaveBeenCalled();
      expect(c.tx.movimientoBilletera.create).not.toHaveBeenCalled();
    });
  });

  describe('cancelarViaje (HU-20 CA-5, RN-4)', () => {
    it('lanza 404 si el viaje no existe o le pertenece a otro conductor', async () => {
      const c = crearContexto({ viaje: null });
      await expect(
        c.servicio.cancelarViaje('c1', 'o1', 'v1'),
      ).rejects.toMatchObject({
        status: 404,
        response: expect.objectContaining({ codigo: 'VIAJE_NO_ENCONTRADO' }),
      });
    });

    it('CA-11: lanza 409 si el viaje está en curso o expirado', async () => {
      const c = crearContexto({
        viaje: {
          id: 'v1',
          conductorId: 'c1',
          estado: EstadoViaje.en_curso,
          fechaHoraSalida: SALIDA_LEJOS,
        },
      });
      await expect(
        c.servicio.cancelarViaje('c1', 'o1', 'v1'),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ codigo: 'NO_CANCELABLE' }),
      });
    });

    it('CA-5: cancela viaje, cancela reservas confirmadas al 100 %, encola correos y audita', async () => {
      const c = crearContexto({
        viaje: {
          id: 'v1',
          conductorId: 'c1',
          estado: EstadoViaje.reservado,
          fechaHoraSalida: SALIDA_LEJOS,
        },
        reservasConfirmadas: [
          {
            id: 'r1',
            pasajeroId: 'p1',
            monto: new Prisma.Decimal('10.00'),
            pasajero: {
              nombreCompleto: 'Ana Rojas',
              correo: 'ana@uagrm.edu.bo',
            },
          },
          {
            id: 'r2',
            pasajeroId: 'p2',
            monto: new Prisma.Decimal('10.00'),
            pasajero: {
              nombreCompleto: 'Carlos Perez',
              correo: 'carlos@uagrm.edu.bo',
            },
          },
        ],
      });

      const res = await c.servicio.cancelarViaje('c1', 'o1', 'v1');
      expect(res.estado).toBe('cancelado');
      expect(res.reservasCanceladas).toBe(2);

      // EstadoViajeService.cancelar fue invocado
      expect(c.estadoViaje.cancelar).toHaveBeenCalledWith(c.tx, 'v1');

      // Dos reembolsos creados
      expect(c.tx.movimientoBilletera.create).toHaveBeenCalledTimes(2);

      // Dos correos encolados
      expect(c.correos.encolar).toHaveBeenCalledTimes(2);
      expect(c.correos.encolar).toHaveBeenCalledWith(
        c.tx,
        expect.objectContaining({
          destinatario: 'ana@uagrm.edu.bo',
          plantilla: 'viaje_cancelado',
        }),
      );

      // Auditoría viaje.cancelado
      expect(c.auditoria.registrar).toHaveBeenCalledWith(
        expect.objectContaining({
          accion: 'viaje.cancelado',
          entidadId: 'v1',
          actorId: 'c1',
        }),
        c.tx,
      );
    });

    it('idempotencia: si ya estaba cancelado devuelve { estado: cancelado, reservasCanceladas: 0 }', async () => {
      const c = crearContexto({
        viaje: {
          id: 'v1',
          conductorId: 'c1',
          estado: EstadoViaje.cancelado,
          fechaHoraSalida: SALIDA_LEJOS,
        },
      });

      const res = await c.servicio.cancelarViaje('c1', 'o1', 'v1');
      expect(res.estado).toBe('cancelado');
      expect(res.reservasCanceladas).toBe(0);
      expect(c.estadoViaje.cancelar).not.toHaveBeenCalled();
    });
  });
});
