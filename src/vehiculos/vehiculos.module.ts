import { Module } from '@nestjs/common';
import { AlmacenamientoService } from '../comun/almacenamiento.service.js';
import { OrganizacionGuard } from '../comun/organizacion.guard.js';
import { VehiculosController } from './vehiculos.controller.js';
import { VehiculosService } from './vehiculos.service.js';

@Module({
  controllers: [VehiculosController],
  providers: [VehiculosService, AlmacenamientoService, OrganizacionGuard],
})
export class VehiculosModule {}
