import { Module } from '@nestjs/common';
import { BilleteraModule } from '../billetera/billetera.module.js';
import { FirmaDispositivoModule } from '../comun/firma-dispositivo.guard.js';
import { ReservasModule } from '../reservas/reservas.module.js';
import { ViajesController } from './viajes.controller.js';
import { ViajesService } from './viajes.service.js';

@Module({
  imports: [BilleteraModule, FirmaDispositivoModule, ReservasModule],
  controllers: [ViajesController],
  providers: [ViajesService],
  // HU-22: la pantalla «Mostrar código» reutiliza la lista de pasajeros.
  exports: [ViajesService],
})
export class ViajesModule {}
