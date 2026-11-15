import { Module } from '@nestjs/common';
import { BilleteraModule } from '../billetera/billetera.module.js';
import { FirmaDispositivoModule } from '../comun/firma-dispositivo.guard.js';
import { FirmaTrayectoGuard } from '../comun/firma-trayecto.guard.js';
import {
  PlayIntegrityService,
  crearPlayIntegrity,
} from '../comun/play-integrity.service.js';
import { EstadoViajeModule } from '../viajes/estado-viaje.service.js';
import { ViajesModule } from '../viajes/viajes.module.js';
import { PresenciaController } from './presencia.controller.js';
import { PresenciaService } from './presencia.service.js';

@Module({
  imports: [
    BilleteraModule,
    FirmaDispositivoModule,
    EstadoViajeModule,
    ViajesModule,
  ],
  controllers: [PresenciaController],
  providers: [
    PresenciaService,
    FirmaTrayectoGuard,
    { provide: PlayIntegrityService, useFactory: () => crearPlayIntegrity() },
  ],
})
export class PresenciaModule {}
