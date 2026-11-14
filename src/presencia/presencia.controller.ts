import {
  Body,
  Controller,
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
  CrearDesafioDto,
  DesafioDto,
  LlaveTrayectoCreadaDto,
  RegistrarLlaveTrayectoDto,
} from './dto/presencia.dto.js';
import { PresenciaService } from './presencia.service.js';

const SERVICIO_CAIDO =
  '`SERVICIO_NO_DISPONIBLE`: Play Integrity no respondió; reintentar.';

/** HU-22: verificación de abordaje. El `X-Nonce` de la petición firmada es también el nonce de Play Integrity (RN-5). */
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
    description: '`FUERA_DE_VENTANA` (trae `desde` y `hasta`).',
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
}
