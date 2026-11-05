import { Global, Module } from '@nestjs/common';
import { PrismaService } from '../comun/prisma.service.js';
import { AuditoriaService } from './auditoria.service.js';

@Global()
@Module({
  providers: [PrismaService, AuditoriaService],
  exports: [PrismaService, AuditoriaService],
})
export class AuditoriaModule {}
