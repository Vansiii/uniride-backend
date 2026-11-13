import { Module } from '@nestjs/common';
import { BlockchainModule } from '../blockchain/blockchain.module.js';
import { TrabajosOnchainService } from '../blockchain/trabajos-onchain.service.js';
import { FirmaDispositivoModule } from '../comun/firma-dispositivo.guard.js';
import { EstadoViajeModule } from '../viajes/estado-viaje.service.js';
import { BilleteraController } from './billetera.controller.js';
import { BilleteraService } from './billetera.service.js';
import { ConciliacionService } from './conciliacion.service.js';
import { MovimientosService } from './movimientos.service.js';
import { RecargasController } from './recargas.controller.js';
import { RecargasService } from './recargas.service.js';
import { SaldoController } from './saldo.controller.js';

/** `IdentidadModule` lo importa para crear la billetera al aprobar la identidad (CA-1); aquí no se importa aquel: sin ciclo. */
@Module({
  imports: [BlockchainModule, FirmaDispositivoModule, EstadoViajeModule],
  controllers: [BilleteraController, SaldoController, RecargasController],
  providers: [
    BilleteraService,
    MovimientosService,
    ConciliacionService,
    RecargasService,
    TrabajosOnchainService,
  ],
  exports: [BilleteraService, MovimientosService],
})
export class BilleteraModule {}
