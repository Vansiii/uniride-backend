import { Module } from '@nestjs/common';
import {
  OrganizacionGuard,
  RolOrganizacionGuard,
} from '../comun/organizacion.guard.js';
import { RolPlataformaGuard } from '../comun/rol-plataforma.guard.js';
import { OrganizacionMetricasController } from './organizacion-metricas.controller.js';
import { MetricasService } from './metricas.service.js';
import { PlataformaMetricasController } from './plataforma-metricas.controller.js';
import { PlataformaMetricasService } from './plataforma-metricas.service.js';

/** HU-32 y HU-33: métricas de solo lectura. */
@Module({
  controllers: [OrganizacionMetricasController, PlataformaMetricasController],
  providers: [
    MetricasService,
    PlataformaMetricasService,
    OrganizacionGuard,
    RolOrganizacionGuard,
    RolPlataformaGuard,
  ],
})
export class MetricasModule {}
