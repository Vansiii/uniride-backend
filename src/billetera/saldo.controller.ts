import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UsuarioActual, type UsuarioToken } from '../comun/decoradores.js';
import { IdentidadVerificadaGuard } from '../comun/identidad.guard.js';
import { ErrorDto } from '../organizaciones/dto/afiliacion.dto.js';
import { ConciliacionService } from './conciliacion.service.js';
import { CuentaActivaGuard } from './cuenta-activa.guard.js';
import {
  ConsultaMovimientosDto,
  PaginaMovimientosDto,
  SaldoDto,
} from './dto/saldo.dto.js';
import { MovimientosService } from './movimientos.service.js';

/**
 * Lecturas sin firma de dispositivo (plan HU-14 §3): cada firma pide huella, y el refresco y el scroll no pueden pedirla.
 * Controlador aparte para que `POST /billetera` y `GET /billetera/mia` conserven su firma. Sin id en la ruta: del token.
 */
@ApiTags('billetera')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorDto, description: '`NO_AUTENTICADO`' })
@ApiForbiddenResponse({
  type: ErrorDto,
  description: '`CUENTA_SUSPENDIDA` o `IDENTIDAD_NO_VERIFICADA`.',
})
@ApiNotFoundResponse({
  type: ErrorDto,
  description: '`BILLETERA_NO_ENCONTRADA`',
})
@UseGuards(CuentaActivaGuard, IdentidadVerificadaGuard)
@Controller('billetera')
export class SaldoController {
  constructor(
    private readonly conciliacion: ConciliacionService,
    private readonly movimientos: MovimientosService,
  ) {}

  @Get('saldo')
  @ApiOperation({
    summary: 'Mi saldo total, disponible y bloqueado en garantía',
    description:
      'Si el nodo falla o no responde responde igual 200, con el saldo contable y `enLinea: false`. El saldo de la cadena se guarda 15 s.',
  })
  @ApiOkResponse({ type: SaldoDto })
  saldo(@UsuarioActual() usuario: UsuarioToken): Promise<SaldoDto> {
    return this.conciliacion.saldo(usuario.id);
  }

  @Get('movimientos')
  @ApiOperation({ summary: 'Mis movimientos paginados, del más reciente' })
  @ApiOkResponse({ type: PaginaMovimientosDto })
  @ApiBadRequestResponse({
    type: ErrorDto,
    description: '`VALIDACION_FALLIDA`',
  })
  listar(
    @UsuarioActual() usuario: UsuarioToken,
    @Query() consulta: ConsultaMovimientosDto,
  ): Promise<PaginaMovimientosDto> {
    return this.movimientos.listar(usuario.id, consulta);
  }
}
