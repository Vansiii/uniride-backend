import { Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { UsuarioActual, type UsuarioToken } from '../comun/decoradores.js';
import { FirmaDispositivoGuard } from '../comun/firma-dispositivo.guard.js';
import { IdentidadVerificadaGuard } from '../comun/identidad.guard.js';
import { ErrorDto } from '../organizaciones/dto/afiliacion.dto.js';
import { BilleteraService } from './billetera.service.js';
import { CuentaActivaGuard } from './cuenta-activa.guard.js';
import { BilleteraDto } from './dto/billetera.dto.js';

const SERVICIO_NO_DISPONIBLE =
  '`SERVICIO_BLOCKCHAIN_NO_DISPONIBLE`: falla del nodo o de la custodia; no se guardó nada, se puede reintentar.';

/**
 * La billetera es de la persona (D-07): se busca siempre por el usuario del token, sin organización ni id en la ruta.
 * Identidad antes que firma: quien no verificó recibe 403 aunque todavía no tenga dispositivo vinculado (CA-4).
 */
@ApiTags('billetera')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Dispositivo-Id', description: 'Dispositivo vinculado.' })
@ApiHeader({ name: 'X-Timestamp', description: 'Epoch en milisegundos.' })
@ApiHeader({ name: 'X-Nonce', description: 'De un solo uso.' })
@ApiHeader({
  name: 'X-Firma',
  description: 'Firma ECDSA P-256 del mensaje canónico, en Base64.',
})
@ApiUnauthorizedResponse({
  type: ErrorDto,
  description:
    '`NO_AUTENTICADO`, `FIRMA_DISPOSITIVO_INVALIDA` (también sin dispositivo vinculado) o `PETICION_EXPIRADA`.',
})
@ApiForbiddenResponse({
  type: ErrorDto,
  description: '`CUENTA_SUSPENDIDA` o `IDENTIDAD_NO_VERIFICADA`.',
})
@ApiServiceUnavailableResponse({
  type: ErrorDto,
  description: SERVICIO_NO_DISPONIBLE,
})
@UseGuards(CuentaActivaGuard, IdentidadVerificadaGuard, FirmaDispositivoGuard)
@Controller('billetera')
export class BilleteraController {
  constructor(private readonly servicio: BilleteraService) {}

  @Post()
  @ApiOperation({
    summary: 'Crea mi billetera o devuelve la que ya tengo (idempotente)',
    description:
      'La billetera se crea sola al aprobarse la identidad; este endpoint sirve para reintentar si aquella creación falló.',
  })
  @ApiCreatedResponse({ type: BilleteraDto, description: 'Billetera creada.' })
  @ApiOkResponse({
    type: BilleteraDto,
    description: 'Ya existía: es la misma billetera (CA-2).',
  })
  async crear(
    @UsuarioActual() usuario: UsuarioToken,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BilleteraDto> {
    const { billetera, creada } = await this.servicio.crear(usuario.id);
    res.status(creada ? 201 : 200);
    return billetera;
  }

  @Get('mia')
  @ApiOperation({ summary: 'Mi dirección pública y saldo URC' })
  @ApiOkResponse({ type: BilleteraDto })
  @ApiNotFoundResponse({
    type: ErrorDto,
    description: '`BILLETERA_NO_ENCONTRADA`',
  })
  mia(@UsuarioActual() usuario: UsuarioToken): Promise<BilleteraDto> {
    return this.servicio.mia(usuario.id);
  }
}
