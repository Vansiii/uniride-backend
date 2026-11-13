import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import {
  BlockchainService,
  formatearUrc,
  urcAUnidades,
} from '../blockchain/blockchain.service.js';
import { BilleteraService } from '../billetera/billetera.service.js';
import { MovimientosService } from '../billetera/movimientos.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService } from '../comun/prisma.service.js';
import { EstadoViaje, Prisma } from '../generated/prisma/client.js';
import type {
  EstadoReserva,
  MisReservasDto,
  ReservaCreadaDto,
  ReservaDetalleDto,
  ReservaDto,
} from './dto/reserva.dto.js';

/** RN-11 (D-25): con este paso el reparto 50/50 de HU-20 da centavos exactos. */
const PASO_PRECIO = new Prisma.Decimal('0.02');
/** Mientras el viaje no salió ni se canceló, admite reservas (RN-3). */
const ESTADOS_RESERVABLES: EstadoViaje[] = [
  EstadoViaje.publicado,
  EstadoViaje.reservado,
];
/** Una reserva que aún cuenta para el pasajero en «Mis viajes». */
const ESTADOS_ACTIVOS: EstadoReserva[] = [
  'pendiente',
  'confirmada',
  'abordada',
];
// ponytail: tope fijo sin paginar, como `mis-viajes`; paginar cuando un pasajero pueda acumular más.
const MAXIMO_MIS_RESERVAS = 100;

const nombreDePila = (nombreCompleto: string) =>
  nombreCompleto.trim().split(/\s+/)[0];

const noEncontrada = () =>
  new ErrorNegocio(404, 'RESERVA_NO_ENCONTRADA', 'comun.errores.no_encontrado');
const conflicto = (codigo: string, clave: string, extra = {}) =>
  new ErrorNegocio(409, codigo, clave, extra);

const SELECCION_VIAJE = {
  id: true,
  origenNombre: true,
  destinoNombre: true,
  fechaHoraSalida: true,
  estado: true,
  conductor: { select: { nombreCompleto: true } },
} as const;

interface FilaReserva {
  id: string;
  estado: string;
  monto: Prisma.Decimal;
  creadoEn: Date;
  viaje: {
    id: string;
    origenNombre: string;
    destinoNombre: string;
    fechaHoraSalida: Date;
    estado: EstadoViaje;
    conductor: { nombreCompleto: string };
  };
}

const aDto = (r: FilaReserva): ReservaDto => ({
  reservaId: r.id,
  estado: r.estado as EstadoReserva,
  monto: r.monto.toFixed(2),
  creadoEn: r.creadoEn,
  viaje: {
    id: r.viaje.id,
    origenNombre: r.viaje.origenNombre,
    destinoNombre: r.viaje.destinoNombre,
    fechaHoraSalida: r.viaje.fechaHoraSalida,
    estado: r.viaje.estado,
    conductor: nombreDePila(r.viaje.conductor.nombreCompleto),
  },
});

@Injectable()
export class ReservasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billeteras: BilleteraService,
    private readonly movimientos: MovimientosService,
    private readonly auditoria: AuditoriaService,
    private readonly blockchain: BlockchainService,
  ) {}

  /**
   * Una sola transacción, sin esperar a la cadena (CA-12): reserva `pendiente`, asiento retenido, bloqueo en el libro y
   * su trabajo en la cola. El monto y el conductor salen del viaje, nunca de la petición (CA-7).
   * `creada` es `false` si la clave ya tenía su reserva (CA-4).
   */
  async reservar(
    pasajeroId: string,
    organizacionId: string,
    viajeId: string,
    claveIdempotencia: string,
  ): Promise<{ reserva: ReservaCreadaDto; creada: boolean }> {
    const billetera = await this.billeteras.exigir(pasajeroId);
    try {
      return await this.prisma.enOrganizacion(organizacionId, async (tx) => {
        // Serializa las reservas de la misma persona: dos a la vez no gastan el mismo saldo (CA-5) ni se duplican (CA-4).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`reserva:${pasajeroId}`}, 0))`;

        const previa = await tx.reserva.findUnique({
          where: { claveIdempotencia },
        });
        if (previa) {
          if (previa.pasajeroId !== pasajeroId || previa.viajeId !== viajeId)
            throw conflicto(
              'CLAVE_IDEMPOTENCIA_EN_CONFLICTO',
              'billetera.movimiento.clave_en_conflicto',
            );
          return {
            reserva: {
              reservaId: previa.id,
              estado: previa.estado as EstadoReserva,
              monto: previa.monto.toFixed(2),
              viajeId: previa.viajeId,
            },
            creada: false,
          };
        }

        // Un viaje de otra organización responde igual que uno que no existe (CA-8).
        const viaje = await tx.viaje.findFirst({
          where: { id: viajeId, organizacionId },
          select: {
            conductorId: true,
            estado: true,
            fechaHoraSalida: true,
            precioPorAsiento: true,
            conductor: { select: { suspendidaEn: true } },
          },
        });
        if (!viaje)
          throw new ErrorNegocio(
            404,
            'VIAJE_NO_ENCONTRADO',
            'viajes.detalle.no_encontrado',
          );
        if (viaje.conductorId === pasajeroId)
          throw conflicto('VIAJE_PROPIO', 'reservas.confirmar.viaje_propio');
        if (
          viaje.conductor.suspendidaEn ||
          !ESTADOS_RESERVABLES.includes(viaje.estado) ||
          viaje.fechaHoraSalida.getTime() <= Date.now() ||
          !viaje.precioPorAsiento.mod(PASO_PRECIO).isZero()
        )
          throw conflicto(
            'VIAJE_NO_DISPONIBLE',
            'reservas.confirmar.no_disponible',
          );
        const yaReservado = await tx.reserva.findFirst({
          where: { viajeId, pasajeroId, estado: { not: 'fallida' } },
          select: { id: true },
        });
        if (yaReservado)
          throw conflicto('YA_RESERVADO', 'reservas.confirmar.ya_reservado');
        const billeteraConductor = await tx.billetera.findUnique({
          where: { usuarioId: viaje.conductorId },
          select: { id: true },
        });
        if (!billeteraConductor)
          throw conflicto(
            'CONDUCTOR_SIN_BILLETERA',
            'reservas.confirmar.no_disponible',
          );

        // RN-4: el libro, sin leer la cadena; así funciona con el nodo caído. Los bloqueos pendientes ya cuentan.
        const monto = viaje.precioPorAsiento.toFixed(2);
        const precio = urcAUnidades(monto);
        const { contable, bloqueosPendientes } = await this.movimientos.resumen(
          billetera.id,
          tx,
        );
        const disponible = contable - bloqueosPendientes;
        if (disponible < precio)
          throw conflicto(
            'SALDO_INSUFICIENTE',
            'reservas.confirmar.saldo_insuficiente',
            {
              faltante: formatearUrc(
                precio - (disponible > 0n ? disponible : 0n),
              ),
            },
          );

        // El UPDATE condicional decide entre dos pasajeros que piden el último asiento (CA-3).
        const retenidos = await tx.$executeRaw`
          UPDATE viajes SET cupos_disponibles = cupos_disponibles - 1
          WHERE id = ${viajeId}::uuid AND cupos_disponibles > 0`;
        if (retenidos === 0)
          throw conflicto('SIN_ASIENTOS', 'reservas.confirmar.sin_asientos');

        const reserva = await tx.reserva.create({
          data: {
            organizacionId,
            viajeId,
            pasajeroId,
            monto,
            claveIdempotencia,
          },
        });
        const { movimiento } = await this.movimientos.registrar(
          {
            billeteraId: billetera.id,
            tipo: 'bloqueo_reserva',
            monto,
            claveIdempotencia: `reserva:${reserva.id}`,
            reservaId: reserva.id,
          },
          tx,
        );
        await tx.trabajoOnchain.create({
          data: { movimientoId: movimiento.id, operacion: 'bloquear_reserva' },
        });
        await this.auditoria.registrar(
          {
            accion: 'reserva.creada',
            entidad: 'reserva',
            entidadId: reserva.id,
            resultado: 'ok',
            actorId: pasajeroId,
            organizacionId,
            detalle: { viajeId, monto },
          },
          tx,
        );
        return {
          reserva: {
            reservaId: reserva.id,
            estado: 'pendiente',
            monto,
            viajeId,
          },
          creada: true,
        };
      });
    } catch (error) {
      // Una clave que ya usó una reserva de otra organización: RLS no la deja ver, pero el UNIQUE la rechaza.
      if ((error as { code?: string }).code === 'P2002')
        throw conflicto(
          'CLAVE_IDEMPOTENCIA_EN_CONFLICTO',
          'billetera.movimiento.clave_en_conflicto',
        );
      throw error;
    }
  }

  /** Solo el pasajero de la reserva o el conductor de su viaje; cualquier otra persona recibe 404 (A-13). */
  async detalle(
    usuarioId: string,
    organizacionId: string,
    reservaId: string,
  ): Promise<ReservaDetalleDto> {
    const reserva = await this.prisma.enOrganizacion(organizacionId, (tx) =>
      tx.reserva.findFirst({
        where: {
          id: reservaId,
          organizacionId,
          OR: [
            { pasajeroId: usuarioId },
            { viaje: { conductorId: usuarioId } },
          ],
        },
        select: {
          id: true,
          estado: true,
          monto: true,
          creadoEn: true,
          pasajeroId: true,
          viaje: { select: SELECCION_VIAJE },
        },
      }),
    );
    if (!reserva) throw noEncontrada();
    // La transacción del bloqueo es del libro del pasajero: el conductor no la necesita.
    const hashTx =
      reserva.pasajeroId === usuarioId
        ? ((
            await this.prisma.movimientoBilletera.findFirst({
              where: { reservaId, tipo: 'bloqueo_reserva' },
              select: { hashTx: true },
            })
          )?.hashTx ?? null)
        : null;
    return {
      ...aDto(reserva),
      hashTx,
      exploradorUrl: hashTx
        ? this.blockchain.cadena.exploradorTxUrl(hashTx)
        : null,
    };
  }

  /** Son las reservas de la persona, en todas sus organizaciones: siempre filtradas por pasajero (como `mis-viajes`). */
  async mias(pasajeroId: string): Promise<MisReservasDto> {
    const filas = await this.prisma.comoSuperAdmin((tx) =>
      tx.reserva.findMany({
        where: { pasajeroId },
        orderBy: { creadoEn: 'desc' },
        take: MAXIMO_MIS_RESERVAS,
        select: {
          id: true,
          estado: true,
          monto: true,
          creadoEn: true,
          viaje: { select: SELECCION_VIAJE },
        },
      }),
    );
    const reservas = filas.map(aDto);
    const activa = (r: ReservaDto) => ESTADOS_ACTIVOS.includes(r.estado);
    return {
      reservas: [
        ...reservas.filter(activa),
        ...reservas.filter((r) => !activa(r)),
      ],
    };
  }
}
