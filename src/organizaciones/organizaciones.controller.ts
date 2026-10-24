import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { responderSesion } from '../autenticacion/autenticacion.controller.js';
import { AutenticacionService } from '../autenticacion/autenticacion.service.js';
import {
  Publico,
  UsuarioActual,
  type UsuarioToken,
} from '../comun/decoradores.js';
import {
  RolPlataforma,
  RolPlataformaGuard,
} from '../comun/rol-plataforma.guard.js';
import {
  AceptarInvitacionDto,
  CrearOrganizacionDto,
} from './dto/organizacion.dto.js';
import { OrganizacionesService } from './organizaciones.service.js';

@ApiTags('organizaciones')
@ApiBearerAuth()
@UseGuards(RolPlataformaGuard)
@RolPlataforma('super_admin')
@Controller('admin/organizaciones')
export class OrganizacionesController {
  constructor(private readonly servicio: OrganizacionesService) {}

  @Post()
  crear(
    @UsuarioActual() actor: UsuarioToken,
    @Body() dto: CrearOrganizacionDto,
  ) {
    return this.servicio.crear(actor.id, dto);
  }

  @Get()
  listar() {
    return this.servicio.listar();
  }

  @Post(':id/invitacion')
  reenviar(
    @UsuarioActual() actor: UsuarioToken,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.servicio.reenviar(id, actor.id);
  }
}

@ApiTags('invitaciones')
@Publico()
@Controller('invitaciones')
export class InvitacionesController {
  constructor(
    private readonly servicio: OrganizacionesService,
    private readonly autenticacion: AutenticacionService,
  ) {}

  @Get(':token')
  consultar(@Param('token') token: string) {
    return this.servicio.consultar(token);
  }

  @Post(':token/aceptar')
  @HttpCode(200)
  async aceptar(
    @Param('token') token: string,
    @Body() dto: AceptarInvitacionDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { usuarioId, organizacionId } = await this.servicio.aceptar(
      token,
      dto.nombreCompleto,
      dto.contrasena,
    );
    const tipo = dto.tipoCliente ?? 'web';
    const sesion = await this.autenticacion.abrirSesion(
      usuarioId,
      organizacionId,
      tipo,
    );
    return responderSesion(res, sesion, tipo);
  }
}
