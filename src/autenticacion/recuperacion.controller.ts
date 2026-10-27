import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiGoneResponse,
  ApiNoContentResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Publico } from '../comun/decoradores.js';
import { ErrorDto } from '../organizaciones/dto/afiliacion.dto.js';
import {
  RecuperarContrasenaDto,
  RespuestaEnvioCodigoDto,
  RestablecerContrasenaDto,
} from './dto/registro.dto.js';
import { RecuperacionService } from './recuperacion.service.js';

/** Recuperación de contraseña (HU-34). La usan la app móvil y el panel web (RN-7). */
@ApiTags('autenticacion')
@Publico()
@Controller('autenticacion')
export class RecuperacionController {
  constructor(private readonly servicio: RecuperacionService) {}

  @Post('recuperar-contrasena')
  @HttpCode(202)
  @ApiAcceptedResponse({
    type: RespuestaEnvioCodigoDto,
    description:
      'Siempre la misma respuesta: con cuenta, el código de 6 dígitos (10 minutos) sale por la cola; sin cuenta no se envía nada (CA-2). Para otro código, repetir la petición o `reenviar-codigo` con `recuperacion`.',
  })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description: '`VALIDACION_FALLIDA`.',
  })
  @ApiTooManyRequestsResponse({
    type: ErrorDto,
    description:
      '`OTP_LIMITE_REENVIO` (1 código por minuto y 5 por hora, por correo exista o no la cuenta; trae `reenviarEn`) u `OTP_BLOQUEADO` (trae `reintentarEn`).',
  })
  solicitar(@Body() dto: RecuperarContrasenaDto) {
    return this.servicio.solicitar(dto.correo);
  }

  @Post('restablecer-contrasena')
  @HttpCode(204)
  @ApiNoContentResponse({
    description:
      'Contraseña cambiada, todas las sesiones cerradas y aviso por correo (CA-3).',
  })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description:
      '`OTP_INVALIDO` (incorrecto, ya usado, reemplazado o correo sin cuenta), `CONTRASENA_DEBIL` (no gasta el código) o `VALIDACION_FALLIDA`.',
  })
  @ApiGoneResponse({
    type: ErrorDto,
    description: '`OTP_VENCIDO`: pedir uno nuevo con `recuperar-contrasena`.',
  })
  @ApiTooManyRequestsResponse({
    type: ErrorDto,
    description:
      '`OTP_BLOQUEADO`: 5 errores seguidos bloquean 15 minutos (trae `reintentarEn`).',
  })
  async restablecer(@Body() dto: RestablecerContrasenaDto): Promise<void> {
    await this.servicio.restablecer(
      dto.correo,
      dto.codigo,
      dto.contrasenaNueva,
    );
  }
}
