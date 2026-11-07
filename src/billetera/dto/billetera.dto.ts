import { ApiProperty } from '@nestjs/swagger';

export class BilleteraDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    example: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    description: 'Dirección pública. La llave privada nunca sale de la API.',
  })
  direccion!: string;

  @ApiProperty({
    example: '0.00',
    description: 'Saldo leído del contrato, truncado a 2 decimales.',
  })
  saldoUrc!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example:
      'https://amoy.polygonscan.com/address/0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    description:
      'Polygonscan en Amoy; `null` en una cadena sin explorador (Hardhat o simulada).',
  })
  exploradorUrl!: string | null;
}
