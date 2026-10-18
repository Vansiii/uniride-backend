import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  Publico,
  UsuarioActual,
  type UsuarioToken,
} from '../comun/decoradores.js';
import {
  AutenticacionService,
  Sesion,
  TipoCliente,
} from './autenticacion.service.js';
import {
  IniciarSesionDto,
  RefrescarDto,
  RespuestaSesionDto,
} from './dto/sesion.dto.js';

const COOKIE = 'refresco';
const RUTA_COOKIE = '/api/v1/autenticacion';

@ApiTags('autenticacion')
@Controller('autenticacion')
export class AutenticacionController {
  constructor(private readonly servicio: AutenticacionService) {}

  @Publico()
  @Post('iniciar-sesion')
  @HttpCode(200)
  @ApiOkResponse({ type: RespuestaSesionDto })
  async iniciarSesion(
    @Body() dto: IniciarSesionDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const sesion = await this.servicio.iniciarSesion(
      dto.correo,
      dto.contrasena,
      dto.tipoCliente,
    );
    return this.responder(res, sesion, dto.tipoCliente);
  }

  @Publico()
  @Post('refrescar')
  @HttpCode(200)
  @ApiOkResponse({ type: RespuestaSesionDto })
  async refrescar(
    @Body() dto: RefrescarDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = dto.tokenRefresco ?? req.cookies?.[COOKIE];
    const { sesion, tipoCliente } = await this.servicio.refrescar(token ?? '');
    return this.responder(res, sesion, tipoCliente);
  }

  @ApiBearerAuth()
  @Post('cerrar-sesion')
  @HttpCode(204)
  async cerrarSesion(
    @UsuarioActual() usuario: UsuarioToken,
    @Body() dto: RefrescarDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.servicio.cerrarSesion(
      usuario.id,
      dto.tokenRefresco ?? req.cookies?.[COOKIE],
    );
    res.clearCookie(COOKIE, { path: RUTA_COOKIE });
  }

  private responder(res: Response, sesion: Sesion, tipo: TipoCliente) {
    if (tipo === 'movil') return sesion;
    res.cookie(COOKIE, sesion.tokenRefresco, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: RUTA_COOKIE,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    return { tokenAcceso: sesion.tokenAcceso };
  }
}
