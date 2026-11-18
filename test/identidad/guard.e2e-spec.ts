import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AplicacionModule } from '../../src/aplicacion.module.js';
import { RequiereIdentidadVerificada } from '../../src/comun/identidad.guard.js';
import { configurarAplicacion } from '../../src/configurar-aplicacion.js';
import {
  DOMINIO,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';

/** Endpoint de prueba que representa a HU-12, HU-17 y HU-19 (todavía no existen). */
@Controller('prueba-identidad')
class PruebaController {
  @Get()
  @RequiereIdentidadVerificada()
  protegido() {
    return { ok: true };
  }

  @Get('libre')
  libre() {
    return { ok: true };
  }
}

describe('CA-6 · @RequiereIdentidadVerificada (e2e)', () => {
  let e: Entorno;
  let app: INestApplication;
  let n = 0;
  const usuarioEn = async (estado: string | null) => {
    const correo = `guard${++n}${DOMINIO}`;
    const id = await e.crearUsuario(correo);
    if (estado)
      await e.bd.query(
        `INSERT INTO identidades (usuario_id, estado, consentimiento_en, documento_hash, verificado_en)
         VALUES ($1, $2, now(), $3, $4)`,
        [
          id,
          estado,
          estado === 'verificada' ? `hash-guard-${n}` : null,
          estado === 'verificada' ? new Date() : null,
        ],
      );
    return e.iniciar(correo);
  };
  const pedir = (token?: string) => {
    const r = request(app.getHttpServer()).get('/api/v1/prueba-identidad');
    return token ? r.set({ Authorization: `Bearer ${token}` }) : r;
  };

  beforeAll(async () => {
    e = await prepararEntorno();
    const modulo = await Test.createTestingModule({
      imports: [AplicacionModule],
      controllers: [PruebaController],
    }).compile();
    app = modulo.createNestApplication();
    configurarAplicacion(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await e.cerrar();
  });

  it('una identidad verificada pasa', async () => {
    const r = await pedir(await usuarioEn('verificada')).expect(200);
    expect(r.body).toEqual({ ok: true });
  });

  it.each([
    ['sin fila (no verificada)', null],
    ['no_verificada', 'no_verificada'],
    ['en_revision (pendiente)', 'en_revision'],
    ['rechazada', 'rechazada'],
    ['bloqueada_temporal', 'bloqueada_temporal'],
  ])('403 IDENTIDAD_NO_VERIFICADA con %s', async (_, estado) => {
    const r = await pedir(await usuarioEn(estado)).expect(403);
    expect(r.body).toMatchObject({
      codigo: 'IDENTIDAD_NO_VERIFICADA',
      mensaje: 'Debes verificar tu identidad para realizar esta acción.',
    });
  });

  it('sin sesión responde 401 (el JwtGuard global va primero)', async () => {
    const r = await pedir().expect(401);
    expect(r.body.codigo).toBe('NO_AUTENTICADO');
  });

  it('el estado de la BD manda, no el token: al verificarse, el mismo token pasa', async () => {
    const correo = `guard${++n}${DOMINIO}`;
    const id = await e.crearUsuario(correo);
    const token = await e.iniciar(correo);
    await pedir(token).expect(403);
    await e.bd.query(
      `INSERT INTO identidades (usuario_id, estado, consentimiento_en, documento_hash, verificado_en)
       VALUES ($1, 'verificada', now(), $2, now())`,
      [id, `hash-guard-${n}`],
    );
    await pedir(token).expect(200);
  });

  it('un endpoint sin el decorador no se ve afectado', async () => {
    const token = await usuarioEn(null);
    await request(app.getHttpServer())
      .get('/api/v1/prueba-identidad/libre')
      .set({ Authorization: `Bearer ${token}` })
      .expect(200);
  });

  it('la BD rechaza una identidad verificada a medias (sin documento)', async () => {
    const correo = `guard${++n}${DOMINIO}`;
    const id = await e.crearUsuario(correo);
    await expect(
      e.bd.query(
        `INSERT INTO identidades (usuario_id, estado, consentimiento_en) VALUES ($1, 'verificada', now())`,
        [id],
      ),
    ).rejects.toThrow(/identidades_verificada_chk/);
  });
});
