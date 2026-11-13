import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CuentaActivaGuard } from '../billetera/cuenta-activa.guard.js';
import {
  OrganizacionActual,
  UsuarioActual,
  type UsuarioToken,
} from '../comun/decoradores.js';
import { AccionSensible } from '../comun/firma-dispositivo.guard.js';
import { IdentidadVerificadaGuard } from '../comun/identidad.guard.js';
import { OrganizacionGuard } from '../comun/organizacion.guard.js';
import { ErrorDto } from '../organizaciones/dto/afiliacion.dto.js';
import {
  MisReservasDto,
  ReservaCreadaDto,
  ReservaDetalleDto,
  ReservarDto,
} from './dto/reserva.dto.js';
import { ReservasService } from './reservas.service.js';

@ApiTags('reservas')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorDto, description: '`NO_AUTENTICADO`' })
@Controller()
export class ReservasController {
  constructor(private readonly servicio: ReservasService) {}

  /** La firma va al final: una petición que se rechazará por otro motivo no gasta su nonce. */
  @Post('viajes/:id/reservas')
  @AccionSensible(
    'reserva.crear',
    OrganizacionGuard,
    CuentaActivaGuard,
    IdentidadVerificadaGuard,
  )
  @ApiCreatedResponse({
    type: ReservaCreadaDto,
    description:
      'Reserva `pendiente` con el asiento retenido y el pasaje en cola para quedar en garantía; pasa a `confirmada` cuando la cadena lo registra.',
  })
  @ApiOkResponse({
    type: ReservaCreadaDto,
    description:
      'La misma `claveIdempotencia` ya tenía su reserva: se devuelve la original, sin un segundo bloqueo.',
  })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description:
      '`VALIDACION_FALLIDA`: el cuerpo solo admite `claveIdempotencia`; un monto, conductor o estado se rechazan.',
  })
  @ApiUnauthorizedResponse({
    type: ErrorDto,
    description:
      '`NO_AUTENTICADO`, `FIRMA_DISPOSITIVO_INVALIDA` (también sin dispositivo vinculado) o `PETICION_EXPIRADA`.',
  })
  @ApiForbiddenResponse({
    type: ErrorDto,
    description:
      '`NO_AUTORIZADO` (sin membresía aprobada), `CUENTA_SUSPENDIDA` o `IDENTIDAD_NO_VERIFICADA`.',
  })
  @ApiNotFoundResponse({
    type: ErrorDto,
    description:
      '`VIAJE_NO_ENCONTRADO` (también si es de otra organización) o `BILLETERA_NO_ENCONTRADA`.',
  })
  @ApiConflictResponse({
    type: ErrorDto,
    description:
      '`SALDO_INSUFICIENTE` (trae `faltante`), `SIN_ASIENTOS`, `VIAJE_PROPIO`, `YA_RESERVADO`, `VIAJE_NO_DISPONIBLE`, `CONDUCTOR_SIN_BILLETERA` o `CLAVE_IDEMPOTENCIA_EN_CONFLICTO`.',
  })
  async reservar(
    @UsuarioActual() usuario: UsuarioToken,
    @OrganizacionActual() organizacionId: string,
    @Param('id', ParseUUIDPipe) viajeId: string,
    @Body() dto: ReservarDto,
    @Res({ passthrough: true }) respuesta: Response,
  ): Promise<ReservaCreadaDto> {
    const { reserva, creada } = await this.servicio.reservar(
      usuario.id,
      organizacionId,
      viajeId,
      dto.claveIdempotencia,
    );
    respuesta.status(creada ? 201 : 200);
    return reserva;
  }

  /** Basta la sesión: son las reservas de la persona, en todas sus organizaciones. Va antes de `:id`. */
  @Get('reservas/mias')
  @ApiOkResponse({ type: MisReservasDto })
  mias(@UsuarioActual() usuario: UsuarioToken): Promise<MisReservasDto> {
    return this.servicio.mias(usuario.id);
  }

  @Get('reservas/:id')
  @UseGuards(OrganizacionGuard)
  @ApiOkResponse({ type: ReservaDetalleDto })
  @ApiForbiddenResponse({
    type: ErrorDto,
    description: '`NO_AUTORIZADO`: sin membresía aprobada.',
  })
  @ApiNotFoundResponse({
    type: ErrorDto,
    description:
      '`RESERVA_NO_ENCONTRADA`: no existe, es de otra organización o no es tuya ni de tu viaje.',
  })
  detalle(
    @UsuarioActual() usuario: UsuarioToken,
    @OrganizacionActual() organizacionId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReservaDetalleDto> {
    return this.servicio.detalle(usuario.id, organizacionId, id);
  }
}
