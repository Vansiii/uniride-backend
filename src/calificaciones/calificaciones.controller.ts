import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  OrganizacionActual,
  UsuarioActual,
  type UsuarioToken,
} from '../comun/decoradores.js';
import { OrganizacionGuard } from '../comun/organizacion.guard.js';
import { ErrorDto } from '../organizaciones/dto/afiliacion.dto.js';
import { CalificacionesService } from './calificaciones.service.js';
import {
  CalificacionCreadaDto,
  CalificarDto,
  EstadoCalificacionDto,
} from './dto/calificacion.dto.js';

/** HU-21. No mueve dinero: basta el JWT, sin firma de dispositivo. */
@ApiTags('calificaciones')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorDto, description: '`NO_AUTENTICADO`' })
@ApiForbiddenResponse({
  type: ErrorDto,
  description:
    '`NO_PARTICIPANTE`: no eres el pasajero ni el conductor de la reserva (también si es de otra organización).',
})
@UseGuards(OrganizacionGuard)
@Controller('reservas/:id/calificaciones')
export class CalificacionesController {
  constructor(private readonly servicio: CalificacionesService) {}

  @Post()
  @ApiCreatedResponse({ type: CalificacionCreadaDto })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description:
      '`VALIDACION_FALLIDA`: estrellas de 1 a 5, comentario de hasta 140.',
  })
  @ApiConflictResponse({
    type: ErrorDto,
    description: '`YA_CALIFICADA`, `PLAZO_VENCIDO` o `RESERVA_NO_PAGADA`.',
  })
  calificar(
    @UsuarioActual() usuario: UsuarioToken,
    @OrganizacionActual() organizacionId: string,
    @Param('id', ParseUUIDPipe) reservaId: string,
    @Body() dto: CalificarDto,
  ) {
    return this.servicio.calificar(organizacionId, usuario.id, reservaId, dto);
  }

  @Get()
  @ApiOkResponse({ type: EstadoCalificacionDto })
  estado(
    @UsuarioActual() usuario: UsuarioToken,
    @OrganizacionActual() organizacionId: string,
    @Param('id', ParseUUIDPipe) reservaId: string,
  ) {
    return this.servicio.estado(organizacionId, usuario.id, reservaId);
  }
}
