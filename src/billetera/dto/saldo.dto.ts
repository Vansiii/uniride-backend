import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export const TIPOS_MOVIMIENTO = [
  'recarga',
  'bloqueo_reserva',
  'liberacion_viaje',
  'reembolso_reserva',
] as const;
export type TipoMovimiento = (typeof TIPOS_MOVIMIENTO)[number];

export const ESTADOS_MOVIMIENTO = [
  'pendiente',
  'confirmado',
  'fallido',
] as const;
export type EstadoMovimiento = (typeof ESTADOS_MOVIMIENTO)[number];

export class SaldoDto {
  @ApiProperty({
    example: '150.00',
    description: 'Disponible más bloqueado en garantía.',
  })
  saldoTotal!: string;

  @ApiProperty({
    example: '135.00',
    description:
      '`balanceOf` del contrato; con `enLinea: false`, el saldo contable de los movimientos confirmados.',
  })
  saldoDisponible!: string;

  @ApiProperty({
    example: '15.00',
    description:
      'Bloqueos confirmados cuya reserva aún no tiene liberación ni reembolso confirmados.',
  })
  saldoBloqueadoEscrow!: string;

  @ApiProperty({ example: 'URC' })
  moneda!: 'URC';

  @ApiProperty({
    example: true,
    description:
      '`false` si el nodo falló o no respondió a tiempo: la app avisa `billetera.saldo.sincronizacion_pendiente`.',
  })
  enLinea!: boolean;
}

export class ConsultaMovimientosDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 100000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  pagina: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limite: number = 20;

  @ApiPropertyOptional({
    type: String,
    example: 'recarga,reembolso_reserva',
    description: `Uno o varios separados por coma: ${TIPOS_MOVIMIENTO.join(', ')}.`,
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',') : value,
  )
  @IsIn(TIPOS_MOVIMIENTO, { each: true })
  tipo?: TipoMovimiento[];
}

export class MovimientoDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: TIPOS_MOVIMIENTO })
  tipo!: TipoMovimiento;

  @ApiProperty({ example: '15.00' })
  monto!: string;

  @ApiProperty({
    enum: ESTADOS_MOVIMIENTO,
    description: '`pendiente`: la transacción aún se está minando (CA-3).',
  })
  estado!: EstadoMovimiento;

  @ApiProperty({
    type: String,
    nullable: true,
    example:
      '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060',
  })
  hashTx!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example:
      'https://amoy.polygonscan.com/tx/0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060',
    description:
      'Polygonscan en Amoy; `null` sin hash o en una cadena sin explorador (Hardhat o simulada).',
  })
  exploradorUrl!: string | null;

  @ApiProperty()
  creadoEn!: Date;
}

export class PaginaMovimientosDto {
  @ApiProperty({
    type: [MovimientoDto],
    description: 'Del más reciente al más antiguo.',
  })
  items!: MovimientoDto[];

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 1 })
  pagina!: number;

  @ApiProperty({ example: 3, description: '0 si no hay movimientos.' })
  paginas!: number;
}
