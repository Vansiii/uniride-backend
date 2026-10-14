import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** Configuración compartida por main.ts y las pruebas e2e. */
export function configurarAplicacion(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');

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
