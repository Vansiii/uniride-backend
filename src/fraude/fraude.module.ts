import { Module } from '@nestjs/common';
import {
  OrganizacionGuard,
  RolOrganizacionGuard,
} from '../comun/organizacion.guard.js';
import { IaModule } from '../ia/ia.module.js';
import { AlertasController } from './alertas.controller.js';
import { AlertasService } from './alertas.service.js';
import { AnalisisRiesgoService } from './analisis-riesgo.service.js';
import { AnomaliasService } from './anomalias.service.js';
import { BloqueosService } from './bloqueos.service.js';
import { ModeloRiesgoService } from './modelo-riesgo.service.js';

/** HU-25. `BloqueosService` lo piden reservas, viajes y billetera; este módulo no importa ninguno de ellos. HU-26 agrega la lectura de alertas; PB-10, su análisis con IA; PB-11, el modelo de riesgo propio. */
@Module({
  imports: [IaModule],
  controllers: [AlertasController],
  providers: [
    BloqueosService,
    AnomaliasService,
    AlertasService,
    AnalisisRiesgoService,
    ModeloRiesgoService,
    OrganizacionGuard,
    RolOrganizacionGuard,
  ],
  exports: [
    BloqueosService,
    AnomaliasService,
    AnalisisRiesgoService,
    ModeloRiesgoService,
  ],
})
export class FraudeModule {}
