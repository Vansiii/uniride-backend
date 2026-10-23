import { Module } from '@nestjs/common';
import { AutenticacionModule } from '../autenticacion/autenticacion.module.js';
import { RolPlataformaGuard } from '../comun/rol-plataforma.guard.js';
import {
  InvitacionesController,
  OrganizacionesController,
} from './organizaciones.controller.js';
import { OrganizacionesService } from './organizaciones.service.js';

@Module({
  imports: [AutenticacionModule],
  controllers: [OrganizacionesController, InvitacionesController],
  providers: [OrganizacionesService, RolPlataformaGuard],
})
export class OrganizacionesModule {}
