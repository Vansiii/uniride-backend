import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { UsuarioActual, type UsuarioToken } from '../comun/decoradores.js';
import { RequiereFirmaDispositivo } from '../comun/firma-dispositivo.guard.js';
import { IdentidadVerificadaGuard } from '../comun/identidad.guard.js';
import { ErrorDto } from '../organizaciones/dto/afiliacion.dto.js';
import { CuentaActivaGuard } from './cuenta-activa.guard.js';
import {
  CrearRecargaDto,
  OrdenRecargaCreadaDto,
  OrdenRecargaDto,
} from './dto/recarga.dto.js';
import { RecargasService } from './recargas.service.js';

/** Solo `confirmar` mueve dinero y firma (CA-4, D-13): cada firma pide huella, y consultar el estado no puede pedirla. */
@ApiTags('billetera')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorDto, description: '`NO_AUTENTICADO`' })
@ApiForbiddenResponse({
  type: ErrorDto,
  description: '`CUENTA_SUSPENDIDA` o `IDENTIDAD_NO_VERIFICADA`.',
})
@UseGuards(CuentaActivaGuard, IdentidadVerificadaGuard)
@Controller('billetera/recargas')
export class RecargasController {
  constructor(private readonly servicio: RecargasService) {}

  @Post()
  @ApiOperation({
    summary: 'Genera una orden de recarga con su QR, válida 15 minutos',
  })
  @ApiCreatedResponse({ type: OrdenRecargaCreadaDto })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description:
      '`MONTO_FUERA_DE_RANGO` (10 a 500 Bs), `MONTO_INVALIDO` (más de 2 decimales) o `VALIDACION_FALLIDA`.',
  })
  @ApiNotFoundResponse({
    type: ErrorDto,
    description: '`BILLETERA_NO_ENCONTRADA`',
  })
  crear(
    @UsuarioActual() usuario: UsuarioToken,
    @Body() cuerpo: CrearRecargaDto,
  ): Promise<OrdenRecargaCreadaDto> {
    return this.servicio.crear(usuario.id, cuerpo.monto);
  }

  @Post(':id/confirmar')
  @RequiereFirmaDispositivo()
  @ApiOperation({
    summary: 'Confirma el pago simulado y acredita la recarga (idempotente)',
    description:
      'Responde sin esperar a la cadena; el estado se consulta en `GET /billetera/recargas/:id`.',
  })
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
  @ApiAcceptedResponse({
    type: OrdenRecargaDto,
    description: 'En proceso, también si se repite mientras tanto.',
  })
  @ApiOkResponse({
    type: OrdenRecargaDto,
    description: 'Ya se acreditó: no se acuña de nuevo (CA-3).',
  })
  @ApiGoneResponse({ type: ErrorDto, description: '`ORDEN_EXPIRADA`' })
  @ApiNotFoundResponse({
    type: ErrorDto,
    description: '`NO_ENCONTRADO`, también si es de otra persona.',
  })
  async confirmar(
    @UsuarioActual() usuario: UsuarioToken,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrdenRecargaDto> {
    const orden = await this.servicio.confirmar(usuario.id, id);
    res.status(orden.estado === 'completada' ? 200 : 202);
    return orden;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Estado de mi orden de recarga' })
  @ApiOkResponse({ type: OrdenRecargaDto })
  @ApiNotFoundResponse({
    type: ErrorDto,
    description: '`NO_ENCONTRADO`, también si es de otra persona.',
  })
  consultar(
    @UsuarioActual() usuario: UsuarioToken,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OrdenRecargaDto> {
    return this.servicio.consultar(usuario.id, id);
  }
}
