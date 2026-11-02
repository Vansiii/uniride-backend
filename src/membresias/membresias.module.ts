import { Module } from '@nestjs/common';
import {
  OrganizacionGuard,
  RolOrganizacionGuard,
} from '../comun/organizacion.guard.js';
import { MembresiasController } from './membresias.controller.js';
import { MembresiasService } from './membresias.service.js';

@Module({
  controllers: [MembresiasController],
  providers: [MembresiasService, OrganizacionGuard, RolOrganizacionGuard],
})
export class MembresiasModule {}
