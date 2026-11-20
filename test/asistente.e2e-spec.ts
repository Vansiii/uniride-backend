import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AplicacionModule } from '../src/aplicacion.module.js';
import { configurarAplicacion } from '../src/configurar-aplicacion.js';

describe('Asistente (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      imports: [AplicacionModule],
    }).compile();
    app = modulo.createNestApplication();
    configurarAplicacion(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('A-08: POST /api/v1/asistente/consultar sin token responde 401 Unauthorized', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/asistente/consultar')
      .send({ consulta: 'cuál es mi saldo?' })
      .expect(401);
  });

  it('expone el endpoint del asistente en Swagger /api/docs-json', async () => {
    const respuesta = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);
    expect(respuesta.body.paths).toHaveProperty('/api/v1/asistente/consultar');
  });
});
