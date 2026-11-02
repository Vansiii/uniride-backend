import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
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
import { AfiliacionService } from './afiliacion.service.js';
import { AfiliacionDto, ErrorDto } from './dto/afiliacion.dto.js';

@ApiTags('organizaciones')
@ApiBearerAuth()
@ApiForbiddenResponse({
  type: ErrorDto,
  description: '`NO_AUTORIZADO`: sin membresía aprobada o sin rol de admin.',
})
@ApiNotFoundResponse({
  type: ErrorDto,
  description:
    '`NO_ENCONTRADO`: `id` no es la organización activa del token (no revela si existe).',
})
@UseGuards(OrganizacionGuard, RolOrganizacionGuard)
@RolOrganizacion('admin_organizacion')
@Controller('organizaciones/:id/afiliacion')
export class AfiliacionController {
  constructor(private readonly servicio: AfiliacionService) {}

  @Get()
  @ApiOkResponse({ type: AfiliacionDto })
  obtener(
    @OrganizacionActual() organizacionId: string,
    @Param('id') id: string,
  ) {
    return this.servicio.obtener(organizacionId, id);
  }

  @Put()
  @ApiOkResponse({ type: AfiliacionDto })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description:
      '`DOMINIO_INVALIDO` (formato o dominio público), `MINIMO_UN_DOMINIO` o `VALIDACION_FALLIDA`.',
  })
  @ApiConflictResponse({
    type: ErrorDto,
    description:
      '`DOMINIO_NO_DISPONIBLE`: ya es de otra organización (no dice de cuál).',
  })
  guardar(
    @OrganizacionActual() organizacionId: string,
    @UsuarioActual() actor: UsuarioToken,
    @Param('id') id: string,
    @Body() dto: AfiliacionDto,
  ) {
    return this.servicio.guardar(organizacionId, id, actor.id, dto);
  }
}
