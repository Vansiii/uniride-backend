import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { UsuarioActual, type UsuarioToken } from '../comun/decoradores.js';
import { ErrorDto } from '../organizaciones/dto/afiliacion.dto.js';
import {
  DesafioAtestacionDto,
  DesafioRevinculacionDto,
  DispositivoVinculadoDto,
  MiDispositivoDto,
  RevincularDispositivoDto,
  VincularDispositivoDto,
} from './dto/dispositivo.dto.js';
import { DispositivosService } from './dispositivos.service.js';
import { RevinculacionService } from './revinculacion.service.js';

/** El dispositivo es de la persona y vale en todas sus organizaciones (D-07): basta la sesión. */
@ApiTags('dispositivos')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorDto, description: '`NO_AUTENTICADO`' })
@Controller('dispositivos')
export class DispositivosController {
  constructor(
    private readonly servicio: DispositivosService,
    private readonly revinculacionServicio: RevinculacionService,
  ) {}

  @Post('desafio-atestacion')
  @ApiOperation({
    summary: 'Pide el desafío de un solo uso para atestar el teléfono',
  })
  @ApiCreatedResponse({ type: DesafioAtestacionDto })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description:
      '`DISPOSITIVO_YA_VINCULADO`: la cuenta ya tiene un dispositivo activo (CA-6).',
  })
  desafio(@UsuarioActual() usuario: UsuarioToken) {
    return this.servicio.emitirDesafio(usuario.id);
  }

  @Post('vincular')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Vincula el teléfono: valida la atestación y guarda la llave pública',
  })
  @ApiOkResponse({ type: DispositivoVinculadoDto })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description:
      '`DESAFIO_INVALIDO` (vencido, ya usado o de otra cuenta), `DISPOSITIVO_YA_VINCULADO` (CA-6, también si dos intentos coinciden), `LLAVE_INVALIDA` (no es una llave pública EC P-256) o `VALIDACION_FALLIDA`.',
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorDto,
    description:
      '`DISPOSITIVO_NO_INTEGRO`: emulador, root o app no original (CA-2, A-03).',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorDto,
    description:
      '`SERVICIO_NO_DISPONIBLE`: Google Play Integrity no respondió; no se guardó nada.',
  })
  vincular(
    @UsuarioActual() usuario: UsuarioToken,
    @Body() dto: VincularDispositivoDto,
  ) {
    return this.servicio.vincular(usuario.id, dto);
  }

  @Get('mi-dispositivo')
  @ApiOperation({ summary: 'Dispositivo vinculado a mi cuenta' })
  @ApiOkResponse({ type: MiDispositivoDto })
  @ApiNotFoundResponse({
    type: ErrorDto,
    description: '`NO_ENCONTRADO`: todavía no vinculó un teléfono.',
  })
  miDispositivo(@UsuarioActual() usuario: UsuarioToken) {
    return this.servicio.miDispositivo(usuario.id);
  }

  @Post('revinculacion')
  @ApiOperation({
    summary:
      'Pide el desafío de un solo uso para volver a vincular o cambiar de teléfono (HU-10)',
  })
  @ApiCreatedResponse({ type: DesafioRevinculacionDto })
  @ApiTooManyRequestsResponse({
    type: ErrorDto,
    description:
      '`INTENTOS_AGOTADOS`: la cuenta está bloqueada 24 h por fallos previos (CA-7).',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorDto,
    description:
      '`SERVICIO_NO_DISPONIBLE`: el servicio de vivacidad no respondió.',
  })
  desafioRevinculacion(@UsuarioActual() usuario: UsuarioToken) {
    return this.revinculacionServicio.emitirDesafio(usuario.id);
  }

  @Post('revincular')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Vuelve a vincular el teléfono: valida identidad (si aplica) e integridad, reemplazando el anterior (HU-10)',
  })
  @ApiCreatedResponse({ type: DispositivoVinculadoDto })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description:
      '`DESAFIO_INVALIDO` (vencido, ya usado o de otra cuenta) o `LLAVE_INVALIDA`.',
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorDto,
    description:
      '`ROSTRO_NO_COINCIDE` (similitud < 90 %), `PRUEBA_VIDA_FALLIDA` (vivacidad < 85 %) o `DISPOSITIVO_NO_INTEGRO`.',
  })
  @ApiTooManyRequestsResponse({
    type: ErrorDto,
    description:
      '`INTENTOS_AGOTADOS`: tercer fallo de identidad o bloqueo vigente de 24 h (CA-7).',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorDto,
    description:
      '`SERVICIO_NO_DISPONIBLE`: Play Integrity o Rekognition no respondieron; nada cambia (CA-11).',
  })
  revincular(
    @UsuarioActual() usuario: UsuarioToken,
    @Body() dto: RevincularDispositivoDto,
  ) {
    return this.revinculacionServicio.revincular(usuario.id, dto);
  }
}
