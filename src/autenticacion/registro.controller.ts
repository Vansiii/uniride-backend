import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiGoneResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Publico } from '../comun/decoradores.js';
import { ErrorDto } from '../organizaciones/dto/afiliacion.dto.js';
import { responderSesion } from './autenticacion.controller.js';
import {
  ReenviarCodigoDto,
  RegistroDto,
  RespuestaEnvioCodigoDto,
  RespuestaVerificarOtpDto,
  VerificarOtpDto,
} from './dto/registro.dto.js';
import { RegistroService } from './registro.service.js';

const LIMITE = {
  type: ErrorDto,
  description:
    '`OTP_LIMITE_REENVIO` (1 código por minuto y 5 por hora; trae `reenviarEn`) u `OTP_BLOQUEADO` (trae `reintentarEn`).',
};
const SIN_CORREO = {
  type: ErrorDto,
  description:
    '`CORREO_NO_DISPONIBLE`: no se pudo enviar el correo; no se guardó nada.',
};

/** Registro con correo institucional (HU-05). Lo usa la app móvil (RN-9). */
@ApiTags('autenticacion')
@Publico()
@Controller('autenticacion')
export class RegistroController {
  constructor(private readonly servicio: RegistroService) {}

  @Post('registro')
  @HttpCode(202)
  @ApiAcceptedResponse({
    type: RespuestaEnvioCodigoDto,
    description:
      'Código enviado. Si el correo ya tiene cuenta, la respuesta es la misma y llega un aviso (CA-7).',
  })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description:
      '`CONSENTIMIENTO_REQUERIDO`, `CONTRASENA_DEBIL` o `VALIDACION_FALLIDA`.',
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorDto,
    description:
      '`ORGANIZACION_NO_AFILIADA`: el dominio del correo no es de ninguna organización; no se envía código.',
  })
  @ApiTooManyRequestsResponse(LIMITE)
  @ApiServiceUnavailableResponse(SIN_CORREO)
  registrar(@Body() dto: RegistroDto) {
    return this.servicio.registrar(dto);
  }

  @Post('verificar-otp')
  @HttpCode(200)
  @ApiOkResponse({
    type: RespuestaVerificarOtpDto,
    description: 'Cuenta creada y sesión iniciada (móvil: ambos tokens).',
  })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description: '`OTP_INVALIDO` (incorrecto, ya usado o reemplazado).',
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
  @ApiUnprocessableEntityResponse({
    type: ErrorDto,
    description:
      '`ORGANIZACION_NO_AFILIADA`: la organización dejó de estar activa.',
  })
  async verificar(
    @Body() dto: VerificarOtpDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { estadoMembresia, ...sesion } = await this.servicio.verificar(
      dto.correo,
      dto.codigo,
    );
    return { ...responderSesion(res, sesion, 'movil'), estadoMembresia };
  }

  @Post('reenviar-codigo')
  @HttpCode(202)
  @ApiAcceptedResponse({
    type: RespuestaEnvioCodigoDto,
    description:
      'El código anterior deja de servir. Sin código pendiente para ese propósito responde igual y no envía nada. Con `recuperacion` el código sale por la cola (nunca 503).',
  })
  @ApiTooManyRequestsResponse(LIMITE)
  @ApiServiceUnavailableResponse(SIN_CORREO)
  reenviar(@Body() dto: ReenviarCodigoDto) {
    return this.servicio.reenviar(dto.correo, dto.proposito);
  }
}
