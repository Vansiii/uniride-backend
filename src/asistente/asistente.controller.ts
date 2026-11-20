import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  OrganizacionActual,
  UsuarioActual,
  type UsuarioToken,
} from '../comun/decoradores.js';
import { OrganizacionGuard } from '../comun/organizacion.guard.js';
import { ErrorDto } from '../organizaciones/dto/afiliacion.dto.js';
import { AsistenteService } from './asistente.service.js';
import { ConsultaAsistenteDto } from './dto/consulta-asistente.dto.js';
import { RespuestaAsistenteDto } from './dto/respuesta-asistente.dto.js';

@ApiTags('asistente')
@ApiBearerAuth()
@UseGuards(OrganizacionGuard)
@Controller('asistente')
export class AsistenteController {
  constructor(private readonly asistenteService: AsistenteService) {}

  @Post('consultar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Consultar al asistente inteligente (guía o acción)',
    description:
      'Interpreta preguntas o comandos en lenguaje natural para guiar al usuario o devolver atajos directos de navegación.',
  })
  @ApiOkResponse({
    description: 'Respuesta interpretada en modo acción o guía.',
    type: RespuestaAsistenteDto,
  })
  @ApiBadRequestResponse({
    description: 'Consulta inválida o vacía.',
    type: ErrorDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No autenticado o token vencido.',
    type: ErrorDto,
  })
  @ApiForbiddenResponse({
    description: 'No pertenece a la organización activa.',
    type: ErrorDto,
  })
  async consultar(
    @Body() dto: ConsultaAsistenteDto,
    @UsuarioActual() usuario: UsuarioToken,
    @OrganizacionActual() _organizacionId: string,
  ): Promise<RespuestaAsistenteDto> {
    const cliente = usuario.cli || 'movil';
    return this.asistenteService.consultar(dto.consulta, cliente);
  }
}

