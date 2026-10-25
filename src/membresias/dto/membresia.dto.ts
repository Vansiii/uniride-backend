import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { recortar } from '../../comun/validaciones.js';

export const DECISIONES = ['aprobar', 'rechazar'] as const;
export type Decision = (typeof DECISIONES)[number];

export class FiltroMembresiasDto {
  @ApiPropertyOptional({
    enum: ['pendiente'],
    default: 'pendiente',
    description: 'En v1 solo se listan las solicitudes pendientes',
  })
  @IsOptional()
  @IsIn(['pendiente'])
  estado = 'pendiente' as const;
}

export class SolicitudDto {
  @ApiProperty({ format: 'uuid', description: 'Id de la membresía' })
  id!: string;
  @ApiProperty() nombreCompleto!: string;
  @ApiProperty() correoInstitucional!: string;
  @ApiProperty({ description: 'Fecha de la solicitud' }) creadoEn!: Date;
}

export class DecisionDto {
  @ApiProperty({ enum: DECISIONES })
  @IsIn(DECISIONES)
  decision!: Decision;

  @ApiPropertyOptional({
    description:
      'Solo se guarda al rechazar; va en el correo a la persona. Vacío equivale a sin motivo.',
    maxLength: 500,
  })
  @IsOptional()
  @recortar()
  @IsString()
  @MaxLength(500)
  motivo?: string;
}

export class DecisionRespuestaDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['aprobada', 'rechazada'] }) estado!: string;
}
