import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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
    enum: ['abordaje'],
    description: '`bajada` llega con HU-23.',
  })
  @IsIn(['abordaje'])
  tipo!: 'abordaje';
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

export class AbordarDto {
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
}
