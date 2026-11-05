import { Module } from '@nestjs/common';
import { AlmacenamientoModule } from '../comun/almacenamiento.module.js';
import { OrganizacionGuard } from '../comun/organizacion.guard.js';
import { VehiculosController } from './vehiculos.controller.js';
import { VehiculosService } from './vehiculos.service.js';

@Module({
  imports: [AlmacenamientoModule],
  controllers: [VehiculosController],
  providers: [VehiculosService, OrganizacionGuard],
})
export class VehiculosModule {}
