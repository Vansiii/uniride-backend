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
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  OrganizacionActual,
  UsuarioActual,
  type UsuarioToken,
} from '../comun/decoradores.js';
import { FirmaDispositivoGuard } from '../comun/firma-dispositivo.guard.js';
import { IdentidadVerificadaGuard } from '../comun/identidad.guard.js';
import { OrganizacionGuard } from '../comun/organizacion.guard.js';
import { ErrorDto } from '../organizaciones/dto/afiliacion.dto.js';
import {
  DetalleViajeDto,
  MiViajeDto,
  PublicarViajeDto,
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
  @UseGuards(OrganizacionGuard, IdentidadVerificadaGuard, FirmaDispositivoGuard)
  @ApiHeader({
    name: 'X-Dispositivo-Id',
    description: 'Dispositivo vinculado.',
  })
  @ApiHeader({ name: 'X-Timestamp', description: 'Epoch en milisegundos.' })
  @ApiHeader({ name: 'X-Nonce', description: 'De un solo uso.' })
  @ApiHeader({
    name: 'X-Firma',
    description: 'Firma ECDSA P-256 del mensaje canónico, en Base64.',
  })
  @ApiCreatedResponse({
    type: ViajePublicadoDto,
    description: 'Publicado en la organización activa del conductor.',
  })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description:
      '`CUPOS_EXCEDEN_CAPACIDAD` (trae `maximo`), `PRECIO_FUERA_DE_RANGO` (trae `minimo` y `maximo`), `HORARIO_INVALIDO` (trae `minimoMinutos` y `maximoDias`) o `VALIDACION_FALLIDA`.',
  })
  @ApiUnauthorizedResponse({
    type: ErrorDto,
    description:
      '`NO_AUTENTICADO`, `FIRMA_DISPOSITIVO_INVALIDA` (también sin dispositivo vinculado) o `PETICION_EXPIRADA`.',
  })
  @ApiForbiddenResponse({
    type: ErrorDto,
    description:
      '`NO_AUTORIZADO` (sin membresía aprobada), `IDENTIDAD_NO_VERIFICADA` o `CONDUCTOR_SIN_VEHICULO`.',
  })
  @ApiConflictResponse({
    type: ErrorDto,
    description:
      '`VIAJE_SOLAPADO` (trae `margenHoras`): otro viaje activo del conductor, en cualquiera de sus organizaciones, sale a menos de 2 horas.',
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
