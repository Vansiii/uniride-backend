import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { recortar } from '../../comun/validaciones.js';

export const ESTADOS_IDENTIDAD = [
  'no_verificada',
  'en_revision',
  'verificada',
  'rechazada',
  'bloqueada_temporal',
] as const;
export type EstadoIdentidad = (typeof ESTADOS_IDENTIDAD)[number];

/** Campos de texto del `multipart/form-data`: todos llegan como cadenas. */
export class VerificarIdentidadDto {
  @ApiProperty({
    example: '1234567-1A',
    description:
      'Número del carnet. Solo letras, números, espacios y guiones. Nunca se guarda: solo su HMAC (A-02).',
  })
  @recortar()
  @IsString()
  @Matches(/^[0-9A-Za-z][0-9A-Za-z -]{3,19}$/)
  numeroDocumento!: string;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Debe ser `true`: consentimiento de tratamiento de datos biométricos (RN-3, Ley 164)',
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  aceptaConsentimiento?: boolean;

  @ApiProperty({
    description:
      'Sesión de vivacidad devuelta por `POST /identidad/liveness-sesion`',
    maxLength: 128,
  })
  @recortar()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  sesionId!: string;
}

/** Solo para Swagger: la foto llega como archivo, no como campo del DTO. */
export class FormularioVerificarIdentidadDto extends VerificarIdentidadDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description:
      'Anverso del carnet en JPEG o PNG (se verifica por su contenido), máximo 5 MB, tomada en vivo',
  })
  fotoCarnet!: unknown;
}

export class SesionLivenessDto {
  @ApiProperty({ description: 'Identificador de la sesión de Face Liveness' })
  sesionId!: string;
}

export class VerificacionDto {
  @ApiProperty({ enum: ESTADOS_IDENTIDAD, example: 'verificada' })
  estado!: EstadoIdentidad;
  @ApiProperty({ format: 'date-time' }) verificadoEn!: Date;
}

/** Único dato de identidad que sale de la API (CA-8): nunca la foto, el hash, el face id ni el documento. */
export class EstadoIdentidadDto {
  @ApiProperty({ enum: ESTADOS_IDENTIDAD })
  estado!: EstadoIdentidad;
  @ApiProperty({ format: 'date-time', nullable: true })
  verificadoEn!: Date | null;
  @ApiProperty({
    format: 'date-time',
    nullable: true,
    description: 'Hasta cuándo dura el bloqueo temporal; `null` si no hay',
  })
  bloqueadoHasta!: Date | null;
}
