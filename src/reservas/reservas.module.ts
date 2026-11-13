import { Module } from '@nestjs/common';
import { BilleteraModule } from '../billetera/billetera.module.js';
import { BlockchainModule } from '../blockchain/blockchain.module.js';
import { FirmaDispositivoModule } from '../comun/firma-dispositivo.guard.js';
import { ReservasController } from './reservas.controller.js';
import { ReservasService } from './reservas.service.js';

@Module({
  imports: [BilleteraModule, BlockchainModule, FirmaDispositivoModule],
  controllers: [ReservasController],
  providers: [ReservasService],
})
export class ReservasModule {}
