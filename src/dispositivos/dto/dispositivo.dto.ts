import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { recortar } from '../../comun/validaciones.js';

export class DesafioAtestacionDto {
  @ApiProperty({
    description:
      'Valor de un solo uso: la app lo usa como nonce al pedir el token de Play Integrity (base64 web-safe).',
  })
  desafio!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Pasada esta hora el desafío ya no sirve.',
  })
  expiraEn!: string;
}

export class VincularDispositivoDto {
  @ApiProperty({ description: 'Desafío emitido a esta cuenta; vale una vez.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  desafio!: string;

  @ApiProperty({
    description:
      'Token de Play Integrity pedido con el desafío como nonce. Con `MODO_EMULADOR_DEV` (solo desarrollo) rige la convención `simulado:integro`.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  tokenIntegridad!: string;

  @ApiProperty({
    description:
      'Llave PÚBLICA EC P-256 (prime256v1) en PEM, generada en el Keystore del teléfono.',
    example: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  llavePublicaPem!: string;

  @ApiProperty({ example: 'Samsung Galaxy A54', maxLength: 80 })
  @recortar()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  modelo!: string;
}

export class DispositivoVinculadoDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Va en el encabezado `X-Dispositivo-Id` de cada petición firmada.',
  })
  id!: string;

  @ApiProperty({ enum: ['vinculado'] })
  estado!: 'vinculado';
}

export class MiDispositivoDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() modelo!: string;
  @ApiProperty({ format: 'date-time' }) vinculadoEn!: Date;
  @ApiProperty() activo!: boolean;
}
