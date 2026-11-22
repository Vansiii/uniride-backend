import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { RIESGOS, type Riesgo } from '../analisis-riesgo.js';
import { CIFRAS, type ClaveCifra } from '../cifras-par.js';
import { PATRONES, PATRONES_ALERTA, type PatronAlerta } from '../patrones.js';

export const ORIGENES = ['reglas', 'modelo', 'anillo'] as const;
export type Origen = (typeof ORIGENES)[number];
export const DECISIONES = ['confirmado', 'falso_positivo'] as const;
export type Decision = (typeof DECISIONES)[number];
const CLAVES_CIFRA = CIFRAS.map((c) => c.clave);

export class FiltroAlertasDto {
  @ApiPropertyOptional({
    enum: PATRONES_ALERTA,
    description: 'CA-5: un solo patrón',
  })
  @IsOptional()
  @IsIn(PATRONES_ALERTA)
  patron?: PatronAlerta;

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
  @ApiProperty({
    enum: ['conductor', 'pasajero', 'miembro'],
    description: '`miembro` en alertas del modelo y de anillos (PB-11)',
  })
  rol!: 'conductor' | 'pasajero' | 'miembro';
}

/** PB-11 RN-5: cifra que más aparta al par de lo normal, con su percentil en la organización. */
export class FactorDto {
  @ApiProperty({ enum: CLAVES_CIFRA }) cifra!: ClaveCifra;
  @ApiProperty() valor!: number;
  @ApiProperty({ minimum: 0, maximum: 100 }) percentil!: number;
}

export class AristaGrafoDto {
  @ApiProperty({ description: 'Índice en `nodos`' }) a!: number;
  @ApiProperty({ description: 'Índice en `nodos`' }) b!: number;
  @ApiProperty() viajes!: number;
}

/** PB-11 CA-7: grupo de un anillo de colusión, para dibujarlo. */
export class GrafoAnilloDto {
  @ApiProperty({ type: [String], description: 'Nombres' }) nodos!: string[];
  @ApiProperty({ type: [AristaGrafoDto] }) aristas!: AristaGrafoDto[];
  @ApiProperty() viajesInternos!: number;
  @ApiProperty({ minimum: 0, maximum: 1 }) proporcion!: number;
}

/** PB-11 RN-8: última decisión del administrador sobre la alerta. */
export class DecisionAlertaDto {
  @ApiProperty({ enum: DECISIONES }) valor!: Decision;
  @ApiPropertyOptional() nota?: string;
  @ApiProperty({ description: 'Nombre de quien decidió' }) autor!: string;
  @ApiProperty() en!: Date;
}

export class DecidirAlertaDto {
  @ApiProperty({ enum: DECISIONES })
  @IsIn(DECISIONES)
  decision!: Decision;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nota?: string;
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
  @ApiProperty({
    enum: ['modelo', 'estimado'],
    description:
      'PB-11: puntaje del modelo propio o estimado por la IA de lenguaje',
  })
  origenPuntaje!: 'modelo' | 'estimado';
  @ApiProperty() analizadoEn!: Date;
}

export class AlertaDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() creadoEn!: Date;
  @ApiProperty({ enum: PATRONES_ALERTA }) patron!: string;
  @ApiProperty({ enum: ORIGENES, description: 'PB-11' }) origen!: Origen;
  @ApiProperty({ type: [PersonaAlertaDto] }) personas!: PersonaAlertaDto[];
  @ApiPropertyOptional({ type: [FactorDto], description: 'PB-11' })
  factores?: FactorDto[];
  @ApiPropertyOptional({
    minimum: 0,
    maximum: 100,
    description: 'PB-11: puntaje del modelo con que se creó la alerta',
  })
  puntajeModelo?: number;
  @ApiPropertyOptional({ type: GrafoAnilloDto, description: 'PB-11: anillo' })
  grafo?: GrafoAnilloDto;
  @ApiPropertyOptional({ type: DecisionAlertaDto, description: 'PB-11' })
  decision?: DecisionAlertaDto;
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

export class ModeloEstadoDto {
  @ApiProperty() version!: number;
  @ApiProperty() entrenadoEn!: Date;
  @ApiProperty() pares!: number;
  @ApiProperty({
    type: [Number],
    description: 'Pares por tramo de puntaje: 0–9, 10–19, … 90–100',
  })
  histograma!: number[];
  @ApiProperty() umbral!: number;
}

export class SinDatosDto {
  @ApiProperty() pares!: number;
  @ApiProperty() minimo!: number;
}

export class DesempenoOrigenDto {
  @ApiProperty({ enum: ORIGENES }) origen!: Origen;
  @ApiProperty() alertas!: number;
  @ApiProperty() confirmadas!: number;
  @ApiProperty() falsosPositivos!: number;
  @ApiPropertyOptional({
    nullable: true,
    description: 'confirmadas ÷ decididas; null sin decisiones',
  })
  precision!: number | null;
}

export class PuntoRocDto {
  @ApiProperty() x!: number;
  @ApiProperty() y!: number;
}

/** CA-11: con escenarios simulados, no con datos reales. */
export class ValidacionDto {
  @ApiProperty() auc!: number;
  @ApiProperty() deteccion!: number;
  @ApiProperty() falsasAlarmas!: number;
  @ApiProperty() deteccionUmbral!: number;
  @ApiProperty() falsasAlarmasUmbral!: number;
  @ApiProperty({ type: [PuntoRocDto] }) roc!: PuntoRocDto[];
  @ApiProperty() escenarios!: number;
}

export class DesempenoDto {
  @ApiPropertyOptional({ type: ModeloEstadoDto, nullable: true })
  modelo!: ModeloEstadoDto | null;
  @ApiPropertyOptional({ type: SinDatosDto, nullable: true })
  sinDatos!: SinDatosDto | null;
  @ApiProperty({ type: [DesempenoOrigenDto] })
  porOrigen!: DesempenoOrigenDto[];
  @ApiProperty({ type: ValidacionDto }) validacion!: ValidacionDto;
}
