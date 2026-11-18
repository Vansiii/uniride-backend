import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CalificarDto {
  @ApiProperty({ minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  estrellas!: number;

  @ApiPropertyOptional({ maxLength: 140 })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  comentario?: string;

  @ApiPropertyOptional({
    description:
      'Solo para el conductor: debe ser el pasajero de la reserva. El servidor lo deduce; nunca se confía en este dato.',
  })
  @IsOptional()
  @IsUUID()
  destinatarioId?: string;
}

export class CalificacionCreadaDto {
  @ApiProperty() id!: string;
}

export class CalificacionRecibidaDto {
  @ApiProperty() estrellas!: number;
  @ApiPropertyOptional({ nullable: true }) comentario!: string | null;
}

export class EstadoCalificacionDto {
  @ApiProperty() puedoCalificar!: boolean;
  @ApiProperty({
    nullable: true,
    description:
      'Fin del plazo de 7 días desde el pago; nulo si no está pagada.',
  })
  plazoHasta!: Date | null;
  @ApiProperty({ description: 'Nombre de la persona a la que se califica.' })
  destinatario!: string;
  @ApiPropertyOptional({
    type: CalificacionRecibidaDto,
    description:
      'Calificación ciega: solo si ya calificaste o venció el plazo (RN-6).',
  })
  recibida?: CalificacionRecibidaDto;
}
