import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { EstadoViaje } from '../../generated/prisma/client.js';
import {
  ESTADOS_MOVIMIENTO,
  type EstadoMovimiento,
} from '../../billetera/dto/saldo.dto.js';

/** RN-10 (D-23). HU-20 agrega `cancelada` y `expirada`. */
export const ESTADOS_RESERVA = [
  'pendiente',
  'confirmada',
  'abordada',
  'verificada',
  'pagada',
  'fallida',
  'verificacion_fallida',
] as const;
export type EstadoReserva = (typeof ESTADOS_RESERVA)[number];

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
}

export class MisReservasDto {
  @ApiProperty({
    type: ReservaDto,
    isArray: true,
    description: 'Las activas primero.',
  })
  reservas!: ReservaDto[];
}
