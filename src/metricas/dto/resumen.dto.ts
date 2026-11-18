import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export const PERIODOS = ['7d', '30d', 'todo'] as const;
export type Periodo = (typeof PERIODOS)[number];

export class FiltroResumenDto {
  @ApiPropertyOptional({ enum: PERIODOS, default: '30d' })
  @IsOptional()
  @IsIn(PERIODOS)
  periodo: Periodo = '30d';
}

export class ResumenDto {
  @ApiProperty({ enum: PERIODOS }) periodo!: Periodo;
  @ApiProperty() viajesPagados!: number;
  @ApiProperty() miembrosActivos!: number;
  @ApiProperty() pasajeros!: number;
  @ApiProperty({ description: 'Estimado: distancia en línea recta × 0,12.' })
  co2Kg!: number;
}
