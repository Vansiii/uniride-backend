import { Module } from '@nestjs/common';
import { OrganizacionGuard } from '../comun/organizacion.guard.js';
import { CalificacionesController } from './calificaciones.controller.js';
import { CalificacionesService } from './calificaciones.service.js';

@Module({
  controllers: [CalificacionesController],
  providers: [CalificacionesService, OrganizacionGuard],
})
export class CalificacionesModule {}
