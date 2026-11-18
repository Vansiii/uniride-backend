import { Module } from '@nestjs/common';
import {
  crearPlayIntegrity,
  PlayIntegrityService,
} from '../comun/play-integrity.service.js';
import { IdentidadModule } from '../identidad/identidad.module.js';
import { DispositivosController } from './dispositivos.controller.js';
import { DispositivosService } from './dispositivos.service.js';
import { RevinculacionService } from './revinculacion.service.js';

@Module({
  imports: [IdentidadModule],
  controllers: [DispositivosController],
  providers: [
    DispositivosService,
    RevinculacionService,
    // Se elige al arrancar: con MODO_EMULADOR_DEV=true en producción el arranque falla.
    { provide: PlayIntegrityService, useFactory: () => crearPlayIntegrity() },
  ],
  exports: [DispositivosService, RevinculacionService],
})
export class DispositivosModule {}
