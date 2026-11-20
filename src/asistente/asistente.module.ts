import { Module } from '@nestjs/common';
import { AsistenteController } from './asistente.controller.js';
import { AsistenteGuard } from './asistente.guard.js';
import { AsistenteService } from './asistente.service.js';
import { GroqServicio } from './groq.servicio.js';

@Module({
  controllers: [AsistenteController],
  providers: [GroqServicio, AsistenteService, AsistenteGuard],
  exports: [AsistenteService],
})
export class AsistenteModule {}

