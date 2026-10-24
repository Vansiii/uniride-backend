import { Global, Module } from '@nestjs/common';
import { CorreosService } from './correos.service.js';

@Global()
@Module({ providers: [CorreosService], exports: [CorreosService] })
export class NotificacionesModule {}
