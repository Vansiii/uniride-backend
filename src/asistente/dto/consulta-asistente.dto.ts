import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ConsultaAsistenteDto {
  @ApiProperty({
    description: 'Texto de la consulta o comando del usuario',
    example: '¿Cómo funciona el pago en garantía?',
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  consulta!: string;
}
