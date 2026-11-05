import {
  Body,
  Controller,
  Get,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UsuarioActual, type UsuarioToken } from '../comun/decoradores.js';
import { OrganizacionGuard } from '../comun/organizacion.guard.js';
import { ErrorDto } from '../organizaciones/dto/afiliacion.dto.js';
import {
  FormularioVehiculoDto,
  RegistroVehiculoDto,
  VehiculoDto,
} from './dto/vehiculo.dto.js';
import { FotoInterceptor, type FotoSubida } from './foto.js';
import { VehiculosService } from './vehiculos.service.js';

/** El vehículo es de la persona y le sirve en todas sus organizaciones (RN-6, D-07): se filtra por dueño. */
@ApiTags('vehiculos')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorDto, description: '`NO_AUTENTICADO`' })
@Controller('vehiculos')
export class VehiculosController {
  constructor(private readonly servicio: VehiculosService) {}

  /** Los guards van antes que el interceptor: sin membresía aprobada no se lee la foto. */
  @Post()
  @UseGuards(OrganizacionGuard)
  @UseInterceptors(FotoInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: FormularioVehiculoDto })
  @ApiCreatedResponse({
    type: VehiculoDto,
    description:
      'Registrado a nombre de la persona. La respuesta nunca trae la foto.',
  })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description:
      '`VEHICULO_DATO_INVALIDO` (trae `campo`: `placa` o `capacidad`), `VEHICULO_FOTO_INVALIDA` (falta, no es JPEG/PNG o pasa de 5 MB; trae `maximoBytes` y `tipos`), `CONSENTIMIENTO_REQUERIDO` (`aceptaUsoFoto` distinto de `true`) o `VALIDACION_FALLIDA`.',
  })
  @ApiForbiddenResponse({
    type: ErrorDto,
    description:
      '`NO_AUTORIZADO`: sin membresía aprobada en la organización activa (CA-8, D-21).',
  })
  @ApiConflictResponse({
    type: ErrorDto,
    description:
      '`VEHICULO_PLACA_DUPLICADA` (la placa ya está registrada en UniRide, por cualquier persona) o `VEHICULO_YA_REGISTRADO` (un vehículo por conductor en v1).',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorDto,
    description:
      '`ALMACENAMIENTO_NO_DISPONIBLE`: no se pudo guardar la foto; no se registró nada.',
  })
  registrar(
    @UsuarioActual() usuario: UsuarioToken,
    @Body() dto: RegistroVehiculoDto,
    @UploadedFile() foto?: FotoSubida,
  ) {
    return this.servicio.registrar(usuario.id, dto, foto);
  }

  /** Basta la sesión: el vehículo no depende de la organización activa. */
  @Get('mio')
  @ApiOkResponse({ type: VehiculoDto })
  @ApiNotFoundResponse({
    type: ErrorDto,
    description: '`NO_ENCONTRADO`: todavía no registró un vehículo.',
  })
  mio(@UsuarioActual() usuario: UsuarioToken) {
    return this.servicio.mio(usuario.id);
  }
}
