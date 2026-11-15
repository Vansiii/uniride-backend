import { Module } from '@nestjs/common';
import { BilleteraModule } from '../billetera/billetera.module.js';
import { BlockchainModule } from '../blockchain/blockchain.module.js';
import { FirmaDispositivoModule } from '../comun/firma-dispositivo.guard.js';
import { EstadoViajeModule } from '../viajes/estado-viaje.service.js';
import { CancelacionesService } from './cancelaciones.service.js';
import { ReservasController } from './reservas.controller.js';
import { ReservasService } from './reservas.service.js';

@Module({
  imports: [
    BilleteraModule,
    BlockchainModule,
    FirmaDispositivoModule,
    EstadoViajeModule,
  ],
  controllers: [ReservasController],
  providers: [ReservasService, CancelacionesService],
  exports: [ReservasService, CancelacionesService],
})
export class ReservasModule {}
