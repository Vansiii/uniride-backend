import { Module } from '@nestjs/common';
import { AuditoriaModule } from './auditoria/auditoria.module.js';
import { AutenticacionModule } from './autenticacion/autenticacion.module.js';
import { SaludController } from './salud/salud.controller.js';

@Module({
  imports: [AuditoriaModule, AutenticacionModule],
  controllers: [SaludController],
})
export class AplicacionModule {}
