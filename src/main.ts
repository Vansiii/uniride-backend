// Carga variables de entorno en desarrollo local antes de inicializar los modulos.
try {
  process.loadEnvFile();
} catch {
  try {
    process.loadEnvFile('../.env');
  } catch {
    // En Docker o CI las variables ya vienen inyectadas en el entorno.
  }
}

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
