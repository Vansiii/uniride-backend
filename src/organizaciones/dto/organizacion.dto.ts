import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { recortar } from '../../comun/validaciones.js';
import { t } from '../../i18n/t.js';

export class CrearOrganizacionDto {
  @ApiProperty({ example: 'UAGRM' })
  @recortar()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nombre!: string;

  @ApiProperty({ enum: ['universidad', 'empresa'] })
  @IsIn(['universidad', 'empresa'])
  tipo!: 'universidad' | 'empresa';

  @ApiProperty({
    description: 'Bs por viaje (1 URC = 1 Bs); mayor que cero',
    example: 20,
  })
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: t('organizaciones.alta.precio_maximo_invalido') },
  )
  @IsPositive({ message: t('organizaciones.alta.precio_maximo_invalido') })
  precioMaximoUrc!: number;

  @ApiProperty()
  @recortar()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  adminNombre!: string;

  @ApiProperty()
  @recortar()
  @IsEmail({}, { message: t('organizaciones.alta.correo_invalido') })
  @MaxLength(254)
  adminCorreo!: string;
}

export class AceptarInvitacionDto {
  @ApiPropertyOptional({
    description: 'Obligatorio solo si el correo aún no tiene cuenta',
  })
  @IsOptional()
  @recortar()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nombreCompleto?: string;

  @ApiProperty() @IsString() @MinLength(1) @MaxLength(72) contrasena!: string;

  @ApiPropertyOptional({ enum: ['movil', 'web'], default: 'web' })
  @IsOptional()
  @IsIn(['movil', 'web'])
  tipoCliente?: 'movil' | 'web';
}
