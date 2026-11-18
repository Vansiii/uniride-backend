import { Module } from '@nestjs/common';
import { AnomaliasService } from './anomalias.service.js';
import { BloqueosService } from './bloqueos.service.js';

/** HU-25. `BloqueosService` lo piden reservas, viajes y billetera; este módulo no importa ninguno de ellos. */
@Module({
  providers: [BloqueosService, AnomaliasService],
  exports: [BloqueosService, AnomaliasService],
})
export class FraudeModule {}
