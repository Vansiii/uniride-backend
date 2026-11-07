import { Module } from '@nestjs/common';
import { FirmaDispositivoModule } from '../comun/firma-dispositivo.guard.js';
import { ViajesController } from './viajes.controller.js';
import { ViajesService } from './viajes.service.js';

@Module({
  imports: [FirmaDispositivoModule],
  controllers: [ViajesController],
  providers: [ViajesService],
})
export class ViajesModule {}
