import { Module } from '@nestjs/common';
import { AuditoriaModule } from './auditoria/auditoria.module.js';
import { AutenticacionModule } from './autenticacion/autenticacion.module.js';
import { MembresiasModule } from './membresias/membresias.module.js';
import { NotificacionesModule } from './notificaciones/notificaciones.module.js';
import { OrganizacionesModule } from './organizaciones/organizaciones.module.js';
import { SaludController } from './salud/salud.controller.js';
import { VehiculosModule } from './vehiculos/vehiculos.module.js';

@Module({
  imports: [
    AuditoriaModule,
    NotificacionesModule,
    AutenticacionModule,
    OrganizacionesModule,
    MembresiasModule,
    VehiculosModule,
  ],
  controllers: [SaludController],
})
export class AplicacionModule {}
