import { Module } from '@nestjs/common';
import { IaModule } from '../ia/ia.module.js';
import { AsistenteController } from './asistente.controller.js';
import { AsistenteGuard } from './asistente.guard.js';
import { AsistenteService } from './asistente.service.js';

@Module({
  imports: [IaModule],
  controllers: [AsistenteController],
  providers: [AsistenteService, AsistenteGuard],
  exports: [AsistenteService],
})
export class AsistenteModule {}
