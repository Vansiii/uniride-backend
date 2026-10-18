import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { JwtGuard } from '../comun/jwt.guard.js';
import { AutenticacionController } from './autenticacion.controller.js';
import { AutenticacionService } from './autenticacion.service.js';
import { YoController } from './yo.controller.js';

@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_ACCESO_SECRETO,
        signOptions: {
          expiresIn: (process.env.JWT_ACCESO_DURACION ?? '15m') as '15m',
        },
      }),
    }),
  ],
  controllers: [AutenticacionController, YoController],
  providers: [AutenticacionService, { provide: APP_GUARD, useClass: JwtGuard }],
})
export class AutenticacionModule {}
