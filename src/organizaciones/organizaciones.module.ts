import { Module } from '@nestjs/common';
import { AutenticacionModule } from '../autenticacion/autenticacion.module.js';
import {
  OrganizacionGuard,
  RolOrganizacionGuard,
} from '../comun/organizacion.guard.js';
import { RolPlataformaGuard } from '../comun/rol-plataforma.guard.js';
import { AfiliacionController } from './afiliacion.controller.js';
import { AfiliacionService } from './afiliacion.service.js';
import {
  InvitacionesController,
  OrganizacionesController,
} from './organizaciones.controller.js';
import { OrganizacionesService } from './organizaciones.service.js';

@Module({
  imports: [AutenticacionModule],
  controllers: [
    OrganizacionesController,
    InvitacionesController,
    AfiliacionController,
  ],
  providers: [
    OrganizacionesService,
    AfiliacionService,
    RolPlataformaGuard,
    OrganizacionGuard,
    RolOrganizacionGuard,
  ],
})
export class OrganizacionesModule {}
