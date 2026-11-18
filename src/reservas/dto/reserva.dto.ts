import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsUUID } from 'class-validator';
import { EstadoViaje } from '../../generated/prisma/client.js';
import {
  ESTADOS_MOVIMIENTO,
  type EstadoMovimiento,
} from '../../billetera/dto/saldo.dto.js';

/** RN-10 (D-23, HU-20). */
export const ESTADOS_RESERVA = [
  'pendiente',
  'confirmada',
  'abordada',
  'verificada',
  'pagada',
  'fallida',
  'verificacion_fallida',
  'cancelada',
  'expirada',
] as const;
export type EstadoReserva = (typeof ESTADOS_RESERVA)[number];

export class CancelarReservaDto {
  @ApiProperty({
    example: 100,
    description:
      'Porcentaje que mostró la vista previa (100 o 50). Si rige menos al confirmar, responde 409.',
  })
  @IsIn([100, 50])
  porcentajeEsperado!: 100 | 50;
}

/**
 * Solo la clave de idempotencia: el monto, el conductor y el estado los fija el servidor (CA-7). Con `whitelist` y
 * `forbidNonWhitelisted`, cualquier otro campo da 400.
 */
export class ReservarDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'La app la genera al abrir la confirmación. Repetirla devuelve la reserva original (CA-4).',
  })
  @IsUUID()
  claveIdempotencia!: string;
}

export class ReservaCreadaDto {
  @ApiProperty({ format: 'uuid' })
  reservaId!: string;
  @ApiProperty({ enum: ESTADOS_RESERVA, example: 'pendiente' })
  estado!: EstadoReserva;
  @ApiProperty({ example: '10.50', description: 'URC con 2 decimales.' })
  monto!: string;
  @ApiProperty({ format: 'uuid' })
  viajeId!: string;
}

class ViajeDeReservaDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty()
  origenNombre!: string;
  @ApiProperty()
  destinoNombre!: string;
  @ApiProperty({ type: String, format: 'date-time' })
  fechaHoraSalida!: Date;
  @ApiProperty({ enum: EstadoViaje })
  estado!: EstadoViaje;
  @ApiProperty({ description: 'Nombre de pila del conductor.' })
  conductor!: string;
}

export class ReservaDto {
  @ApiProperty({ format: 'uuid' })
  reservaId!: string;
  @ApiProperty({ enum: ESTADOS_RESERVA })
  estado!: EstadoReserva;
  @ApiProperty({ example: '10.50', description: 'URC con 2 decimales.' })
  monto!: string;
  @ApiProperty({ type: String, format: 'date-time' })
  creadoEn!: Date;
  @ApiProperty({ type: ViajeDeReservaDto })
  viaje!: ViajeDeReservaDto;
}

/** HU-24 CA-1: el pago al conductor de esta reserva. */
export class PagoReservaDto {
  @ApiProperty({
    enum: ESTADOS_MOVIMIENTO,
    description:
      '`pendiente` mientras la red registra la liberación; `confirmado` con su hash.',
  })
  estado!: EstadoMovimiento;
  @ApiProperty({ example: '10.50', description: 'URC con 2 decimales.' })
  monto!: string;
  @ApiProperty({ type: String, nullable: true })
  hashTx!: string | null;
  @ApiProperty({ type: String, nullable: true })
  exploradorUrl!: string | null;
}

/** HU-20 CA-1: vista previa de la cancelación para el pasajero. */
export class CancelacionVistaPreviaDto {
  @ApiProperty()
  cancelable!: boolean;
  @ApiProperty({ example: 100 })
  porcentajePasajero!: 100 | 50;
  @ApiProperty({ example: '10.50' })
  montoPasajero!: string;
  @ApiProperty({ example: '0.00' })
  montoConductor!: string;
  @ApiProperty({ nullable: true, required: false })
  motivo?: string;
}

/** HU-20: datos del reembolso de una reserva cancelada o expirada. */
export class ReembolsoReservaDto {
  @ApiProperty({
    enum: ESTADOS_MOVIMIENTO,
    description:
      '`pendiente` mientras la red registra el reembolso; `confirmado` con su hash.',
  })
  estado!: EstadoMovimiento;
  @ApiProperty({ example: '10.50' })
  montoPasajero!: string;
  @ApiProperty({ example: '0.00' })
  montoConductor!: string;
  @ApiProperty({ type: String, nullable: true })
  hashTx!: string | null;
  @ApiProperty({ type: String, nullable: true })
  exploradorUrl!: string | null;
}

export class ReservaCanceladaResultadoDto {
  @ApiProperty({ example: 'cancelada' })
  estado!: 'cancelada';
  @ApiProperty({ type: ReembolsoReservaDto })
  reembolso!: ReembolsoReservaDto;
}

export class ViajeCanceladoResultadoDto {
  @ApiProperty({ example: 'cancelado' })
  estado!: 'cancelado';
  @ApiProperty({
    example: 2,
    description:
      'Cantidad de reservas confirmadas que fueron canceladas y reembolsadas.',
  })
  reservasCanceladas!: number;
}

export class ReservaDetalleDto extends ReservaDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Transacción del bloqueo en garantía; solo para el pasajero y `null` mientras esté pendiente.',
  })
  hashTx!: string | null;
  @ApiProperty({ type: String, nullable: true })
  exploradorUrl!: string | null;
  @ApiProperty({
    type: PagoReservaDto,
    nullable: true,
    description:
      'Liberación al conductor (HU-24), para el pasajero y el conductor; `null` hasta que la reserva quede verificada.',
  })
  pago!: PagoReservaDto | null;
  @ApiProperty({
    type: CancelacionVistaPreviaDto,
    nullable: true,
    description:
      'Vista previa de la política de cancelación (HU-20); solo para el pasajero.',
  })
  cancelacion!: CancelacionVistaPreviaDto | null;
  @ApiProperty({
    type: ReembolsoReservaDto,
    nullable: true,
    description:
      'Reembolso por cancelación o expiración (HU-20); `null` si no fue cancelada o expirada.',
  })
  reembolso!: ReembolsoReservaDto | null;
}

export class MisReservasDto {
  @ApiProperty({
    type: ReservaDto,
    isArray: true,
    description: 'Las activas primero.',
  })
  reservas!: ReservaDto[];
}
