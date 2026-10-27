import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { MembresiaYoDto } from '../../autenticacion/yo.controller.js';
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

// --- HU-07: varias organizaciones ---

export class AgregarOrganizacionDto {
  @ApiProperty({
    example: 'ana@empresa.com.bo',
    description: 'Correo de la otra organización: su dominio la decide',
  })
  @recortar()
  @IsEmail()
  @MaxLength(254)
  correo!: string;
}

export class ConfirmarOrganizacionDto extends AgregarOrganizacionDto {
  @ApiProperty({ example: '042817', description: '6 dígitos' })
  @IsString()
  @Matches(/^\d{6}$/)
  codigo!: string;
}

export class MembresiaCreadaDto {
  @ApiProperty({
    type: MembresiaYoDto,
    description:
      '`aprobada` o `pendiente` según el modo de aprobación de la organización',
  })
  membresia!: MembresiaYoDto;
}

export class OrganizacionActivaDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  organizacionId!: string;
}

export class TokenAccesoDto {
  @ApiProperty({
    description:
      'Con `org` = la organización elegida. El token de refresco no cambia.',
  })
  tokenAcceso!: string;
}
