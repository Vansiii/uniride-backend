import { NestFactory } from '@nestjs/core';
import { AplicacionModule } from './aplicacion.module.js';
import { configurarAplicacion } from './configurar-aplicacion.js';

async function iniciar() {
  const app = await NestFactory.create(AplicacionModule, {
    // El guard de firma del dispositivo firma el cuerpo crudo (A-08).
    rawBody: true,
  });
  configurarAplicacion(app);
  await app.listen(process.env.PORT ?? 3000);
}
await iniciar();
