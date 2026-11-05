import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { recortar } from '../../comun/validaciones.js';

/** Campos de texto del `multipart/form-data`: todos llegan como cadenas. */
export class RegistroVehiculoDto {
  @ApiProperty({
    example: '1234-abc',
    description:
      '3 o 4 dígitos y 3 letras. Se guarda en mayúsculas, sin espacios ni guiones (`1234ABC`).',
  })
  @IsString()
  placa!: string;

  @ApiProperty({ example: 'Toyota', maxLength: 40 })
  @recortar()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  marca!: string;

  @ApiProperty({ example: 'Corolla', maxLength: 40 })
  @recortar()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  modelo!: string;

  @ApiProperty({ example: 'Blanco', maxLength: 40 })
  @recortar()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  color!: string;

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: 6,
    example: 4,
    description: 'Asientos para pasajeros, sin contar al conductor',
  })
  @recortar()
  @IsString()
  capacidad!: string;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Debe ser `true`: consentimiento para guardar la foto, que solo se usa para verificación (RN-5)',
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  aceptaUsoFoto?: boolean;
}

/** Solo para Swagger: la foto llega como archivo, no como campo del DTO. */
export class FormularioVehiculoDto extends RegistroVehiculoDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'JPEG o PNG (se verifica por su contenido), máximo 5 MB',
  })
  foto!: unknown;
}

/** Lo que ve cualquier persona distinta del dueño, p. ej. el pasajero de un viaje (CA-7, D-20). Sin la foto. */
export class VehiculoPublicoDto {
  @ApiProperty({ example: '1234ABC' }) placa!: string;
  @ApiProperty() marca!: string;
  @ApiProperty() modelo!: string;
  @ApiProperty() color!: string;
}

/** Lo que ve el dueño. Tampoco lleva la foto ni su clave (D-20). */
export class VehiculoDto extends VehiculoPublicoDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ minimum: 1, maximum: 6 }) capacidad!: number;
}
