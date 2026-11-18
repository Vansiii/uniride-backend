import { Module } from '@nestjs/common';
import {
  OrganizacionGuard,
  RolOrganizacionGuard,
} from '../comun/organizacion.guard.js';
import { OrganizacionMetricasController } from './organizacion-metricas.controller.js';
import { MetricasService } from './metricas.service.js';

/** HU-32 y HU-33: métricas de solo lectura. */
@Module({
  controllers: [OrganizacionMetricasController],
  providers: [MetricasService, OrganizacionGuard, RolOrganizacionGuard],
  exports: [MetricasService],
})
export class MetricasModule {}
