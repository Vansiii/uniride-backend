import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { App } from 'supertest/types';
import { vi } from 'vitest';
import { AplicacionModule } from '../src/aplicacion.module.js';
import { configurarAplicacion } from '../src/configurar-aplicacion.js';
import { PrismaService } from '../src/comun/prisma.service.js';

describe('Asistente (e2e)', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  const secretoJwt = process.env.JWT_ACCESO_SECRETO || 'secreto-pruebas-asistente';

  beforeAll(async () => {
    process.env.JWT_ACCESO_SECRETO = secretoJwt;
    const modulo = await Test.createTestingModule({
      imports: [AplicacionModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        usuario: { findUnique: vi.fn().mockResolvedValue(null) },
        enOrganizacion: vi.fn().mockResolvedValue(null),
      })
      .compile();

    app = modulo.createNestApplication();
    configurarAplicacion(app);
    await app.init();
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('A-08: POST /api/v1/asistente/consultar sin token responde 401 Unauthorized', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/asistente/consultar')
      .send({ consulta: 'cuál es mi saldo?' })
      .expect(401);

    expect(res.body.codigo).toBe('NO_AUTENTICADO');
  });

  it('A-13: Un token con organización donde no tiene membresía aprobada responde 403 Forbidden', async () => {
    const tokenInvalido = await jwt.signAsync(
      {
        sub: 'usuario-sin-membresia',
        org: '00000000-0000-0000-0000-000000000000',
        cli: 'movil',
      },
      { secret: secretoJwt },
    );

    const res = await request(app.getHttpServer())
      .post('/api/v1/asistente/consultar')
      .set('Authorization', `Bearer ${tokenInvalido}`)
      .send({ consulta: 'buscar viaje' })
      .expect(403);

    expect(res.body.codigo).toBe('NO_AUTORIZADO');
  });

  it('A-11: Si la consulta solicita reservar o mover dinero sin token, se rechaza inmediatamente', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/asistente/consultar')
      .send({ consulta: 'reserva el primer viaje y paga 12 URC' })
      .expect(401);

    expect(res.body.codigo).toBe('NO_AUTENTICADO');
  });

  it('expone el endpoint del asistente en Swagger /api/docs-json', async () => {
    const respuesta = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);
    expect(respuesta.body.paths).toHaveProperty('/api/v1/asistente/consultar');
  });
});
