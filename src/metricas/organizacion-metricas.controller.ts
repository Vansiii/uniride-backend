import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
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
import { FiltroResumenDto, ResumenDto } from './dto/resumen.dto.js';
import { MetricasService } from './metricas.service.js';

/** HU-32: solo lectura; la organización sale del token, nunca de la URL ni del cuerpo (CA-7). */
@ApiTags('metricas')
@ApiBearerAuth()
@ApiForbiddenResponse({
  type: ErrorDto,
  description: '`NO_AUTORIZADO`: sin membresía aprobada o sin rol de admin.',
})
@UseGuards(OrganizacionGuard, RolOrganizacionGuard)
@RolOrganizacion('admin_organizacion')
@Controller('organizacion')
export class OrganizacionMetricasController {
  constructor(private readonly servicio: MetricasService) {}

  @Get('resumen')
  @ApiOkResponse({ type: ResumenDto })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description: '`VALIDACION_FALLIDA`: período distinto de 7d, 30d o todo.',
  })
  resumen(
    @OrganizacionActual() organizacionId: string,
    @UsuarioActual() actor: UsuarioToken,
    @Query() filtro: FiltroResumenDto,
  ) {
    return this.servicio.resumen(organizacionId, actor.id, filtro.periodo);
  }
}
