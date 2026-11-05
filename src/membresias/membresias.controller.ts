import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  OrganizacionActual,
  UsuarioActual,
  type UsuarioToken,
} from '../comun/decoradores.js';
import {
  OrganizacionGuard,
  RolOrganizacion,
  RolOrganizacionGuard,
} from '../comun/organizacion.guard.js';
import { ErrorDto } from '../organizaciones/dto/afiliacion.dto.js';
import {
  DecisionDto,
  DecisionRespuestaDto,
  FiltroMembresiasDto,
  SolicitudDto,
} from './dto/membresia.dto.js';
import { MembresiasService } from './membresias.service.js';

@ApiTags('membresias')
@ApiBearerAuth()
@ApiForbiddenResponse({
  type: ErrorDto,
  description: '`NO_AUTORIZADO`: sin membresía aprobada o sin rol de admin.',
})
@ApiBadRequestResponse({
  type: ErrorDto,
  description: '`VALIDACION_FALLIDA`',
})
@UseGuards(OrganizacionGuard, RolOrganizacionGuard)
@RolOrganizacion('admin_organizacion')
@Controller()
export class MembresiasController {
  constructor(private readonly servicio: MembresiasService) {}

  @Get('organizaciones/:id/membresias')
  @ApiOkResponse({
    type: [SolicitudDto],
    description:
      'De la más antigua a la más reciente; lista vacía si no hay pendientes.',
  })
  @ApiNotFoundResponse({
    type: ErrorDto,
    description:
      '`NO_ENCONTRADO`: `id` no es la organización activa del token (no revela si existe).',
  })
  listar(
    @OrganizacionActual() organizacionId: string,
    @Param('id') id: string,
    @Query() filtro: FiltroMembresiasDto,
  ) {
    return this.servicio.listar(organizacionId, id, filtro.estado);
  }

  @Post('membresias/:id/decision')
  @HttpCode(200)
  @ApiOkResponse({ type: DecisionRespuestaDto })
  @ApiNotFoundResponse({
    type: ErrorDto,
    description:
      '`NO_ENCONTRADO`: la membresía no existe o es de otra organización (misma respuesta).',
  })
  @ApiConflictResponse({
    type: ErrorDto,
    description:
      '`MEMBRESIA_YA_DECIDIDA`: ya no está pendiente; vale la primera decisión.',
  })
  decidir(
    @OrganizacionActual() organizacionId: string,
    @UsuarioActual() actor: UsuarioToken,
    @Param('id') id: string,
    @Body() dto: DecisionDto,
  ) {
    return this.servicio.decidir(organizacionId, id, actor.id, dto);
  }
}
