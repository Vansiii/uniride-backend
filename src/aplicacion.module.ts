import { Module } from '@nestjs/common';
import { SaludController } from './salud/salud.controller.js';

@Module({
  controllers: [SaludController],
})
export class AplicacionModule {}
