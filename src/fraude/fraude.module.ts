import { Module } from '@nestjs/common';
import {
  OrganizacionGuard,
  RolOrganizacionGuard,
} from '../comun/organizacion.guard.js';
import { AlertasController } from './alertas.controller.js';
import { AlertasService } from './alertas.service.js';
import { AnomaliasService } from './anomalias.service.js';
import { BloqueosService } from './bloqueos.service.js';

/** HU-25. `BloqueosService` lo piden reservas, viajes y billetera; este módulo no importa ninguno de ellos. HU-26 agrega la lectura de alertas. */
@Module({
  controllers: [AlertasController],
  providers: [
    BloqueosService,
    AnomaliasService,
    AlertasService,
    OrganizacionGuard,
    RolOrganizacionGuard,
  ],
  exports: [BloqueosService, AnomaliasService],
})
export class FraudeModule {}
