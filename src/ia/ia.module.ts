import { Module } from '@nestjs/common';
import { GroqServicio } from './groq.servicio.js';
import { IaLocalServicio } from './ia-local.servicio.js';
import { IaServicio } from './ia.servicio.js';

/** Proveedores de IA del backend: Groq (asistente) y la cadena IA local → Groq (PB-10). */
@Module({
  providers: [GroqServicio, IaLocalServicio, IaServicio],
  exports: [GroqServicio, IaServicio],
})
export class IaModule {}
