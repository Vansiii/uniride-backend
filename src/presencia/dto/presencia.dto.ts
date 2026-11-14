import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PasajeroViajeDto } from '../../viajes/dto/viaje.dto.js';

/** Posición del GPS tal como la da `expo-location`; el servidor decide si sirve (RN-4). */
export class PosicionDto {
  @ApiProperty({ example: -17.7833 })
  @IsLatitude()
  lat!: number;
  @ApiProperty({ example: -63.1821 })
  @IsLongitude()
  lng!: number;
  @ApiProperty({ example: 12, description: 'Precisión informada, en metros.' })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100_000)
  precisionM!: number;
  @ApiProperty({ example: 1763130000000, description: 'Epoch en ms del GPS.' })
  @IsInt()
  @Min(0)
  tomadaEn!: number;
  @ApiProperty({ description: '`mocked` de `expo-location` (A-07).' })
  @IsBoolean()
  simulada!: boolean;
}

/** Llave de trayecto: una llave pública EC P-256 en PEM (D-22). */
const LLAVE_PEM_MAX = 1_000;

export class RegistrarLlaveTrayectoDto {
  @ApiProperty({ description: 'Llave pública EC P-256 (SPKI, PEM).' })
  @IsString()
  @MaxLength(LLAVE_PEM_MAX)
  llavePublicaPem!: string;
  @ApiProperty({
    description:
      'Token de Play Integrity pedido con el `X-Nonce` de esta misma petición.',
  })
  @IsString()
  @MaxLength(10_000)
  tokenIntegridad!: string;
}

export class LlaveTrayectoCreadaDto {
  @ApiProperty({ format: 'uuid' })
  llaveTrayectoId!: string;
}

export class CrearDesafioDto {
  @ApiProperty({
    enum: ['abordaje', 'bajada'],
    description:
      '`abordaje` dentro de la ventana de salida (RN-3); `bajada` sin ventana, con el viaje en curso (HU-23 RN-7).',
  })
  @IsIn(['abordaje', 'bajada'])
  tipo!: 'abordaje' | 'bajada';
  @ApiProperty({ type: PosicionDto })
  @ValidateNested()
  @Type(() => PosicionDto)
  posicion!: PosicionDto;
}

export class DesafioDto {
  @ApiProperty({ description: '32 bytes aleatorios en base64url.' })
  nonce!: string;
  @ApiProperty({ type: String, format: 'date-time' })
  venceEn!: Date;
  @ApiProperty({ example: 'uniride://encuentro/…' })
  qrTexto!: string;
  @ApiProperty({ description: 'PNG del QR en Base64.' })
  qrImagenBase64!: string;
  @ApiProperty({ type: [PasajeroViajeDto] })
  pasajeros!: PasajeroViajeDto[];
}

/** Lo que el conductor sondea cada 3 s: si su código sigue sin usar y sus pasajeros. */
export class EstadoDesafioDto {
  @ApiProperty({
    description:
      '`false` si el código ya se usó (aceptado o rechazado, RN-1), venció o no es de este viaje: la app pide otro.',
  })
  vigente!: boolean;
  @ApiProperty({ type: [PasajeroViajeDto] })
  pasajeros!: PasajeroViajeDto[];
}

/** Lo que el pasajero envía al escanear, en el abordaje y en la bajada (HU-23 RN-7). */
export class EncuentroDto {
  @ApiProperty({ description: 'El nonce leído del QR.' })
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  nonce!: string;
  @ApiProperty({ type: PosicionDto })
  @ValidateNested()
  @Type(() => PosicionDto)
  posicion!: PosicionDto;
  @ApiProperty({
    description:
      'Token de Play Integrity pedido con el `X-Nonce` de esta misma petición (RN-5).',
  })
  @IsString()
  @MaxLength(10_000)
  tokenIntegridad!: string;
}

export class AbordarDto extends EncuentroDto {
  @ApiProperty({
    description: 'Llave de trayecto del pasajero (EC P-256, PEM), D-22.',
  })
  @IsString()
  @MaxLength(LLAVE_PEM_MAX)
  llavePublicaTrayectoPem!: string;
}

export class AbordajeDto {
  @ApiProperty({ example: 'abordada' })
  estado!: 'abordada';
  @ApiProperty({
    description:
      '`true` si ya estaba verificada: no se creó otra prueba (CA-14).',
  })
  yaVerificado!: boolean;
  @ApiProperty({
    required: false,
    format: 'uuid',
    description:
      'HU-23: la llave de trayecto del pasajero que quedó vigente; firma sus posiciones (`X-Llave-Trayecto-Id`). Falta si la reserva ya bajó.',
  })
  llaveTrayectoId?: string;
}

export class BajadaDto {
  @ApiProperty({ enum: ['verificada', 'verificacion_fallida', 'pagada'] })
  estado!: 'verificada' | 'verificacion_fallida' | 'pagada';
  @ApiProperty({
    nullable: true,
    type: String,
    enum: [
      'ubicacion_simulada',
      'salto_imposible',
      'datos_insuficientes',
      'trayectos_separados',
    ],
    description:
      'Por qué no se verificó (CA-5…CA-7, CA-10); nulo si se verificó.',
  })
  motivo!: string | null;
  @ApiProperty({
    description: '`true` si la bajada ya estaba hecha: no se volvió a evaluar.',
  })
  yaVerificado!: boolean;
}

/** HU-23 RN-1: un lote de posiciones cada 15 s, o las guardadas sin señal (CA-2): hasta 15 min. */
export class PosicionesDto {
  @ApiProperty({ type: [PosicionDto], minItems: 1, maxItems: 60 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => PosicionDto)
  puntos!: PosicionDto[];
}

export class PosicionesAceptadasDto {
  @ApiProperty({ description: 'Guardadas para la evaluación.' })
  aceptados!: number;
  @ApiProperty({
    description:
      'Repetidas, anteriores al abordaje o con hora futura (CA-9): no son error.',
  })
  ignorados!: number;
}
