import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
import { AlertasService } from './alertas.service.js';
import {
  AlertasRespuestaDto,
  BloqueosVigentesRespuestaDto,
  DecidirAlertaDto,
  DesempenoDto,
  FiltroAlertasDto,
} from './dto/alertas.dto.js';

/**
 * HU-26: no hay rutas que creen, editen ni levanten alertas o bloqueos (CA-8). PB-11 suma la decisión del administrador,
 * que solo queda en la auditoría (CA-12), y el desempeño del modelo.
 */
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

  @Post('alertas-fraude/:id/decision')
  @HttpCode(204)
  @ApiNoContentResponse({
    description:
      'PB-11: «Fraude confirmado» o «Falso positivo». Rige la última; no toca bloqueos.',
  })
  @ApiNotFoundResponse({
    type: ErrorDto,
    description: '`ALERTA_NO_ENCONTRADA` (también si es de otra organización)',
  })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description: '`VALIDACION_FALLIDA`',
  })
  decidir(
    @OrganizacionActual() organizacionId: string,
    @UsuarioActual() actor: UsuarioToken,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecidirAlertaDto,
  ) {
    return this.servicio.decidir(organizacionId, actor.id, id, dto);
  }

  @Get('fraude/desempeno')
  @ApiOkResponse({
    type: DesempenoDto,
    description:
      'PB-11: estado del modelo propio, precisión por origen y validación con escenarios simulados.',
  })
  desempeno(
    @OrganizacionActual() organizacionId: string,
    @UsuarioActual() actor: UsuarioToken,
  ) {
    return this.servicio.desempeno(organizacionId, actor.id);
  }
}
