import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsString,
  MaxLength,
} from 'class-validator';

export const MODOS_APROBACION = ['manual', 'automatica'] as const;
export type ModoAprobacion = (typeof MODOS_APROBACION)[number];

export class AfiliacionDto {
  @ApiProperty({
    description:
      'Lista completa de dominios (reemplaza la anterior). Se guardan en minúsculas, sin `@` y sin repetidos; al menos uno.',
    example: ['uagrm.edu.bo', 'est.uagrm.edu.bo'],
    type: [String],
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(254, { each: true })
  dominios!: string[];

  @ApiProperty({
    enum: MODOS_APROBACION,
    description: 'Solo afecta a los registros futuros',
  })
  @IsIn(MODOS_APROBACION)
  modoAprobacion!: ModoAprobacion;
}

export class ErrorDto {
  @ApiProperty({ example: 'DOMINIO_INVALIDO' }) codigo!: string;
  @ApiProperty() mensaje!: string;
}
