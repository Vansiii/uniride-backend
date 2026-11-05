import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class IniciarSesionDto {
  @ApiProperty() @IsEmail() @MaxLength(254) correo!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(72) contrasena!: string;
  @ApiProperty({ enum: ['movil', 'web'] })
  @IsIn(['movil', 'web'])
  tipoCliente!: 'movil' | 'web';
}

export class RefrescarDto {
  @ApiPropertyOptional({
    description: 'Móvil: el token de refresco. Web: viaja en cookie.',
  })
  @IsOptional()
  @IsString()
  tokenRefresco?: string;
}

export class RespuestaSesionDto {
  @ApiProperty() tokenAcceso!: string;
  @ApiPropertyOptional({ description: 'Solo en móvil' }) tokenRefresco?: string;
}
