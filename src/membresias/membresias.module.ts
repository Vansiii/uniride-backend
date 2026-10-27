import { Module } from '@nestjs/common';
import { AutenticacionModule } from '../autenticacion/autenticacion.module.js';
import {
  OrganizacionGuard,
  RolOrganizacionGuard,
} from '../comun/organizacion.guard.js';
import { MembresiasController } from './membresias.controller.js';
import { MembresiasService } from './membresias.service.js';
import { MisMembresiasController } from './mis-membresias.controller.js';
import { MisMembresiasService } from './mis-membresias.service.js';

@Module({
  imports: [AutenticacionModule],
  controllers: [MembresiasController, MisMembresiasController],
  providers: [
    MembresiasService,
    MisMembresiasService,
    OrganizacionGuard,
    RolOrganizacionGuard,
  ],
})
export class MembresiasModule {}
