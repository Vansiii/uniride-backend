import { ApiHideProperty, ApiProperty } from '@nestjs/swagger';
import {
  Allow,
  IsBoolean,
  IsEmail,
  IsIn,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { recortar } from '../../comun/validaciones.js';
import { RespuestaSesionDto } from './sesion.dto.js';

export class RegistroDto {
  @ApiProperty({ example: 'Ana Pérez' })
  @recortar()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nombreCompleto!: string;

  @ApiProperty({
    example: 'ana@uagrm.edu.bo',
    description: 'Su dominio decide la organización',
  })
  @recortar()
  @IsEmail()
  @MaxLength(254)
  correo!: string;

  @ApiProperty({ description: 'Al menos 8 caracteres, con letras y números' })
  @IsString()
  @MaxLength(72)
  contrasena!: string;

  @ApiProperty({ description: 'Debe ser `true` (consentimiento, RN-7)' })
  @IsBoolean()
  aceptaTratamientoDatos!: boolean;

  /** CA-8 (A-13): se acepta para no romper el registro, pero nunca se lee; la organización sale solo del dominio. */
  @ApiHideProperty()
  @Allow()
  organizacionId?: unknown;
}

export class VerificarOtpDto {
  @ApiProperty() @recortar() @IsEmail() @MaxLength(254) correo!: string;

  @ApiProperty({ example: '042817', description: '6 dígitos' })
  @IsString()
  @Matches(/^\d{6}$/)
  codigo!: string;
}

export class ReenviarCodigoDto {
  @ApiProperty() @recortar() @IsEmail() @MaxLength(254) correo!: string;

  @ApiProperty({
    enum: ['registro', 'agregar_organizacion', 'recuperacion'],
    description:
      '`agregar_organizacion`: el código de `POST /membresias` (HU-07); `recuperacion`: el de `recuperar-contrasena` (HU-34)',
  })
  @IsIn(['registro', 'agregar_organizacion', 'recuperacion'])
  proposito!: 'registro' | 'agregar_organizacion' | 'recuperacion';
}

export class RecuperarContrasenaDto {
  @ApiProperty() @recortar() @IsEmail() @MaxLength(254) correo!: string;
}

export class RestablecerContrasenaDto extends VerificarOtpDto {
  @ApiProperty({ description: 'Al menos 8 caracteres, con letras y números' })
  @IsString()
  @MaxLength(72)
  contrasenaNueva!: string;
}

export class RespuestaEnvioCodigoDto {
  @ApiProperty({
    format: 'date-time',
    description: 'Desde cuándo se puede pedir otro código',
  })
  reenviarEn!: string;
}

export class RespuestaVerificarOtpDto extends RespuestaSesionDto {
  @ApiProperty({
    enum: ['aprobada', 'pendiente'],
    description: 'Según el modo de aprobación de la organización',
  })
  estadoMembresia!: 'aprobada' | 'pendiente';
}
