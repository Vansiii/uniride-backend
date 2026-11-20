import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { BlockchainService } from '../blockchain/blockchain.service.js';
import type { EstadoMovimiento } from '../billetera/dto/saldo.dto.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService } from '../comun/prisma.service.js';
import { EstadoViaje } from '../generated/prisma/client.js';
import { EstadoViajeService } from '../viajes/estado-viaje.service.js';
import { CorreosService } from '../notificaciones/correos.service.js';
import { PushService } from '../notificaciones/push.service.js';
import { politicaCancelacion } from './politica-cancelacion.js';
import type {
  CancelarReservaDto,
  ReservaCanceladaResultadoDto,
  ViajeCanceladoResultadoDto,
} from './dto/reserva.dto.js';

@Injectable()
export class CancelacionesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly estadoViaje: EstadoViajeService,
    private readonly correos: CorreosService,
    private readonly blockchain: BlockchainService,
    private readonly push: PushService,
  ) {}

  /**
   * HU-20 CA-1…CA-4, CA-10…CA-15: Cancelación de reserva por el pasajero.
   * Aplica la política según la hora del servidor (RN-1, RN-2). En una sola transacción actualiza la reserva,
   * crea los movimientos de dinero, encola el trabajo onchain, libera el asiento y audita.
   */
  async cancelarReserva(
    usuarioId: string,
    organizacionId: string,
    reservaId: string,
    dto: CancelarReservaDto,
    ahora: Date = new Date(),
  ): Promise<ReservaCanceladaResultadoDto> {
    return await this.prisma.enOrganizacion(organizacionId, async (tx) => {
      const reservaPrevia = await tx.reserva.findFirst({
        where: { id: reservaId, organizacionId },
        include: {
          pasajero: { select: { nombreCompleto: true } },
          viaje: {
            select: {
              id: true,
              conductorId: true,
              destinoNombre: true,
              fechaHoraSalida: true,
              cuposTotales: true,
              cuposDisponibles: true,
              estado: true,
            },
          },
        },
      });

      // A-13: si no existe, es de otra persona o de otra organización, responde 404 (CA-15)
      if (!reservaPrevia || reservaPrevia.pasajeroId !== usuarioId) {
        throw new ErrorNegocio(
          404,
          'RESERVA_NO_ENCONTRADA',
          'reservas.detalle.no_encontrada',
        );
      }

      // Idempotencia (CA-10): si ya fue cancelada por este pasajero, devuelve el resultado existente
      if (reservaPrevia.estado === 'cancelada') {
        const mov = await tx.movimientoBilletera.findFirst({
          where: { reservaId, tipo: 'reembolso_reserva' },
        });
        const comp = await tx.movimientoBilletera.findFirst({
          where: { reservaId, tipo: 'compensacion_cancelacion' },
        });
        return {
          estado: 'cancelada',
          reembolso: {
            estado: (mov?.estado ?? 'pendiente') as EstadoMovimiento,
            montoPasajero: mov ? mov.monto.toFixed(2) : '0.00',
            montoConductor: comp ? comp.monto.toFixed(2) : '0.00',
            hashTx: mov?.hashTx ?? null,
            exploradorUrl: mov?.hashTx
              ? this.blockchain.cadena.exploradorTxUrl(mov.hashTx)
              : null,
          },
        };
      }

      // CA-18: reserva en proceso de confirmación de bloqueo
      if (reservaPrevia.estado === 'pendiente') {
        throw new ErrorNegocio(
          409,
          'RESERVA_PENDIENTE',
          'reservas.cancelar.pendiente',
        );
      }

      // CA-11: abordada, verificada, pagada, expirada, fallida
      if (reservaPrevia.estado !== 'confirmada') {
        throw new ErrorNegocio(
          409,
          'NO_CANCELABLE',
          'reservas.cancelar.no_cancelable',
        );
      }

      // RN-1, RN-2: calcular política con la hora del servidor
      const politica = politicaCancelacion(
        reservaPrevia.monto,
        reservaPrevia.viaje.fechaHoraSalida,
        ahora,
      );

      // CA-4: cambio de política entre la vista previa y la confirmación
      if (dto.porcentajeEsperado > politica.porcentajePasajero) {
        throw new ErrorNegocio(
          409,
          'POLITICA_CAMBIO',
          'reservas.cancelar.politica_cambio',
          {
            cancelacion: {
              cancelable: true,
              porcentajePasajero: politica.porcentajePasajero,
              montoPasajero: politica.montoPasajero.toFixed(2),
              montoConductor: politica.montoConductor.toFixed(2),
              motivo: politica.motivo,
            },
          },
        );
      }

      // UPDATE condicional: solo pasa a cancelada si sigue confirmada (decide frente al abordaje CA-12)
      const { count } = await tx.reserva.updateMany({
        where: { id: reservaId, pasajeroId: usuarioId, estado: 'confirmada' },
        data: { estado: 'cancelada', motivo: 'cancelada_pasajero' },
      });

      if (count === 0) {
        const r = await tx.reserva.findUniqueOrThrow({
          where: { id: reservaId },
        });
        if (r.estado === 'cancelada') {
          const mov = await tx.movimientoBilletera.findFirst({
            where: { reservaId, tipo: 'reembolso_reserva' },
          });
          const comp = await tx.movimientoBilletera.findFirst({
            where: { reservaId, tipo: 'compensacion_cancelacion' },
          });
          return {
            estado: 'cancelada',
            reembolso: {
              estado: (mov?.estado ?? 'pendiente') as EstadoMovimiento,
              montoPasajero: mov ? mov.monto.toFixed(2) : '0.00',
              montoConductor: comp ? comp.monto.toFixed(2) : '0.00',
              hashTx: mov?.hashTx ?? null,
              exploradorUrl: mov?.hashTx
                ? this.blockchain.cadena.exploradorTxUrl(mov.hashTx)
                : null,
            },
          };
        }
        throw new ErrorNegocio(
          409,
          'NO_CANCELABLE',
          'reservas.cancelar.no_cancelable',
        );
      }

      // Billetera del pasajero
      const billeteraPasajero = await tx.billetera.findUniqueOrThrow({
        where: { usuarioId },
      });

      // Movimiento de reembolso en la billetera del pasajero
      const movPasajero = await tx.movimientoBilletera.create({
        data: {
          billeteraId: billeteraPasajero.id,
          tipo: 'reembolso_reserva',
          monto: politica.montoPasajero,
          estado: 'pendiente',
          reservaId,
          claveIdempotencia: `reembolso:${reservaId}`,
          metadatos: {
            porcentajePasajeroBps: politica.porcentajePasajeroBps,
            montoConductor: politica.montoConductor.toFixed(2),
            motivo: 'cancelada_pasajero',
          },
        },
      });

      // Si rige el 50 % (D-18), movimiento de compensación al conductor
      if (politica.porcentajePasajero === 50) {
        const billeteraConductor = await tx.billetera.findUniqueOrThrow({
          where: { usuarioId: reservaPrevia.viaje.conductorId },
        });
        await tx.movimientoBilletera.create({
          data: {
            billeteraId: billeteraConductor.id,
            tipo: 'compensacion_cancelacion',
            monto: politica.montoConductor,
            estado: 'pendiente',
            reservaId,
            claveIdempotencia: `compensacion:${reservaId}`,
            metadatos: {
              porcentajePasajeroBps: politica.porcentajePasajeroBps,
              motivo: 'cancelada_pasajero',
            },
          },
        });
      }

      // Trabajo onchain para la cuenta verificadora
      await tx.trabajoOnchain.create({
        data: {
          movimientoId: movPasajero.id,
          operacion: 'reembolsar_reserva',
          estado: 'pendiente',
        },
      });

      // Liberar asiento si el viaje aún no salió (RN-8)
      if (ahora < reservaPrevia.viaje.fechaHoraSalida) {
        await tx.$executeRaw`
          UPDATE viajes
          SET cupos_disponibles = LEAST(cupos_disponibles + 1, cupos_totales)
          WHERE id = ${reservaPrevia.viaje.id}::uuid
        `;
      }

      // PB-09: aviso al conductor.
      await this.push.encolar(
        tx,
        reservaPrevia.viaje.conductorId,
        'reserva_cancelada',
        {
          pasajero: reservaPrevia.pasajero.nombreCompleto.trim().split(' ')[0],
          destino: reservaPrevia.viaje.destinoNombre,
          ruta: `/viajes/${reservaPrevia.viaje.id}`,
        },
      );

      // Auditoría
      await this.auditoria.registrar(
        {
          accion: 'reserva.cancelada',
          entidad: 'reserva',
          entidadId: reservaId,
          resultado: 'ok',
          actorId: usuarioId,
          organizacionId,
          detalle: {
            porcentajePasajero: politica.porcentajePasajero,
            montoPasajero: politica.montoPasajero.toFixed(2),
            montoConductor: politica.montoConductor.toFixed(2),
            motivo: 'cancelada_pasajero',
          },
        },
        tx,
      );

      return {
        estado: 'cancelada',
        reembolso: {
          estado: 'pendiente',
          montoPasajero: politica.montoPasajero.toFixed(2),
          montoConductor: politica.montoConductor.toFixed(2),
          hashTx: null,
          exploradorUrl: null,
        },
      };
    });
  }

  /**
   * HU-20 CA-5, RN-4: Cancelación del viaje por el conductor.
   * Cancela el viaje y todas sus reservas confirmadas con reembolso al 100 %.
   */
  async cancelarViaje(
    usuarioId: string,
    organizacionId: string,
    viajeId: string,
  ): Promise<ViajeCanceladoResultadoDto> {
    return await this.prisma.enOrganizacion(organizacionId, async (tx) => {
      const viaje = await tx.viaje.findFirst({
        where: { id: viajeId, organizacionId },
        select: {
          id: true,
          conductorId: true,
          estado: true,
          fechaHoraSalida: true,
          destinoNombre: true,
        },
      });

      // A-13: si no existe o no le pertenece, responde 404
      if (!viaje || viaje.conductorId !== usuarioId) {
        throw new ErrorNegocio(
          404,
          'VIAJE_NO_ENCONTRADO',
          'viajes.detalle.no_encontrado',
        );
      }

      // Idempotencia: si ya está cancelado
      if (viaje.estado === EstadoViaje.cancelado) {
        return { estado: 'cancelado', reservasCanceladas: 0 };
      }

      // CA-11: solo publicado o reservado
      if (
        viaje.estado !== EstadoViaje.publicado &&
        viaje.estado !== EstadoViaje.reservado
      ) {
        throw new ErrorNegocio(
          409,
          'NO_CANCELABLE',
          'viajes.cancelar.no_cancelable',
        );
      }

      // 1) Leer reservas confirmadas y actualizarlas a cancelada antes del candado del viaje
      const reservasConfirmadas = await tx.reserva.findMany({
        where: { viajeId, estado: 'confirmada' },
        select: {
          id: true,
          monto: true,
          pasajeroId: true,
          pasajero: { select: { nombreCompleto: true, correo: true } },
        },
      });

      if (reservasConfirmadas.length > 0) {
        await tx.reserva.updateMany({
          where: { viajeId, estado: 'confirmada' },
          data: { estado: 'cancelada', motivo: 'cancelada_conductor' },
        });
      }

      // 2) Pasar el viaje a cancelado con EstadoViajeService (bloquea el viaje y valida que nadie abordó)
      const cancelado = await this.estadoViaje.cancelar(tx, viajeId);
      if (!cancelado) {
        throw new ErrorNegocio(
          409,
          'NO_CANCELABLE',
          'viajes.cancelar.no_cancelable',
        );
      }

      // 3) Reembolsos y avisos por correo a los pasajeros
      if (reservasConfirmadas.length > 0) {
        const pasajeroIds = reservasConfirmadas.map((r) => r.pasajeroId);
        const billeteras = await tx.billetera.findMany({
          where: { usuarioId: { in: pasajeroIds } },
        });
        const billeterasPorUsuario = new Map(
          billeteras.map((b) => [b.usuarioId, b.id]),
        );

        for (const r of reservasConfirmadas) {
          const billeteraId = billeterasPorUsuario.get(r.pasajeroId);
          if (!billeteraId) continue;
          const mov = await tx.movimientoBilletera.create({
            data: {
              billeteraId,
              tipo: 'reembolso_reserva',
              monto: r.monto,
              estado: 'pendiente',
              reservaId: r.id,
              claveIdempotencia: `reembolso:${r.id}`,
              metadatos: {
                porcentajePasajeroBps: 10_000,
                montoConductor: '0.00',
                motivo: 'cancelada_conductor',
              },
            },
          });
          await tx.trabajoOnchain.create({
            data: {
              movimientoId: mov.id,
              operacion: 'reembolsar_reserva',
              estado: 'pendiente',
            },
          });
          await this.correos.encolar(tx, {
            destinatario: r.pasajero.correo,
            plantilla: 'viaje_cancelado',
            datos: {
              nombre: r.pasajero.nombreCompleto.trim().split(' ')[0],
              fecha: viaje.fechaHoraSalida.toISOString(),
              monto: r.monto.toFixed(2),
            },
          });
          await this.push.encolar(tx, r.pasajeroId, 'viaje_cancelado', {
            destino: viaje.destinoNombre,
            monto: r.monto.toFixed(2),
            ruta: `/reserva/${r.id}`,
          });
          await this.auditoria.registrar(
            {
              accion: 'reserva.cancelada',
              entidad: 'reserva',
              entidadId: r.id,
              resultado: 'ok',
              actorId: usuarioId,
              organizacionId,
              detalle: {
                porcentajePasajero: 100,
                montoPasajero: r.monto.toFixed(2),
                montoConductor: '0.00',
                motivo: 'cancelada_conductor',
              },
            },
            tx,
          );
        }
      }

      // 4) Auditoría del viaje
      await this.auditoria.registrar(
        {
          accion: 'viaje.cancelado',
          entidad: 'viaje',
          entidadId: viajeId,
          resultado: 'ok',
          actorId: usuarioId,
          organizacionId,
          detalle: { reservasCanceladas: reservasConfirmadas.length },
        },
        tx,
      );

      return {
        estado: 'cancelado',
        reservasCanceladas: reservasConfirmadas.length,
      };
    });
  }
}
