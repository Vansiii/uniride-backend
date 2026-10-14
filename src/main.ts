import { NestFactory } from '@nestjs/core';
import { AplicacionModule } from './aplicacion.module.js';
import { configurarAplicacion } from './configurar-aplicacion.js';

async function iniciar() {
  const app = await NestFactory.create(AplicacionModule);
  configurarAplicacion(app);
  await app.listen(process.env.PORT ?? 3000);
}
await iniciar();
