import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
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
  ApiNotFoundResponse,
  ApiAcceptedResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CuentaActivaGuard } from '../billetera/cuenta-activa.guard.js';
import {
  DispositivoActual,
  OrganizacionActual,
  UsuarioActual,
  type UsuarioToken,
} from '../comun/decoradores.js';
import { AccionSensible } from '../comun/firma-dispositivo.guard.js';
import {
  LlaveTrayectoActual,
  RequiereFirmaTrayecto,
  type LlaveTrayectoFirmante,
} from '../comun/firma-trayecto.guard.js';
import { IdentidadVerificadaGuard } from '../comun/identidad.guard.js';
import { OrganizacionGuard } from '../comun/organizacion.guard.js';
import { ErrorDto } from '../organizaciones/dto/afiliacion.dto.js';
import {
  AbordajeDto,
  AbordarDto,
  BajadaDto,
  CrearDesafioDto,
  DesafioDto,
  EncuentroDto,
  EstadoDesafioDto,
  LlaveTrayectoCreadaDto,
  PosicionesAceptadasDto,
  PosicionesDto,
  RegistrarLlaveTrayectoDto,
} from './dto/presencia.dto.js';
import { PresenciaService } from './presencia.service.js';

const SERVICIO_CAIDO =
  '`SERVICIO_NO_DISPONIBLE`: Play Integrity no respondió; reintentar.';

/**
 * HU-22: verificación de abordaje; HU-23: seguimiento del trayecto y bajada. El `X-Nonce` de la petición firmada es
 * también el nonce de Play Integrity (RN-5).
 */
@ApiTags('presencia')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorDto, description: '`NO_AUTENTICADO`' })
@Controller()
export class PresenciaController {
  constructor(private readonly servicio: PresenciaService) {}

  @Post('viajes/:id/llave-trayecto')
  @AccionSensible(
    'trayecto.llave',
    OrganizacionGuard,
    CuentaActivaGuard,
    IdentidadVerificadaGuard,
  )
  @ApiCreatedResponse({
    type: LlaveTrayectoCreadaDto,
    description:
      'Llave de trayecto del conductor para este viaje (D-22); reemplaza la anterior. Firma los desafíos sin huella.',
  })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description: '`LLAVE_INVALIDA` o `VALIDACION_FALLIDA`.',
  })
  @ApiUnauthorizedResponse({
    type: ErrorDto,
    description: '`FIRMA_DISPOSITIVO_INVALIDA` o `PETICION_EXPIRADA`.',
  })
  @ApiForbiddenResponse({
    type: ErrorDto,
    description:
      '`NO_AUTORIZADO`, `CUENTA_SUSPENDIDA` o `IDENTIDAD_NO_VERIFICADA`.',
  })
  @ApiNotFoundResponse({
    type: ErrorDto,
    description:
      '`VIAJE_NO_ENCONTRADO`: no existe, es de otra organización o no lo conduces.',
  })
  @ApiConflictResponse({
    type: ErrorDto,
    description:
      '`FUERA_DE_VENTANA` (trae `desde` y `hasta`, CA-11), `SIN_RESERVAS` o `CONFLICTO_CONCURRENTE` (otro registro a la vez ganó).',
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorDto,
    description: '`DISPOSITIVO_NO_INTEGRO` (A-03).',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorDto,
    description: SERVICIO_CAIDO,
  })
  registrarLlave(
    @UsuarioActual() usuario: UsuarioToken,
    @OrganizacionActual() organizacionId: string,
    @DispositivoActual() dispositivoId: string,
    @Headers('x-nonce') nonce: string,
    @Param('id', ParseUUIDPipe) viajeId: string,
    @Body() dto: RegistrarLlaveTrayectoDto,
  ): Promise<LlaveTrayectoCreadaDto> {
    return this.servicio.registrarLlaveConductor(
      usuario.id,
      organizacionId,
      viajeId,
      dispositivoId,
      nonce,
      dto,
    );
  }

  @Post('viajes/:id/desafios')
  @RequiereFirmaTrayecto()
  // La llave de trayecto vive el viaje: una cuenta suspendida después deja de emitir códigos.
  @UseGuards(CuentaActivaGuard)
  @ApiCreatedResponse({
    type: DesafioDto,
    description:
      'Código de un solo uso que vence en 30 s (RN-1) y los pasajeros con su estado. La app pide otro cada 25 s.',
  })
  @ApiUnauthorizedResponse({
    type: ErrorDto,
    description:
      '`FIRMA_TRAYECTO_INVALIDA` (llave ajena, revocada, de otro viaje o de un dispositivo inactivo) o `PETICION_EXPIRADA`.',
  })
  @ApiForbiddenResponse({
    type: ErrorDto,
    description: '`NO_AUTORIZADO` o `CUENTA_SUSPENDIDA`.',
  })
  @ApiConflictResponse({
    type: ErrorDto,
    description:
      '`FUERA_DE_VENTANA` (abordaje; trae `desde` y `hasta`) o `VIAJE_NO_EN_CURSO` (bajada).',
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorDto,
    description: '`UBICACION_SIMULADA` o `SENAL_GPS` (A-07, RN-4).',
  })
  crearDesafio(
    @UsuarioActual() usuario: UsuarioToken,
    @OrganizacionActual() organizacionId: string,
    @LlaveTrayectoActual() llave: LlaveTrayectoFirmante,
    @Param('id', ParseUUIDPipe) viajeId: string,
    @Body() dto: CrearDesafioDto,
  ): Promise<DesafioDto> {
    return this.servicio.crearDesafio(
      usuario.id,
      organizacionId,
      viajeId,
      llave,
      dto,
    );
  }

  /** Sin firma: la app del conductor lo sondea cada 3 s y pide otro código apenas este deja de servir (RN-1). */
  @Get('viajes/:id/desafios/:nonce')
  @UseGuards(OrganizacionGuard)
  @ApiOkResponse({ type: EstadoDesafioDto })
  @ApiForbiddenResponse({
    type: ErrorDto,
    description: '`NO_AUTORIZADO`: sin membresía aprobada.',
  })
  @ApiNotFoundResponse({
    type: ErrorDto,
    description:
      '`VIAJE_NO_ENCONTRADO`: no existe, es de otra organización o no eres su conductor.',
  })
  estadoDesafio(
    @UsuarioActual() usuario: UsuarioToken,
    @OrganizacionActual() organizacionId: string,
    @Param('id', ParseUUIDPipe) viajeId: string,
    @Param('nonce') nonce: string,
  ): Promise<EstadoDesafioDto> {
    return this.servicio.estadoDesafio(
      usuario.id,
      organizacionId,
      viajeId,
      nonce,
    );
  }

  @Post('reservas/:id/abordaje')
  @HttpCode(200)
  @AccionSensible(
    'reserva.abordaje',
    OrganizacionGuard,
    CuentaActivaGuard,
    IdentidadVerificadaGuard,
  )
  @ApiOkResponse({
    type: AbordajeDto,
    description:
      'Reserva `abordada` y viaje `en_curso` (CA-2). Repetirlo responde `yaVerificado` sin otra prueba (CA-14).',
  })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description: '`LLAVE_INVALIDA` o `VALIDACION_FALLIDA`.',
  })
  @ApiUnauthorizedResponse({
    type: ErrorDto,
    description: '`FIRMA_DISPOSITIVO_INVALIDA` o `PETICION_EXPIRADA`.',
  })
  @ApiForbiddenResponse({
    type: ErrorDto,
    description:
      '`NO_AUTORIZADO`, `CUENTA_SUSPENDIDA` o `IDENTIDAD_NO_VERIFICADA`.',
  })
  @ApiConflictResponse({
    type: ErrorDto,
    description:
      '`CODIGO_INVALIDO` (usado, vencido o de otra organización: CA-3, CA-4, CA-10) o `SIN_RESERVA` (CA-9).',
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorDto,
    description:
      '`DISTANCIA` (trae `distanciaM`), `UBICACION_SIMULADA`, `SENAL_GPS` o `DISPOSITIVO_NO_INTEGRO`. El código queda gastado.',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorDto,
    description: SERVICIO_CAIDO,
  })
  abordar(
    @UsuarioActual() usuario: UsuarioToken,
    @OrganizacionActual() organizacionId: string,
    @DispositivoActual() dispositivoId: string,
    @Headers('x-nonce') nonce: string,
    @Param('id', ParseUUIDPipe) reservaId: string,
    @Body() dto: AbordarDto,
  ): Promise<AbordajeDto> {
    return this.servicio.abordar(
      usuario.id,
      organizacionId,
      reservaId,
      dispositivoId,
      nonce,
      dto,
    );
  }

  @Post('reservas/:id/bajada')
  @HttpCode(200)
  @AccionSensible(
    'reserva.bajada',
    OrganizacionGuard,
    CuentaActivaGuard,
    IdentidadVerificadaGuard,
  )
  @ApiOkResponse({
    type: BajadaDto,
    description:
      'HU-23: el mismo encuentro que el abordaje con el código de bajada; aceptado, se evalúan las dos trayectorias y la reserva queda `verificada` o `verificacion_fallida` con su motivo (definitivo). Repetirlo responde `yaVerificado`.',
  })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description: '`VALIDACION_FALLIDA`.',
  })
  @ApiUnauthorizedResponse({
    type: ErrorDto,
    description: '`FIRMA_DISPOSITIVO_INVALIDA` o `PETICION_EXPIRADA`.',
  })
  @ApiForbiddenResponse({
    type: ErrorDto,
    description:
      '`NO_AUTORIZADO`, `CUENTA_SUSPENDIDA` o `IDENTIDAD_NO_VERIFICADA`.',
  })
  @ApiConflictResponse({
    type: ErrorDto,
    description:
      '`CODIGO_INVALIDO` (usado, vencido, de abordaje o de otra organización), `SIN_RESERVA` o `RESERVA_NO_ABORDADA`.',
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorDto,
    description:
      '`DISTANCIA` (trae `distanciaM`), `UBICACION_SIMULADA`, `SENAL_GPS` o `DISPOSITIVO_NO_INTEGRO`. El código queda gastado y la reserva sigue `abordada`.',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorDto,
    description: SERVICIO_CAIDO,
  })
  bajar(
    @UsuarioActual() usuario: UsuarioToken,
    @OrganizacionActual() organizacionId: string,
    @Headers('x-nonce') nonce: string,
    @Param('id', ParseUUIDPipe) reservaId: string,
    @Body() dto: EncuentroDto,
  ): Promise<BajadaDto> {
    return this.servicio.bajar(
      usuario.id,
      organizacionId,
      reservaId,
      nonce,
      dto,
    );
  }

  @Post('viajes/:id/posiciones')
  @HttpCode(202)
  @RequiereFirmaTrayecto()
  @UseGuards(CuentaActivaGuard)
  @ApiAcceptedResponse({
    type: PosicionesAceptadasDto,
    description:
      'HU-23: posiciones del conductor cada 15 s con su llave de trayecto, sin huella (CA-1), también las guardadas sin señal (CA-2).',
  })
  @ApiUnauthorizedResponse({
    type: ErrorDto,
    description:
      '`FIRMA_TRAYECTO_INVALIDA` (llave ajena, de pasajero, de otro viaje o revocada) o `PETICION_EXPIRADA`.',
  })
  @ApiForbiddenResponse({
    type: ErrorDto,
    description: '`NO_AUTORIZADO` o `CUENTA_SUSPENDIDA`.',
  })
  @ApiConflictResponse({
    type: ErrorDto,
    description:
      '`VIAJE_NO_EN_CURSO`: el viaje no está en curso o ya no lleva a nadie a bordo.',
  })
  posicionesConductor(
    @UsuarioActual() usuario: UsuarioToken,
    @OrganizacionActual() organizacionId: string,
    @LlaveTrayectoActual() llave: LlaveTrayectoFirmante,
    @Param('id', ParseUUIDPipe) viajeId: string,
    @Body() dto: PosicionesDto,
  ): Promise<PosicionesAceptadasDto> {
    return this.servicio.posicionesConductor(
      usuario.id,
      organizacionId,
      viajeId,
      llave,
      dto.puntos,
    );
  }

  @Post('reservas/:id/posiciones')
  @HttpCode(202)
  @RequiereFirmaTrayecto()
  @UseGuards(CuentaActivaGuard)
  @ApiAcceptedResponse({
    type: PosicionesAceptadasDto,
    description:
      'HU-23: posiciones del pasajero entre su abordaje y su bajada, con la llave de trayecto de esa reserva.',
  })
  @ApiUnauthorizedResponse({
    type: ErrorDto,
    description:
      '`FIRMA_TRAYECTO_INVALIDA` (llave ajena, del conductor, de otra reserva o revocada) o `PETICION_EXPIRADA`.',
  })
  @ApiForbiddenResponse({
    type: ErrorDto,
    description: '`NO_AUTORIZADO` o `CUENTA_SUSPENDIDA`.',
  })
  @ApiConflictResponse({
    type: ErrorDto,
    description:
      '`RESERVA_NO_ABORDADA`: todavía no subió o ya bajó (CA-12); la app deja de enviar.',
  })
  posicionesPasajero(
    @UsuarioActual() usuario: UsuarioToken,
    @OrganizacionActual() organizacionId: string,
    @LlaveTrayectoActual() llave: LlaveTrayectoFirmante,
    @Param('id', ParseUUIDPipe) reservaId: string,
    @Body() dto: PosicionesDto,
  ): Promise<PosicionesAceptadasDto> {
    return this.servicio.posicionesPasajero(
      usuario.id,
      organizacionId,
      reservaId,
      llave,
      dto.puntos,
    );
  }
}
