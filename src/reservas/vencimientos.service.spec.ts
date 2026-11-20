import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { EstadoViaje } from '../generated/prisma/client.js';
import type { AuditoriaService } from '../auditoria/auditoria.service.js';
import type { PrismaService } from '../comun/prisma.service.js';
import type { CorreosService } from '../notificaciones/correos.service.js';
import type { PushService } from '../notificaciones/push.service.js';
import type { EstadoViajeService } from '../viajes/estado-viaje.service.js';
import { VencimientosService } from './vencimientos.service.js';

describe('VencimientosService (HU-20 SP181)', () => {
  const AHORA = new Date('2026-11-15T12:00:00.000Z');
  const HACE_16_MIN = new Date(AHORA.getTime() - 16 * 60 * 1000);
  const HACE_10_MIN = new Date(AHORA.getTime() - 10 * 60 * 1000);
  const HACE_25_HORAS = new Date(AHORA.getTime() - 25 * 60 * 60 * 1000);

  function crearContexto(
    o: {
      candidatasSinAbordaje?: Array<Record<string, unknown>>;
      updateManySinAbordajeCount?: number;
      candidatasCancelados?: Array<Record<string, unknown>>;
      updateManyCanceladosCount?: number;
      viajesPorExpirar?: Array<Record<string, unknown>>;
      expirarViajeRetorno?: boolean;
      candidatasFallidas?: Array<Record<string, unknown>>;
      movimientoFallidaPrevio?: Record<string, unknown> | null;
    } = {},
  ) {
    const movimientosCreados: Array<Record<string, unknown>> = [];
    const trabajosCreados: Array<Record<string, unknown>> = [];
    const correosEncolados: Array<Record<string, unknown>> = [];
    const eventosAuditoria: Array<Record<string, unknown>> = [];

    const tx = {
      reserva: {
        findMany: vi
          .fn()
          .mockImplementation((args: { where: Record<string, unknown> }) => {
            if (args.where.estado === 'confirmada' && args.where.viaje) {
              const v = args.where.viaje as Record<string, unknown>;
              if (v.fechaHoraSalida) {
                return Promise.resolve(o.candidatasSinAbordaje ?? []);
              }
              if (v.estado) {
                return Promise.resolve(o.candidatasCancelados ?? []);
              }
            }
            if (args.where.estado === 'verificacion_fallida') {
              return Promise.resolve(o.candidatasFallidas ?? []);
            }
            return Promise.resolve([]);
          }),
        updateMany: vi
          .fn()
          .mockImplementation((args: { data: { estado: string } }) => {
            if (args.data.estado === 'expirada') {
              return Promise.resolve({
                count: o.updateManySinAbordajeCount ?? 1,
              });
            }
            return Promise.resolve({ count: o.updateManyCanceladosCount ?? 1 });
          }),
      },
      viaje: {
        findMany: vi.fn().mockResolvedValue(o.viajesPorExpirar ?? []),
      },
      billetera: {
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ id: 'billetera-1', usuarioId: 'u1' }),
      },
      movimientoBilletera: {
        findFirst: vi.fn().mockResolvedValue(o.movimientoFallidaPrevio ?? null),
        create: vi
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            movimientosCreados.push(data);
            return Promise.resolve({
              id: `mov-${movimientosCreados.length}`,
              ...data,
            });
          }),
      },
      trabajoOnchain: {
        create: vi
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            trabajosCreados.push(data);
            return Promise.resolve({
              id: `trabajo-${trabajosCreados.length}`,
              ...data,
            });
          }),
      },
    };

    const prisma = {
      comoSuperAdmin: vi
        .fn()
        .mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => {
          return await cb(tx);
        }),
    };

    const auditoria = {
      registrar: vi
        .fn()
        .mockImplementation((evento: Record<string, unknown>) => {
          eventosAuditoria.push(evento);
          return Promise.resolve();
        }),
    };

    const estadoViaje = {
      expirar: vi.fn().mockResolvedValue(o.expirarViajeRetorno ?? true),
    };

    const correos = {
      encolar: vi
        .fn()
        .mockImplementation(
          (_tx: unknown, payload: Record<string, unknown>) => {
            correosEncolados.push(payload);
            return Promise.resolve();
          },
        ),
    };

    const push = { encolar: vi.fn() };
    const servicio = new VencimientosService(
      prisma as unknown as PrismaService,
      auditoria as unknown as AuditoriaService,
      estadoViaje as unknown as EstadoViajeService,
      correos as unknown as CorreosService,
      push as unknown as PushService,
    );

    return {
      servicio,
      push,
      tx,
      prisma,
      auditoria,
      estadoViaje,
      correos,
      movimientosCreados,
      trabajosCreados,
      correosEncolados,
      eventosAuditoria,
    };
  }

  describe('1. Expiración de reservas sin abordar (CA-6, CA-8, RN-5)', () => {
    it('expira reserva confirmada pasados 15 min de la salida y genera reembolso 100 %', async () => {
      const {
        servicio,
        push,
        movimientosCreados,
        trabajosCreados,
        eventosAuditoria,
      } = crearContexto({
        candidatasSinAbordaje: [
          {
            id: 'res-1',
            monto: new Prisma.Decimal('12.00'),
            pasajeroId: 'pasajero-1',
            organizacionId: 'org-1',
            viajeId: 'viaje-1',
            viaje: { destinoNombre: 'UAGRM' },
          },
        ],
      });

      const res = await servicio.procesarVencimientos(AHORA);

      expect(res.reservasExpiradas).toBe(1);
      expect(push.encolar).toHaveBeenCalledWith(
        expect.anything(),
        'pasajero-1',
        'reserva_expirada',
        expect.objectContaining({ monto: '12.00', ruta: '/reserva/res-1' }),
      );
      expect(movimientosCreados).toHaveLength(1);
      expect(movimientosCreados[0]).toMatchObject({
        billeteraId: 'billetera-1',
        tipo: 'reembolso_reserva',
        monto: new Prisma.Decimal('12.00'),
        estado: 'pendiente',
        reservaId: 'res-1',
        claveIdempotencia: 'reembolso:res-1',
        metadatos: {
          porcentajePasajeroBps: 10_000,
          montoConductor: '0.00',
          motivo: 'expirada_sin_abordaje',
        },
      });
      expect(trabajosCreados).toHaveLength(1);
      expect(trabajosCreados[0]).toMatchObject({
        operacion: 'reembolsar_reserva',
        estado: 'pendiente',
      });
      expect(eventosAuditoria).toContainEqual(
        expect.objectContaining({
          accion: 'reserva.expirada',
          entidad: 'reserva',
          entidadId: 'res-1',
          organizacionId: 'org-1',
        }),
      );
    });

    it('no genera reembolso si el UPDATE condicional no gana (ej. abordaje concurrente CA-12)', async () => {
      const { servicio, movimientosCreados, trabajosCreados } = crearContexto({
        candidatasSinAbordaje: [
          {
            id: 'res-1',
            monto: new Prisma.Decimal('12.00'),
            pasajeroId: 'pasajero-1',
            organizacionId: 'org-1',
            viajeId: 'viaje-1',
            viaje: { destinoNombre: 'UAGRM' },
          },
        ],
        updateManySinAbordajeCount: 0,
      });

      const res = await servicio.procesarVencimientos(AHORA);

      expect(res.reservasExpiradas).toBe(0);
      expect(movimientosCreados).toHaveLength(0);
      expect(trabajosCreados).toHaveLength(0);
    });
  });

  describe('2. Reservas de viajes cancelados o expirados (CA-19)', () => {
    it('cancela reserva confirmada si su viaje fue cancelado y encola correo al pasajero', async () => {
      const {
        servicio,
        movimientosCreados,
        trabajosCreados,
        correosEncolados,
        eventosAuditoria,
      } = crearContexto({
        candidatasCancelados: [
          {
            id: 'res-pend-1',
            monto: new Prisma.Decimal('15.00'),
            pasajeroId: 'pasajero-2',
            organizacionId: 'org-1',
            pasajero: {
              nombreCompleto: 'Carlos Perez',
              correo: 'carlos@uagrm.edu.bo',
            },
            viaje: {
              estado: EstadoViaje.cancelado,
              fechaHoraSalida: HACE_10_MIN,
            },
          },
        ],
      });

      const res = await servicio.procesarVencimientos(AHORA);

      expect(res.reservasCanceladasPorViaje).toBe(1);
      expect(movimientosCreados).toHaveLength(1);
      expect(movimientosCreados[0]).toMatchObject({
        tipo: 'reembolso_reserva',
        monto: new Prisma.Decimal('15.00'),
        metadatos: {
          porcentajePasajeroBps: 10_000,
          motivo: 'cancelada_conductor',
        },
      });
      expect(trabajosCreados).toHaveLength(1);
      expect(correosEncolados).toHaveLength(1);
      expect(correosEncolados[0]).toMatchObject({
        destinatario: 'carlos@uagrm.edu.bo',
        plantilla: 'viaje_cancelado',
        datos: {
          nombre: 'Carlos',
          monto: '15.00',
        },
      });
      expect(eventosAuditoria).toContainEqual(
        expect.objectContaining({
          accion: 'reserva.cancelada',
          entidadId: 'res-pend-1',
        }),
      );
    });

    it('expira reserva confirmada si su viaje fue expirado', async () => {
      const {
        servicio,
        movimientosCreados,
        correosEncolados,
        eventosAuditoria,
      } = crearContexto({
        candidatasCancelados: [
          {
            id: 'res-pend-2',
            monto: new Prisma.Decimal('10.00'),
            pasajeroId: 'pasajero-3',
            organizacionId: 'org-1',
            pasajero: {
              nombreCompleto: 'Ana Lopez',
              correo: 'ana@uagrm.edu.bo',
            },
            viaje: {
              estado: EstadoViaje.expirado,
              fechaHoraSalida: HACE_16_MIN,
            },
          },
        ],
      });

      const res = await servicio.procesarVencimientos(AHORA);

      expect(res.reservasCanceladasPorViaje).toBe(1);
      expect(movimientosCreados).toHaveLength(1);
      expect(correosEncolados).toHaveLength(0);
      expect(eventosAuditoria).toContainEqual(
        expect.objectContaining({
          accion: 'reserva.expirada',
          entidadId: 'res-pend-2',
        }),
      );
    });
  });

  describe('3. Expiración de viajes pasados 15 min (CA-6, CA-7, RN-5)', () => {
    it('expira viaje sin reservas activas y registra auditoria', async () => {
      const { servicio, estadoViaje, eventosAuditoria } = crearContexto({
        viajesPorExpirar: [{ id: 'viaje-vacio', organizacionId: 'org-1' }],
        expirarViajeRetorno: true,
      });

      const res = await servicio.procesarVencimientos(AHORA);

      expect(res.viajesExpirados).toBe(1);
      expect(estadoViaje.expirar).toHaveBeenCalledWith(
        expect.anything(),
        'viaje-vacio',
      );
      expect(eventosAuditoria).toContainEqual(
        expect.objectContaining({
          accion: 'viaje.expirado',
          entidadId: 'viaje-vacio',
        }),
      );
    });

    it('no audita si EstadoViajeService.expirar no lo expira (ej. tenia reservas abordadas CA-8)', async () => {
      const { servicio, estadoViaje, eventosAuditoria } = crearContexto({
        viajesPorExpirar: [
          { id: 'viaje-con-abordaje', organizacionId: 'org-1' },
        ],
        expirarViajeRetorno: false,
      });

      const res = await servicio.procesarVencimientos(AHORA);

      expect(res.viajesExpirados).toBe(0);
      expect(estadoViaje.expirar).toHaveBeenCalledWith(
        expect.anything(),
        'viaje-con-abordaje',
      );
      expect(
        eventosAuditoria.filter((e) => e.accion === 'viaje.expirado'),
      ).toHaveLength(0);
    });
  });

  describe('4. Reembolso de reservas en verificacion fallida tras 24 h (CA-9, RN-11, D-29)', () => {
    it('devuelve el 100 % al pasajero tras 24 h en verificacion fallida', async () => {
      const {
        servicio,
        movimientosCreados,
        trabajosCreados,
        eventosAuditoria,
      } = crearContexto({
        candidatasFallidas: [
          {
            id: 'res-fallida-1',
            monto: new Prisma.Decimal('20.00'),
            pasajeroId: 'pasajero-4',
            organizacionId: 'org-1',
            actualizadoEn: HACE_25_HORAS,
          },
        ],
        movimientoFallidaPrevio: null,
      });

      const res = await servicio.procesarVencimientos(AHORA);

      expect(res.reembolsosFallidos).toBe(1);
      expect(movimientosCreados).toHaveLength(1);
      expect(movimientosCreados[0]).toMatchObject({
        tipo: 'reembolso_reserva',
        monto: new Prisma.Decimal('20.00'),
        metadatos: {
          porcentajePasajeroBps: 10_000,
          motivo: 'verificacion_fallida_24h',
        },
      });
      expect(trabajosCreados).toHaveLength(1);
      expect(eventosAuditoria).toContainEqual(
        expect.objectContaining({
          accion: 'reserva.reembolsada_fallida',
          entidadId: 'res-fallida-1',
        }),
      );
    });

    it('idempotencia: no duplica el reembolso si ya tiene un movimiento previo', async () => {
      const {
        servicio,
        movimientosCreados,
        trabajosCreados,
        eventosAuditoria,
      } = crearContexto({
        candidatasFallidas: [
          {
            id: 'res-fallida-1',
            monto: new Prisma.Decimal('20.00'),
            pasajeroId: 'pasajero-4',
            organizacionId: 'org-1',
            actualizadoEn: HACE_25_HORAS,
          },
        ],
        movimientoFallidaPrevio: { id: 'mov-existente' },
      });

      const res = await servicio.procesarVencimientos(AHORA);

      expect(res.reembolsosFallidos).toBe(0);
      expect(movimientosCreados).toHaveLength(0);
      expect(trabajosCreados).toHaveLength(0);
      expect(
        eventosAuditoria.filter(
          (e) => e.accion === 'reserva.reembolsada_fallida',
        ),
      ).toHaveLength(0);
    });
  });
});
