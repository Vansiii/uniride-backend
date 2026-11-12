import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { FiltroErrores } from './comun/filtro-errores.filter.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** Configuración compartida por main.ts y las pruebas e2e. */
export function configurarAplicacion(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');
  // Sin ETag: las respuestas son datos privados de cada usuario, y un 304 tras renovar la sesión llegaba a la app
  // como error («Algo salió mal»).
  app.getHttpAdapter().getInstance().set('etag', false);
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new FiltroErrores());

  const documento = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('UniRide API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('api/docs', app, documento);
}
