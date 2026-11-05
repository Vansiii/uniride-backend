import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UploadedFile,
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
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { UsuarioActual, type UsuarioToken } from '../comun/decoradores.js';
import { ErrorDto } from '../organizaciones/dto/afiliacion.dto.js';
import type { FotoSubida } from '../vehiculos/foto.js';
import {
  EstadoIdentidadDto,
  FormularioVerificarIdentidadDto,
  SesionLivenessDto,
  VerificacionDto,
  VerificarIdentidadDto,
} from './dto/identidad.dto.js';
import { FotoCarnetInterceptor } from './foto-carnet.js';
import { IdentidadService } from './identidad.service.js';

/** La identidad es de la persona y vale en todas sus organizaciones (D-07): basta la sesión, sin organización activa. */
@ApiTags('identidad')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorDto, description: '`NO_AUTENTICADO`' })
@Controller('identidad')
export class IdentidadController {
  constructor(private readonly servicio: IdentidadService) {}

  @Post('liveness-sesion')
  @ApiCreatedResponse({
    type: SesionLivenessDto,
    description: 'Sesión de Face Liveness para la cámara de la app (RN-4).',
  })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description: '`IDENTIDAD_YA_VERIFICADA`',
  })
  @ApiForbiddenResponse({
    type: ErrorDto,
    description:
      '`IDENTIDAD_BLOQUEADA_TEMPORAL` (trae `bloqueadoHasta`): 3 fallos consecutivos, 24 horas.',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorDto,
    description: '`SERVICIO_NO_DISPONIBLE`: falla del motor de verificación.',
  })
  crearSesionLiveness(@UsuarioActual() usuario: UsuarioToken) {
    return this.servicio.crearSesionLiveness(usuario.id);
  }

  @Post('verificar')
  @HttpCode(200)
  @UseInterceptors(FotoCarnetInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: FormularioVerificarIdentidadDto })
  @ApiOkResponse({
    type: VerificacionDto,
    description:
      'Identidad verificada. La respuesta nunca trae la foto, el hash ni datos biométricos (CA-8).',
  })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description:
      '`CONSENTIMIENTO_REQUERIDO` (`aceptaConsentimiento` distinto de `true`), `IMAGEN_ILEGIBLE` (falta, no es JPEG/PNG, pasa de 5 MB, borrosa o sin rostro; cuenta como intento salvo el exceso de tamaño), `IDENTIDAD_YA_VERIFICADA` o `VALIDACION_FALLIDA`.',
  })
  @ApiConflictResponse({
    type: ErrorDto,
    description:
      '`DOCUMENTO_DUPLICADO` o `ROSTRO_DUPLICADO`: ya pertenecen a otra cuenta (A-02). Cuentan como intento.',
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorDto,
    description:
      '`PRUEBA_VIDA_FALLIDA` (A-01, vivacidad < 85 %) o `ROSTRO_NO_COINCIDE` (similitud < 90 %). Cuentan como intento.',
  })
  @ApiTooManyRequestsResponse({
    type: ErrorDto,
    description:
      '`INTENTOS_AGOTADOS` (trae `bloqueadoHasta`): el tercer fallo consecutivo, o cualquier intento durante el bloqueo de 24 horas.',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorDto,
    description:
      '`SERVICIO_NO_DISPONIBLE`: falla del motor, del almacenamiento o de la base; no se guardó nada ni se contó intento.',
  })
  verificar(
    @UsuarioActual() usuario: UsuarioToken,
    @Body() dto: VerificarIdentidadDto,
    @UploadedFile() fotoCarnet?: FotoSubida,
  ) {
    return this.servicio.verificar(usuario.id, dto, fotoCarnet);
  }

  @Get('estado')
  @ApiOkResponse({
    type: EstadoIdentidadDto,
    description: 'Sin intentos previos: `no_verificada`.',
  })
  estado(@UsuarioActual() usuario: UsuarioToken) {
    return this.servicio.estado(usuario.id);
  }
}
