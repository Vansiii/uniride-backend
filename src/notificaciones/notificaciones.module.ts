import { Global, Module } from '@nestjs/common';
import { CorreosService } from './correos.service.js';
import { PushController } from './push.controller.js';
import { PushService } from './push.service.js';

@Global()
@Module({
  controllers: [PushController],
  providers: [CorreosService, PushService],
  exports: [CorreosService, PushService],
})
export class NotificacionesModule {}
