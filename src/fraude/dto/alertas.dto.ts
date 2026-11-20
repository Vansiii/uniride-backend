import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { RIESGOS, type Riesgo } from '../analisis-riesgo.js';
import { PATRONES, type Patron } from '../patrones.js';

export class FiltroAlertasDto {
  @ApiPropertyOptional({ enum: PATRONES, description: 'CA-5: un solo patrón' })
  @IsOptional()
  @IsIn(PATRONES)
  patron?: Patron;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limite = 20;

  @ApiPropertyOptional({
    description: 'Cursor: solo alertas anteriores a esta fecha (`siguiente`).',
  })
  @IsOptional()
  @IsDateString()
  antes?: string;
}

export class PersonaAlertaDto {
  @ApiProperty({ description: 'Solo el nombre: nunca correo ni documento.' })
  nombre!: string;
  @ApiProperty({ enum: ['conductor', 'pasajero'] })
  rol!: 'conductor' | 'pasajero';
}

/** PB-10: sugerencia de IA; la decisión es del administrador (RN-9). */
export class AnalisisIaDto {
  @ApiProperty({ enum: RIESGOS }) riesgo!: Riesgo;
  @ApiProperty({ minimum: 0, maximum: 100 }) puntaje!: number;
  @ApiProperty({ type: [String], description: '1 a 3 motivos' })
  motivos!: string[];
  @ApiProperty() recomendacion!: string;
  @ApiProperty({
    enum: ['local', 'groq'],
    description: 'IA local (Kaggle) o de respaldo (Groq)',
  })
  proveedor!: 'local' | 'groq';
  @ApiProperty() analizadoEn!: Date;
}

export class AlertaDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() creadoEn!: Date;
  @ApiProperty({ enum: PATRONES }) patron!: string;
  @ApiProperty({ type: [PersonaAlertaDto] }) personas!: PersonaAlertaDto[];
  @ApiPropertyOptional() cantidad?: number;
  @ApiPropertyOptional({ description: 'Metros; nunca coordenadas.' })
  distanciaM?: number;
  @ApiPropertyOptional() minutos?: number;
  @ApiPropertyOptional({ description: 'Fin del bloqueo, si hubo.' })
  bloqueoHasta?: Date;
  @ApiProperty({
    enum: ['listo', 'pendiente', 'sin_analisis'],
    description: 'PB-10: estado del análisis de IA',
  })
  estadoAnalisis!: 'listo' | 'pendiente' | 'sin_analisis';
  @ApiPropertyOptional({ type: AnalisisIaDto })
  analisis?: AnalisisIaDto;
}

export class AlertasRespuestaDto {
  @ApiProperty({ type: [AlertaDto] }) alertas!: AlertaDto[];
  @ApiPropertyOptional({
    description:
      'Pasar como `antes` para la página siguiente; ausente si no hay más.',
  })
  siguiente?: string;
}

export class BloqueoVigenteDto {
  @ApiProperty({ enum: ['par', 'cuenta'] }) tipo!: string;
  @ApiProperty({ enum: PATRONES }) patron!: string;
  @ApiProperty({ type: [PersonaAlertaDto] }) personas!: PersonaAlertaDto[];
  @ApiProperty() hasta!: Date;
}

export class BloqueosVigentesRespuestaDto {
  @ApiProperty({ type: [BloqueoVigenteDto] }) bloqueos!: BloqueoVigenteDto[];
}
