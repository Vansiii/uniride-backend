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
import { AlertasService } from './alertas.service.js';
import {
  AlertasRespuestaDto,
  BloqueosVigentesRespuestaDto,
  FiltroAlertasDto,
} from './dto/alertas.dto.js';

/** HU-26: solo lectura. No hay rutas que creen, editen ni levanten alertas o bloqueos (CA-8). */
@ApiTags('fraude')
@ApiBearerAuth()
@ApiForbiddenResponse({
  type: ErrorDto,
  description: '`NO_AUTORIZADO`: sin membresía aprobada o sin rol de admin.',
})
@UseGuards(OrganizacionGuard, RolOrganizacionGuard)
@RolOrganizacion('admin_organizacion')
@Controller('organizacion')
export class AlertasController {
  constructor(private readonly servicio: AlertasService) {}

  @Get('alertas-fraude')
  @ApiOkResponse({
    type: AlertasRespuestaDto,
    description:
      'De la más reciente a la más antigua, solo de la organización activa.',
  })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description: '`VALIDACION_FALLIDA`',
  })
  alertas(
    @OrganizacionActual() organizacionId: string,
    @UsuarioActual() actor: UsuarioToken,
    @Query() filtro: FiltroAlertasDto,
  ) {
    return this.servicio.listar(organizacionId, actor.id, filtro);
  }

  @Get('bloqueos-vigentes')
  @ApiOkResponse({ type: BloqueosVigentesRespuestaDto })
  async bloqueos(
    @OrganizacionActual() organizacionId: string,
    @UsuarioActual() actor: UsuarioToken,
  ) {
    return {
      bloqueos: await this.servicio.bloqueosVigentes(organizacionId, actor.id),
    };
  }
}
