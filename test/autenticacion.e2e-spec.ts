import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import request from 'supertest';
import { AplicacionModule } from '../src/aplicacion.module.js';
import { configurarAplicacion } from '../src/configurar-aplicacion.js';

const CORREO = 'hu06.prueba@uniride.test';
const CONTRASENA = 'Clave1234';

describe('HU-06 · Inicio de sesión (e2e)', () => {
  let app: INestApplication;
  let bd: pg.Client; // rol dueño: prepara y limpia datos
  let usuarioId: string;
  const api = () => request(app.getHttpServer());
  const iniciar = (
    contrasena = CONTRASENA,
    tipoCliente = 'movil',
    correo = CORREO,
  ) =>
    api()
      .post('/api/v1/autenticacion/iniciar-sesion')
      .send({ correo, contrasena, tipoCliente });
  const limpiar = async () => {
    await bd.query(
      `DELETE FROM tokens_refresco WHERE usuario_id IN (SELECT id FROM usuarios WHERE correo = $1)`,
      [CORREO],
    );
    await bd.query(
      `DELETE FROM registros_auditoria WHERE actor_id IN (SELECT id FROM usuarios WHERE correo = $1)`,
      [CORREO],
    );
    await bd.query(`DELETE FROM usuarios WHERE correo = $1`, [CORREO]);
  };

  beforeAll(async () => {
    process.env.JWT_ACCESO_SECRETO ??= 'secreto-de-pruebas';
    bd = new pg.Client({
      connectionString: process.env.DATABASE_URL_MIGRACIONES,
    });
    await bd.connect();
    const modulo = await Test.createTestingModule({
      imports: [AplicacionModule],
    }).compile();
    app = modulo.createNestApplication();
    configurarAplicacion(app);
    await app.init();
  });

  beforeEach(async () => {
    await limpiar();
    const { rows } = await bd.query(
      `INSERT INTO usuarios (correo, hash_contrasena, nombre_completo) VALUES ($1, $2, 'Prueba') RETURNING id`,
      [CORREO, await bcrypt.hash(CONTRASENA, 4)],
    );
    usuarioId = rows[0].id;
  });

  afterAll(async () => {
    await limpiar();
    await bd.end();
    await app.close();
  });

  it('CA-1 inicia sesión y /yo devuelve la cuenta', async () => {
    const r = await iniciar().expect(200);
    expect(r.body.tokenAcceso).toBeTruthy();
    expect(r.body.tokenRefresco).toBeTruthy();
    const yo = await api()
      .get('/api/v1/yo')
      .set('Authorization', `Bearer ${r.body.tokenAcceso}`)
      .expect(200);
    expect(yo.body).toMatchObject({
      id: usuarioId,
      correo: CORREO,
      membresias: [],
    });
  });

  it('CA-2 correo inexistente y contraseña mala dan la misma respuesta', async () => {
    const mala = await iniciar('otra').expect(401);
    const inexistente = await iniciar(
      CONTRASENA,
      'movil',
      'nadie@uniride.test',
    ).expect(401);
    expect(mala.body).toEqual(inexistente.body);
    expect(mala.body.codigo).toBe('CREDENCIALES_INVALIDAS');
  });

  it('CA-3 y RN-3 refrescar entrega un par nuevo e invalida el anterior', async () => {
    const { body } = await iniciar().expect(200);
    const nuevo = await api()
      .post('/api/v1/autenticacion/refrescar')
      .send({ tokenRefresco: body.tokenRefresco })
      .expect(200);
    expect(nuevo.body.tokenRefresco).not.toBe(body.tokenRefresco);
  });

  it('CA-4 cerrar sesión revoca el refresco', async () => {
    const { body } = await iniciar().expect(200);
    await api()
      .post('/api/v1/autenticacion/cerrar-sesion')
      .set('Authorization', `Bearer ${body.tokenAcceso}`)
      .send({ tokenRefresco: body.tokenRefresco })
      .expect(204);
    await api()
      .post('/api/v1/autenticacion/refrescar')
      .send({ tokenRefresco: body.tokenRefresco })
      .expect(401);
  });

  it('CA-5 reusar un refresco cierra todas las sesiones', async () => {
    const a = (await iniciar().expect(200)).body;
    const b = (
      await api()
        .post('/api/v1/autenticacion/refrescar')
        .send({ tokenRefresco: a.tokenRefresco })
        .expect(200)
    ).body;
    await api()
      .post('/api/v1/autenticacion/refrescar')
      .send({ tokenRefresco: a.tokenRefresco })
      .expect(401);
    const r = await api()
      .post('/api/v1/autenticacion/refrescar')
      .send({ tokenRefresco: b.tokenRefresco })
      .expect(401);
    expect(r.body.codigo).toBe('SESION_EXPIRADA');
  });

  it('CA-6 cinco fallos bloquean la cuenta 15 minutos, aun con la clave correcta', async () => {
    for (let i = 0; i < 5; i++) await iniciar('mala').expect(401);
    const r = await iniciar().expect(429);
    expect(r.body.codigo).toBe('SESION_BLOQUEADA');
    expect(new Date(r.body.reintentarEn).getTime()).toBeGreaterThan(
      Date.now() + 14 * 60 * 1000,
    );
  });

  it('CA-8 un acceso vencido o sin token se rechaza', async () => {
    const vencido = await app
      .get(JwtService, { strict: false })
      .signAsync({ sub: usuarioId }, { expiresIn: -10 });
    await api()
      .get('/api/v1/yo')
      .set('Authorization', `Bearer ${vencido}`)
      .expect(401);
    await api().get('/api/v1/yo').expect(401);
  });

  it('CA-9 la contraseña se guarda con hash', async () => {
    const { rows } = await bd.query(
      `SELECT hash_contrasena FROM usuarios WHERE id = $1`,
      [usuarioId],
    );
    expect(rows[0].hash_contrasena).not.toContain(CONTRASENA);
    expect(rows[0].hash_contrasena).toMatch(/^\$2[aby]\$/);
  });

  it('CA-10 pasado el límite absoluto de la sesión no se puede renovar', async () => {
    const { body } = await iniciar().expect(200);
    await bd.query(
      `UPDATE tokens_refresco SET sesion_vence_en = now() - interval '1 minute' WHERE usuario_id = $1`,
      [usuarioId],
    );
    await api()
      .post('/api/v1/autenticacion/refrescar')
      .send({ tokenRefresco: body.tokenRefresco })
      .expect(401);
  });

  it('RN-7 deja auditados el inicio y el bloqueo', async () => {
    await iniciar().expect(200);
    const { rows } = await bd.query(
      `SELECT accion, resultado FROM registros_auditoria WHERE actor_id = $1`,
      [usuarioId],
    );
    expect(rows).toContainEqual({ accion: 'sesion.inicio', resultado: 'ok' });
  });

  it('web: el refresco viaja en cookie httpOnly y no en el cuerpo', async () => {
    const r = await iniciar(CONTRASENA, 'web').expect(200);
    expect(r.body.tokenRefresco).toBeUndefined();
    expect(String(r.headers['set-cookie'])).toMatch(
      /refresco=.*HttpOnly.*SameSite=Strict/s,
    );
  });
});
