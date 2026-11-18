import { ApiProperty } from '@nestjs/swagger';
import { IsNumber } from 'class-validator';

export const ESTADOS_ORDEN = [
  'pendiente',
  'procesando',
  'completada',
  'expirada',
] as const;
export type EstadoOrden = (typeof ESTADOS_ORDEN)[number];

export class CrearRecargaDto {
  @ApiProperty({
    example: 50,
    minimum: 10,
    maximum: 500,
    description: 'En Bs (1 Bs = 1 URC), con hasta 2 decimales.',
  })
  @IsNumber()
  monto!: number;
}

export class OrdenRecargaDto {
  @ApiProperty({ format: 'uuid' })
  ordenId!: string;

  @ApiProperty({ example: '50.00' })
  monto!: string;

  @ApiProperty({
    enum: ESTADOS_ORDEN,
    description:
      '`procesando`: el pago se confirmó y la acuñación está en cola; se reintenta sola.',
  })
  estado!: EstadoOrden;

  @ApiProperty({ description: '15 minutos desde su creación.' })
  expiraEn!: Date;

  @ApiProperty({
    type: String,
    nullable: true,
    example:
      '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060',
  })
  hashTx!: string | null;
}

export class OrdenRecargaCreadaDto extends OrdenRecargaDto {
  @ApiProperty({
    example: 'uniride://recarga/7f1c1a52-6f3e-4a1b-9c55-0d6a3f6f1b11',
    description: 'Sin secretos: el pago es simulado.',
  })
  qrTexto!: string;

  @ApiProperty({ description: 'PNG del QR en Base64, sin prefijo `data:`.' })
  qrImagenBase64!: string;
}
