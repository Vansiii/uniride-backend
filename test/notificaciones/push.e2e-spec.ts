import { PushService } from '../../src/notificaciones/push.service.js';
import {
  DOMINIO,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';

describe('PB-09 · Notificaciones push (e2e)', () => {
  let e: Entorno;
  let push: PushService;
  const enviar = vi.fn().mockResolvedValue(undefined);
  const token = async (correo: string) =>
    (
      await e.bd.query(`SELECT token_push FROM usuarios WHERE correo = $1`, [
        correo,
      ])
    ).rows[0].token_push;
  const registrar = (acceso: string, valor: string) =>
    e
      .api()
      .put('/api/v1/yo/token-push')
      .set({ Authorization: `Bearer ${acceso}` })
      .send({ token: valor });

  beforeAll(async () => {
    e = await prepararEntorno();
    push = e.app.get(PushService);
    push.enviador = { enviar };
  });
  afterAll(() => e.cerrar());

  it('sin sesión: 401', async () => {
    await e.api().put('/api/v1/yo/token-push').send({ token: 'x' }).expect(401);
  });

  it('token con caracteres inválidos: 400', async () => {
    await e.crearUsuario(`valida${DOMINIO}`);
    const acceso = await e.iniciar(`valida${DOMINIO}`);
    await registrar(acceso, 'a b<script>').expect(400);
  });

  it('registra el token, el aviso de prueba llega a ese teléfono y cerrar sesión lo borra', async () => {
    await e.crearUsuario(`ana${DOMINIO}`);
    const acceso = await e.iniciar(`ana${DOMINIO}`);
    await registrar(acceso, 'fcm:tok-ana').expect(204);
    expect(await token(`ana${DOMINIO}`)).toBe('fcm:tok-ana');

    await e
      .api()
      .post('/api/v1/yo/token-push/prueba')
      .set({ Authorization: `Bearer ${acceso}` })
      .expect(204);
    await push.procesarPendientes();
    expect(enviar).toHaveBeenCalledWith(
      'fcm:tok-ana',
      expect.objectContaining({ titulo: 'Notificaciones activas' }),
    );

    await e
      .api()
      .post('/api/v1/autenticacion/cerrar-sesion')
      .set({ Authorization: `Bearer ${acceso}` })
      .send({})
      .expect(204);
    expect(await token(`ana${DOMINIO}`)).toBeNull();
  });

  it('mismo teléfono, otra cuenta: el token pasa a la nueva y la anterior deja de recibir avisos', async () => {
    await e.crearUsuario(`luis${DOMINIO}`);
    await e.crearUsuario(`eva${DOMINIO}`);
    await registrar(await e.iniciar(`luis${DOMINIO}`), 'fcm:compartido').expect(
      204,
    );
    await registrar(await e.iniciar(`eva${DOMINIO}`), 'fcm:compartido').expect(
      204,
    );
    expect(await token(`luis${DOMINIO}`)).toBeNull();
    expect(await token(`eva${DOMINIO}`)).toBe('fcm:compartido');
  });

  it('el aviso de un usuario sin token no se envía a nadie', async () => {
    const id = await e.crearUsuario(`sintoken${DOMINIO}`);
    const { rows } = await e.bd.query(
      `INSERT INTO notificaciones_push (usuario_id, plantilla, datos) VALUES ($1, 'prueba', '{}') RETURNING id`,
      [id],
    );
    enviar.mockClear();
    await push.procesarPendientes();
    expect(enviar).not.toHaveBeenCalled();
    const fila = await e.bd.query(
      `SELECT estado FROM notificaciones_push WHERE id = $1`,
      [rows[0].id],
    );
    expect(fila.rows[0].estado).toBe('sin_token');
  });
});
