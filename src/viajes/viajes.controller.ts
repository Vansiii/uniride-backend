import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
  BuscarViajesDto,
  DetalleViajeDto,
  LimitesViajeDto,
  MiViajeDto,
  PublicarViajeDto,
  ViajeEncontradoDto,
  ViajePublicadoDto,
} from './dto/viaje.dto.js';
import { ViajesService } from './viajes.service.js';

@ApiTags('viajes')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorDto, description: '`NO_AUTENTICADO`' })
@Controller('viajes')
export class ViajesController {
  constructor(private readonly servicio: ViajesService) {}

  /** La firma va al final: una petición que se rechazará por otro motivo no gasta su nonce. */
  @Post()
  @AccionSensible(
    'viaje.publicar',
    OrganizacionGuard,
    CuentaActivaGuard,
    IdentidadVerificadaGuard,
  )
  @ApiCreatedResponse({
    type: ViajePublicadoDto,
    description: 'Publicado en la organización activa del conductor.',
  })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description:
      '`CUPOS_EXCEDEN_CAPACIDAD` (trae `maximo`), `PRECIO_FUERA_DE_RANGO` (trae `minimo` y `maximo`), `HORARIO_INVALIDO` (trae `minimoMinutos` y `maximoDias`), `LUGARES_IGUALES` o `VALIDACION_FALLIDA`.',
  })
  @ApiUnauthorizedResponse({
    type: ErrorDto,
    description:
      '`NO_AUTENTICADO`, `FIRMA_DISPOSITIVO_INVALIDA` (también sin dispositivo vinculado) o `PETICION_EXPIRADA`.',
  })
  @ApiForbiddenResponse({
    type: ErrorDto,
    description:
      '`NO_AUTORIZADO` (sin membresía aprobada), `CUENTA_SUSPENDIDA`, `IDENTIDAD_NO_VERIFICADA` o `CONDUCTOR_SIN_VEHICULO`.',
  })
  @ApiConflictResponse({
    type: ErrorDto,
    description:
      '`VIAJE_SOLAPADO` (trae `margenHoras` y `salidaExistente`): otro viaje activo del conductor, en cualquiera de sus organizaciones, sale a menos de 2 horas. Un viaje en `publicado` cuya salida ya pasó no cuenta.',
  })
  publicar(
    @UsuarioActual() usuario: UsuarioToken,
    @OrganizacionActual() organizacionId: string,
    @Body() dto: PublicarViajeDto,
  ): Promise<ViajePublicadoDto> {
    return this.servicio.publicar(usuario.id, organizacionId, dto);
  }

  /** Basta la sesión: son los viajes de la persona, en todas sus organizaciones. Va antes de `:id`. */
  @Get('mis-viajes')
  @ApiOkResponse({ type: MiViajeDto, isArray: true })
  misViajes(@UsuarioActual() usuario: UsuarioToken): Promise<MiViajeDto[]> {
    return this.servicio.misViajes(usuario.id);
  }

  /**
   * Para mostrar el tope como ayuda antes de fallar; quien decide sigue siendo `POST /viajes`. Va antes de `:id`.
   * Rechaza la cuenta suspendida para que la app lo sepa al abrir el formulario: firmar pide la huella antes de enviar.
   */
  @Get('limites')
  @UseGuards(OrganizacionGuard, CuentaActivaGuard)
  @ApiOkResponse({ type: LimitesViajeDto })
  @ApiForbiddenResponse({
    type: ErrorDto,
    description:
      '`NO_AUTORIZADO` (sin membresía aprobada) o `CUENTA_SUSPENDIDA`.',
  })
  limites(
    @OrganizacionActual() organizacionId: string,
  ): Promise<LimitesViajeDto> {
    return this.servicio.limites(organizacionId);
  }

  /** Solo membresía aprobada, sin firma: buscar no pide huella (decisión del integrante, 07/11). Va antes de `:id`. */
  @Get('buscar')
  @UseGuards(OrganizacionGuard)
  @ApiOkResponse({
    type: ViajeEncontradoDto,
    isArray: true,
    description:
      'Viajes de la organización activa con salida a 1 km y ± 30 minutos, con cupos y aún sin salir, por hora de salida. Máximo 50. Lista vacía si no hay.',
  })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description: '`COORDENADAS_INVALIDAS` o `VALIDACION_FALLIDA` (hora).',
  })
  @ApiForbiddenResponse({
    type: ErrorDto,
    description: '`NO_AUTORIZADO`: sin membresía aprobada.',
  })
  buscar(
    @OrganizacionActual() organizacionId: string,
    @Query() consulta: BuscarViajesDto,
  ): Promise<ViajeEncontradoDto[]> {
    return this.servicio.buscar(organizacionId, consulta);
  }

  @Get(':id')
  @UseGuards(OrganizacionGuard)
  @ApiOkResponse({ type: DetalleViajeDto })
  @ApiForbiddenResponse({
    type: ErrorDto,
    description: '`NO_AUTORIZADO`: sin membresía aprobada.',
  })
  @ApiNotFoundResponse({
    type: ErrorDto,
    description: '`VIAJE_NO_ENCONTRADO`, también si es de otra organización.',
  })
  detalle(
    @OrganizacionActual() organizacionId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DetalleViajeDto> {
    return this.servicio.detalle(organizacionId, id);
  }
}
