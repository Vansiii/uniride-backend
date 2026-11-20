import { Module } from '@nestjs/common';
import { AsistenteController } from './asistente.controller.js';
import { AsistenteService } from './asistente.service.js';
import { GroqServicio } from './groq.servicio.js';

@Module({
  controllers: [AsistenteController],
  providers: [GroqServicio, AsistenteService],
  exports: [AsistenteService],
})
export class AsistenteModule {}

