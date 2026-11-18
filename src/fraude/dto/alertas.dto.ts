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
