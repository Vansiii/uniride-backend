import { Module } from '@nestjs/common';
import { BlockchainModule } from '../blockchain/blockchain.module.js';
import { FirmaDispositivoModule } from '../comun/firma-dispositivo.guard.js';
import { BilleteraController } from './billetera.controller.js';
import { BilleteraService } from './billetera.service.js';

/** `IdentidadModule` lo importa para crear la billetera al aprobar la identidad (CA-1); aquí no se importa aquel: sin ciclo. */
@Module({
  imports: [BlockchainModule, FirmaDispositivoModule],
  controllers: [BilleteraController],
  providers: [BilleteraService],
  exports: [BilleteraService],
})
export class BilleteraModule {}
