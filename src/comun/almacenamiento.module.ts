import { Module } from '@nestjs/common';
import { AlmacenamientoService } from './almacenamiento.service.js';

/** Una sola instancia de `AlmacenamientoService` para vehículos e identidad (y las pruebas la reemplazan una vez). */
@Module({
  providers: [AlmacenamientoService],
  exports: [AlmacenamientoService],
})
export class AlmacenamientoModule {}
