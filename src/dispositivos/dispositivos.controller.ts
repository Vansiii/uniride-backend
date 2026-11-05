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
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { UsuarioActual, type UsuarioToken } from '../comun/decoradores.js';
import { ErrorDto } from '../organizaciones/dto/afiliacion.dto.js';
import {
  DesafioAtestacionDto,
  DispositivoVinculadoDto,
  MiDispositivoDto,
  VincularDispositivoDto,
} from './dto/dispositivo.dto.js';
import { DispositivosService } from './dispositivos.service.js';

/** El dispositivo es de la persona y vale en todas sus organizaciones (D-07): basta la sesión. */
@ApiTags('dispositivos')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorDto, description: '`NO_AUTENTICADO`' })
@Controller('dispositivos')
export class DispositivosController {
  constructor(private readonly servicio: DispositivosService) {}

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
}
