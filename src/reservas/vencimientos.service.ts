import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { PrismaService } from '../comun/prisma.service.js';
import { EstadoViaje } from '../generated/prisma/client.js';
import { CorreosService } from '../notificaciones/correos.service.js';
import { EstadoViajeService } from '../viajes/estado-viaje.service.js';

export interface ResumenVencimientos {
  reservasExpiradas: number;
  reservasCanceladasPorViaje: number;
  viajesExpirados: number;
  reembolsosFallidos: number;
}

/**
 * HU-20 CA-6..CA-9, CA-19, RN-5, RN-11 (D-29):
 * Tic de vencimientos y expiración en segundo plano.
 *
 * 1. Expiración de reservas confirmadas sin abordar pasados 15 min de la salida (100 % al pasajero).
 * 2. Expiración de viajes publicados o reservados pasados 15 min sin abordajes.
 * 3. Reservas confirmadas con viaje cancelado o expirado (CA-19: confirmadas tras resolver bloqueo pendiente).
 * 4. Reembolso del 100 % al pasajero en reservas con verificación fallida tras 24 h sin resolución.
 */
@Injectable()
export class VencimientosService implements OnModuleInit, OnModuleDestroy {
  private readonly registro = new Logger(VencimientosService.name);
  private temporizador?: NodeJS.Timeout;
  private ocupado = false;
  private readonly intervaloMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly estadoViaje: EstadoViajeService,
    private readonly correos: CorreosService,
  ) {
    this.intervaloMs = process.env.VENCIMIENTOS_INTERVALO_MS
      ? parseInt(process.env.VENCIMIENTOS_INTERVALO_MS, 10)
      : 30_000;
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.temporizador = setInterval(() => void this.tic(), this.intervaloMs);
  }

  onModuleDestroy(): void {
    if (this.temporizador) {
      clearInterval(this.temporizador);
    }
  }

  private async tic(): Promise<void> {
    if (this.ocupado) return;
    this.ocupado = true;
    try {
      await this.procesarVencimientos();
    } catch (error) {
      this.registro.error('Error en tic de vencimientos', error);
    } finally {
      this.ocupado = false;
    }
  }

  /**
   * Ejecuta el ciclo completo de vencimientos. Se puede invocar a mano con una fecha arbitraria en pruebas.
   */
  async procesarVencimientos(
    ahora: Date = new Date(),
  ): Promise<ResumenVencimientos> {
    const resumen: ResumenVencimientos = {
      reservasExpiradas: 0,
      reservasCanceladasPorViaje: 0,
      viajesExpirados: 0,
      reembolsosFallidos: 0,
    };

    // 1. Expiración de reservas confirmadas sin abordar pasados 15 min de la salida
    resumen.reservasExpiradas = await this.expirarReservasSinAbordaje(ahora);

    // 2. Reservas confirmadas de viajes cancelados o expirados (CA-19)
    resumen.reservasCanceladasPorViaje =
      await this.resolverReservasDeViajesCanceladosOExpirados();

    // 3. Expiración de viajes pasados 15 min de la salida sin reservas activas
    resumen.viajesExpirados = await this.expirarViajes(ahora);

    // 4. Reembolso del 100 % en reservas con verificación fallida pasadas 24 h
    resumen.reembolsosFallidos =
      await this.reembolsarVerificacionesFallidas(ahora);

    return resumen;
  }

  /**
   * HU-20 CA-6, CA-8, RN-5:
   * Al cumplirse 15 min tras la salida, toda reserva confirmada sin abordar pasa a expirada
   * y se reembolsa el 100 % al pasajero.
   */
  private async expirarReservasSinAbordaje(ahora: Date): Promise<number> {
    const limite15m = new Date(ahora.getTime() - 15 * 60 * 1000);

    const candidatas = await this.prisma.comoSuperAdmin((tx) =>
      tx.reserva.findMany({
        where: {
          estado: 'confirmada',
          viaje: {
            fechaHoraSalida: { lte: limite15m },
          },
        },
        select: {
          id: true,
          monto: true,
          pasajeroId: true,
          organizacionId: true,
          viajeId: true,
        },
      }),
    );

    let procesadas = 0;
    for (const r of candidatas) {
      try {
        const expirada = await this.prisma.comoSuperAdmin(async (tx) => {
          const { count } = await tx.reserva.updateMany({
            where: { id: r.id, estado: 'confirmada' },
            data: { estado: 'expirada', motivo: 'expirada_sin_abordaje' },
          });

          if (count === 0) return false;

          const billetera = await tx.billetera.findUniqueOrThrow({
            where: { usuarioId: r.pasajeroId },
          });

          const mov = await tx.movimientoBilletera.create({
            data: {
              billeteraId: billetera.id,
              tipo: 'reembolso_reserva',
              monto: r.monto,
              estado: 'pendiente',
              reservaId: r.id,
              claveIdempotencia: `reembolso:${r.id}`,
              metadatos: {
                porcentajePasajeroBps: 10_000,
                montoConductor: '0.00',
                motivo: 'expirada_sin_abordaje',
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

          await this.auditoria.registrar(
            {
              accion: 'reserva.expirada',
              entidad: 'reserva',
              entidadId: r.id,
              resultado: 'ok',
              organizacionId: r.organizacionId,
              detalle: {
                porcentajePasajero: 100,
                montoPasajero: r.monto.toFixed(2),
                montoConductor: '0.00',
                motivo: 'expirada_sin_abordaje',
              },
            },
            tx,
          );

          return true;
        });

        if (expirada) procesadas++;
      } catch (err) {
        this.registro.error(
          `Error al expirar reserva ${r.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    return procesadas;
  }

  /**
   * HU-20 CA-19:
   * Si una reserva estaba pendiente cuando el viaje se canceló o expiró, y su bloqueo
   * se confirmó después en la cadena, debe cancelarse o expirar con el 100 % de reembolso al pasajero.
   */
  private async resolverReservasDeViajesCanceladosOExpirados(): Promise<number> {
    const candidatas = await this.prisma.comoSuperAdmin((tx) =>
      tx.reserva.findMany({
        where: {
          estado: 'confirmada',
          viaje: {
            estado: { in: [EstadoViaje.cancelado, EstadoViaje.expirado] },
          },
        },
        select: {
          id: true,
          monto: true,
          pasajeroId: true,
          organizacionId: true,
          pasajero: { select: { nombreCompleto: true, correo: true } },
          viaje: { select: { estado: true, fechaHoraSalida: true } },
        },
      }),
    );

    let procesadas = 0;
    for (const r of candidatas) {
      try {
        const esCancelado = r.viaje.estado === EstadoViaje.cancelado;
        const nuevoEstado = esCancelado ? 'cancelada' : 'expirada';
        const motivo = esCancelado
          ? 'cancelada_conductor'
          : 'expirada_sin_abordaje';
        const accionAuditoria = esCancelado
          ? 'reserva.cancelada'
          : 'reserva.expirada';

        const resuelta = await this.prisma.comoSuperAdmin(async (tx) => {
          const { count } = await tx.reserva.updateMany({
            where: { id: r.id, estado: 'confirmada' },
            data: { estado: nuevoEstado, motivo },
          });

          if (count === 0) return false;

          const billetera = await tx.billetera.findUniqueOrThrow({
            where: { usuarioId: r.pasajeroId },
          });

          const mov = await tx.movimientoBilletera.create({
            data: {
              billeteraId: billetera.id,
              tipo: 'reembolso_reserva',
              monto: r.monto,
              estado: 'pendiente',
              reservaId: r.id,
              claveIdempotencia: `reembolso:${r.id}`,
              metadatos: {
                porcentajePasajeroBps: 10_000,
                montoConductor: '0.00',
                motivo,
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

          if (esCancelado) {
            await this.correos.encolar(tx, {
              destinatario: r.pasajero.correo,
              plantilla: 'viaje_cancelado',
              datos: {
                nombre: r.pasajero.nombreCompleto.trim().split(' ')[0],
                fecha: r.viaje.fechaHoraSalida.toISOString(),
                monto: r.monto.toFixed(2),
              },
            });
          }

          await this.auditoria.registrar(
            {
              accion: accionAuditoria,
              entidad: 'reserva',
              entidadId: r.id,
              resultado: 'ok',
              organizacionId: r.organizacionId,
              detalle: {
                porcentajePasajero: 100,
                montoPasajero: r.monto.toFixed(2),
                montoConductor: '0.00',
                motivo,
              },
            },
            tx,
          );

          return true;
        });

        if (resuelta) procesadas++;
      } catch (err) {
        this.registro.error(
          `Error al resolver reserva ${r.id} de viaje cancelado/expirado`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    return procesadas;
  }

  /**
   * HU-20 CA-6, CA-7, RN-5:
   * Al cumplirse 15 min tras la salida, un viaje publicado o reservado sin reservas activas
   * (o con todas expiradas/canceladas) pasa a expirado.
   */
  private async expirarViajes(ahora: Date): Promise<number> {
    const limite15m = new Date(ahora.getTime() - 15 * 60 * 1000);

    const viajes = await this.prisma.comoSuperAdmin((tx) =>
      tx.viaje.findMany({
        where: {
          estado: { in: [EstadoViaje.publicado, EstadoViaje.reservado] },
          fechaHoraSalida: { lte: limite15m },
        },
        select: {
          id: true,
          organizacionId: true,
        },
      }),
    );

    let procesados = 0;
    for (const v of viajes) {
      try {
        const expirado = await this.prisma.comoSuperAdmin(async (tx) => {
          const resultado = await this.estadoViaje.expirar(tx, v.id);
          if (!resultado) return false;

          await this.auditoria.registrar(
            {
              accion: 'viaje.expirado',
              entidad: 'viaje',
              entidadId: v.id,
              resultado: 'ok',
              organizacionId: v.organizacionId,
              detalle: { motivo: 'expiracion_15m' },
            },
            tx,
          );

          return true;
        });

        if (expirado) procesados++;
      } catch (err) {
        this.registro.error(
          `Error al expirar viaje ${v.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    return procesados;
  }

  /**
   * HU-20 CA-9, RN-11, D-29:
   * Una reserva en verificación fallida, tras 24 h sin resolución, devuelve el 100 % al pasajero.
   * La reserva sigue en 'verificacion_fallida' y muestra el reembolso.
   */
  private async reembolsarVerificacionesFallidas(ahora: Date): Promise<number> {
    const limite24h = new Date(ahora.getTime() - 24 * 60 * 60 * 1000);

    const candidatas = await this.prisma.comoSuperAdmin((tx) =>
      tx.reserva.findMany({
        where: {
          estado: 'verificacion_fallida',
          actualizadoEn: { lte: limite24h },
        },
        select: {
          id: true,
          monto: true,
          pasajeroId: true,
          organizacionId: true,
        },
      }),
    );

    let procesadas = 0;
    for (const r of candidatas) {
      try {
        const reembolsada = await this.prisma.comoSuperAdmin(async (tx) => {
          // Idempotencia: comprobar si ya tiene movimiento de reembolso
          const yaReembolsada = await tx.movimientoBilletera.findFirst({
            where: {
              reservaId: r.id,
              tipo: 'reembolso_reserva',
            },
          });

          if (yaReembolsada) return false;

          const billetera = await tx.billetera.findUniqueOrThrow({
            where: { usuarioId: r.pasajeroId },
          });

          const mov = await tx.movimientoBilletera.create({
            data: {
              billeteraId: billetera.id,
              tipo: 'reembolso_reserva',
              monto: r.monto,
              estado: 'pendiente',
              reservaId: r.id,
              claveIdempotencia: `reembolso:${r.id}`,
              metadatos: {
                porcentajePasajeroBps: 10_000,
                montoConductor: '0.00',
                motivo: 'verificacion_fallida_24h',
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

          await this.auditoria.registrar(
            {
              accion: 'reserva.reembolsada_fallida',
              entidad: 'reserva',
              entidadId: r.id,
              resultado: 'ok',
              organizacionId: r.organizacionId,
              detalle: {
                porcentajePasajero: 100,
                montoPasajero: r.monto.toFixed(2),
                motivo: 'verificacion_fallida_24h',
              },
            },
            tx,
          );

          return true;
        });

        if (reembolsada) procesadas++;
      } catch (err) {
        this.registro.error(
          `Error al reembolsar verificacion fallida ${r.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    return procesadas;
  }
}
