import { Module } from '@nestjs/common';
import { BilleteraModule } from '../billetera/billetera.module.js';
import { AlmacenamientoModule } from '../comun/almacenamiento.module.js';
import { IdentidadVerificadaGuard } from '../comun/identidad.guard.js';
import { RekognitionService } from '../comun/rekognition.service.js';
import { IdentidadController } from './identidad.controller.js';
import { IdentidadService } from './identidad.service.js';

/** HU-12, HU-17 y HU-19 importan este módulo para usar `@RequiereIdentidadVerificada()` (exporta el guard). */
@Module({
  imports: [AlmacenamientoModule, BilleteraModule],
  controllers: [IdentidadController],
  providers: [IdentidadService, RekognitionService, IdentidadVerificadaGuard],
  exports: [IdentidadVerificadaGuard, IdentidadService],
})
export class IdentidadModule {}
