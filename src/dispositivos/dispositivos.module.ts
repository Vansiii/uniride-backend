import { Module } from '@nestjs/common';
import {
  crearPlayIntegrity,
  PlayIntegrityService,
} from '../comun/play-integrity.service.js';
import { DispositivosController } from './dispositivos.controller.js';
import { DispositivosService } from './dispositivos.service.js';

@Module({
  controllers: [DispositivosController],
  providers: [
    DispositivosService,
    // Se elige al arrancar: con MODO_EMULADOR_DEV=true en producción el arranque falla.
    { provide: PlayIntegrityService, useFactory: () => crearPlayIntegrity() },
  ],
})
export class DispositivosModule {}
