import { Body, Controller, HttpCode, Post, Put } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { RespuestaEnvioCodigoDto } from '../autenticacion/dto/registro.dto.js';
import { UsuarioActual, type UsuarioToken } from '../comun/decoradores.js';
import { ErrorDto } from '../organizaciones/dto/afiliacion.dto.js';
import {
  AgregarOrganizacionDto,
  ConfirmarOrganizacionDto,
  MembresiaCreadaDto,
  OrganizacionActivaDto,
  TokenAccesoDto,
} from './dto/membresia.dto.js';
import { MisMembresiasService } from './mis-membresias.service.js';

const NO_AFILIADA = {
  type: ErrorDto,
  description:
    '`ORGANIZACION_NO_AFILIADA`: el dominio del correo no es de ninguna organización activa; no se envía código.',
};
const YA_MIEMBRO = {
  type: ErrorDto,
  description:
    '`YA_ES_MIEMBRO` (aprobada o pendiente), `MEMBRESIA_RECHAZADA` (el rechazo es definitivo, HU-03 RN-4) o `CORREO_EN_USO` (otra cuenta usa ese correo).',
};

/** HU-07: sin `OrganizacionGuard`: basta la sesión, aunque todavía no haya organización activa. */
@ApiTags('membresias')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorDto, description: '`NO_AUTENTICADO`' })
@Controller()
export class MisMembresiasController {
  constructor(private readonly servicio: MisMembresiasService) {}

  @Post('membresias')
  @HttpCode(202)
  @ApiAcceptedResponse({
    type: RespuestaEnvioCodigoDto,
    description:
      'Código enviado al correo de la otra organización (mismas reglas que el registro). Se reenvía con `POST /autenticacion/reenviar-codigo` y `proposito: agregar_organizacion`.',
  })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description: '`VALIDACION_FALLIDA`',
  })
  @ApiUnprocessableEntityResponse(NO_AFILIADA)
  @ApiConflictResponse(YA_MIEMBRO)
  @ApiTooManyRequestsResponse({
    type: ErrorDto,
    description:
      '`OTP_LIMITE_REENVIO` (1 código por minuto y 5 por hora; trae `reenviarEn`) u `OTP_BLOQUEADO` (trae `reintentarEn`).',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorDto,
    description:
      '`CORREO_NO_DISPONIBLE`: no se pudo enviar el correo; no se guardó nada.',
  })
  solicitar(
    @UsuarioActual() usuario: UsuarioToken,
    @Body() dto: AgregarOrganizacionDto,
  ) {
    return this.servicio.solicitar(usuario.id, dto.correo);
  }

  @Post('membresias/confirmar')
  @HttpCode(200)
  @ApiOkResponse({ type: MembresiaCreadaDto })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description:
      '`OTP_INVALIDO` (incorrecto, ya usado, reemplazado o pedido por otra cuenta) o `VALIDACION_FALLIDA`.',
  })
  @ApiGoneResponse({
    type: ErrorDto,
    description: '`OTP_VENCIDO`: pedir uno nuevo con `reenviar-codigo`.',
  })
  @ApiTooManyRequestsResponse({
    type: ErrorDto,
    description:
      '`OTP_BLOQUEADO`: 5 errores seguidos bloquean 15 minutos (trae `reintentarEn`).',
  })
  @ApiConflictResponse({
    ...YA_MIEMBRO,
    description: `${YA_MIEMBRO.description} Cambió entre el envío y la confirmación.`,
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorDto,
    description:
      '`ORGANIZACION_NO_AFILIADA`: la organización dejó de estar activa.',
  })
  confirmar(
    @UsuarioActual() usuario: UsuarioToken,
    @Body() dto: ConfirmarOrganizacionDto,
  ) {
    return this.servicio.confirmar(usuario.id, dto.correo, dto.codigo);
  }

  @ApiTags('yo')
  @Put('yo/organizacion-activa')
  @ApiOkResponse({ type: TokenAccesoDto })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description: '`VALIDACION_FALLIDA`',
  })
  @ApiForbiddenResponse({
    type: ErrorDto,
    description:
      '`MEMBRESIA_NO_APROBADA`: pendiente, rechazada o sin membresía en esa organización (misma respuesta).',
  })
  cambiarActiva(
    @UsuarioActual() usuario: UsuarioToken,
    @Body() dto: OrganizacionActivaDto,
  ) {
    return this.servicio.cambiarActiva(
      usuario.id,
      dto.organizacionId,
      usuario.cli,
    );
  }
}
