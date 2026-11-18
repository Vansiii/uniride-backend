import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UsuarioActual, type UsuarioToken } from '../comun/decoradores.js';
import {
  RolPlataforma,
  RolPlataformaGuard,
} from '../comun/rol-plataforma.guard.js';
import { ErrorDto } from '../organizaciones/dto/afiliacion.dto.js';
import { MetricasPlataformaDto } from './dto/plataforma.dto.js';
import { FiltroResumenDto } from './dto/resumen.dto.js';
import { PlataformaMetricasService } from './plataforma-metricas.service.js';

/** HU-33: solo lectura y solo super administrador (RN-1). */
@ApiTags('metricas')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorDto, description: '`NO_AUTORIZADO`' })
@UseGuards(RolPlataformaGuard)
@RolPlataforma('super_admin')
@Controller('plataforma')
export class PlataformaMetricasController {
  constructor(private readonly servicio: PlataformaMetricasService) {}

  @Get('metricas')
  @ApiOkResponse({ type: MetricasPlataformaDto })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description: '`VALIDACION_FALLIDA`: período distinto de 7d, 30d o todo.',
  })
  metricas(
    @UsuarioActual() actor: UsuarioToken,
    @Query() filtro: FiltroResumenDto,
  ) {
    return this.servicio.metricas(actor.id, filtro.periodo);
  }
}
