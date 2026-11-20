import { generateKeyPairSync, createVerify } from 'node:crypto';
import { PrismaService } from '../comun/prisma.service.js';
import { crearEnviadorPush, EnviadorFcm, TokenPushInvalido } from './fcm.js';
import { PushService, renderizarPush } from './push.service.js';

function crear(tokenPush: string | null = 'tok-1', intentos = 0) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'n-1' }]),
    notificacionPush: {
      create: vi.fn().mockResolvedValue({}),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: 'n-1',
        plantilla: 'pago_recibido',
        datos: { monto: '10.00', destino: 'UAGRM', ruta: '/movimientos' },
        intentos,
        usuario: { tokenPush },
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    usuario: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    $transaction: vi.fn((fn: unknown) =>
      Array.isArray(fn)
        ? Promise.all(fn)
        : (fn as (t: typeof tx) => unknown)(tx),
    ),
    usuario: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const servicio = new PushService(prisma as unknown as PrismaService);
  const enviar = vi.fn().mockResolvedValue(undefined);
  servicio.enviador = { enviar };
  return { servicio, tx, prisma, enviar };
}

afterEach(() => vi.unstubAllEnvs());

describe('renderizarPush', () => {
  it('rellena título, cuerpo y ruta en es-BO', () => {
    expect(
      renderizarPush('pago_recibido', {
        monto: '10.00',
        destino: 'UAGRM',
        ruta: '/movimientos',
      }),
    ).toEqual({
      titulo: 'Recibiste un pago',
      cuerpo:
        'Se liberaron 10.00 URC del viaje a UAGRM. Ya están en tu billetera.',
      ruta: '/movimientos',
    });
  });
});

describe('PushService', () => {
  it('encola en la transacción del llamador', async () => {
    const { servicio, tx } = crear();
    await servicio.encolar(tx as never, 'u-1', 'prueba', { nombre: 'Ana' });
    expect(tx.notificacionPush.create).toHaveBeenCalledWith({
      data: { usuarioId: 'u-1', plantilla: 'prueba', datos: { nombre: 'Ana' } },
    });
  });

  it('envía al token del usuario y marca enviado', async () => {
    const { servicio, tx, enviar } = crear();
    await expect(servicio.procesarPendientes()).resolves.toBe(1);
    expect(enviar).toHaveBeenCalledWith(
      'tok-1',
      expect.objectContaining({ titulo: 'Recibiste un pago' }),
    );
    expect(tx.notificacionPush.update).toHaveBeenCalledWith({
      where: { id: 'n-1' },
      data: { estado: 'enviado', ultimoError: null },
    });
  });

  it('sin sesión en ningún teléfono: no envía y queda sin_token', async () => {
    const { servicio, tx, enviar } = crear(null);
    await expect(servicio.procesarPendientes()).resolves.toBe(0);
    expect(enviar).not.toHaveBeenCalled();
    expect(tx.notificacionPush.update).toHaveBeenCalledWith({
      where: { id: 'n-1' },
      data: { estado: 'sin_token' },
    });
  });

  it('token inválido para FCM: lo borra y no reintenta', async () => {
    const { servicio, tx, enviar } = crear();
    enviar.mockRejectedValue(new TokenPushInvalido('FCM respondió 404'));
    await servicio.procesarPendientes();
    expect(tx.usuario.updateMany).toHaveBeenCalledWith({
      where: { tokenPush: 'tok-1' },
      data: { tokenPush: null },
    });
    expect(tx.notificacionPush.update.mock.calls[0][0].data.estado).toBe(
      'sin_token',
    );
  });

  it('falla transitoria: reintenta con espera y al quinto intento queda fallido', async () => {
    const a = crear('tok-1', 0);
    a.enviar.mockRejectedValue(new Error('FCM respondió 503'));
    await a.servicio.procesarPendientes();
    const datos = a.tx.notificacionPush.update.mock.calls[0][0].data;
    expect(datos).toMatchObject({ intentos: 1, estado: 'pendiente' });
    expect(datos.proximoIntentoEn.getTime()).toBeGreaterThan(Date.now());

    const b = crear('tok-1', 4);
    b.enviar.mockRejectedValue(new Error('FCM respondió 503'));
    await b.servicio.procesarPendientes();
    expect(b.tx.notificacionPush.update.mock.calls[0][0].data.estado).toBe(
      'fallido',
    );
  });

  it('apagado: no toca la cola', async () => {
    const { servicio, prisma } = crear();
    servicio.enviador = null;
    await expect(servicio.procesarPendientes()).resolves.toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('un token es de un solo usuario: se quita a la otra cuenta del mismo teléfono', async () => {
    const { servicio, prisma } = crear();
    await servicio.guardarToken('u-2', 'tok-1');
    expect(prisma.usuario.updateMany).toHaveBeenCalledWith({
      where: { tokenPush: 'tok-1', NOT: { id: 'u-2' } },
      data: { tokenPush: null },
    });
    expect(prisma.usuario.update).toHaveBeenCalledWith({
      where: { id: 'u-2' },
      data: { tokenPush: 'tok-1' },
    });
  });
});

describe('EnviadorFcm', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const cuenta = {
    project_id: 'uniride-test',
    client_email: 'push@uniride-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  const respuesta = (status: number, cuerpo: unknown = {}) =>
    new Response(JSON.stringify(cuerpo), { status });

  it('firma el JWT con la cuenta de servicio y envía el mensaje v1 con canal y ruta', async () => {
    const llamar = vi
      .fn()
      .mockResolvedValueOnce(
        respuesta(200, { access_token: 'ya29', expires_in: 3600 }),
      )
      .mockResolvedValue(respuesta(200));
    const fcm = new EnviadorFcm(cuenta, llamar as unknown as typeof fetch);
    await fcm.enviar('tok-1', {
      titulo: 'T',
      cuerpo: 'C',
      ruta: '/reserva/r1',
    });
    await fcm.enviar('tok-2', { titulo: 'T', cuerpo: 'C' });

    // El token OAuth se reutiliza: una sola llamada a Google.
    expect(llamar).toHaveBeenCalledTimes(3);
    const assertion = new URLSearchParams(
      llamar.mock.calls[0][1].body as URLSearchParams,
    ).get('assertion')!;
    const [cab, rec, firma] = assertion.split('.');
    expect(
      createVerify('RSA-SHA256')
        .update(`${cab}.${rec}`)
        .verify(publicKey, Buffer.from(firma, 'base64url')),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(rec, 'base64url').toString())).toMatchObject({
      iss: cuenta.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
    });

    const [url, init] = llamar.mock.calls[1];
    expect(url).toBe(
      'https://fcm.googleapis.com/v1/projects/uniride-test/messages:send',
    );
    expect(init.headers.authorization).toBe('Bearer ya29');
    expect(JSON.parse(init.body).message).toEqual({
      token: 'tok-1',
      notification: { title: 'T', body: 'C' },
      data: { ruta: '/reserva/r1' },
      android: {
        priority: 'HIGH',
        notification: { channel_id: 'avisos', sound: 'default' },
      },
    });
  });

  it('404 de FCM = token inválido; 503 = error para reintentar', async () => {
    const llamar = vi
      .fn()
      .mockResolvedValueOnce(
        respuesta(200, { access_token: 'ya29', expires_in: 3600 }),
      )
      .mockResolvedValueOnce(respuesta(404))
      .mockResolvedValueOnce(respuesta(503));
    const fcm = new EnviadorFcm(cuenta, llamar as unknown as typeof fetch);
    const p = { titulo: 'T', cuerpo: 'C' };
    await expect(fcm.enviar('tok', p)).rejects.toBeInstanceOf(
      TokenPushInvalido,
    );
    await expect(fcm.enviar('tok', p)).rejects.not.toBeInstanceOf(
      TokenPushInvalido,
    );
  });
});

describe('crearEnviadorPush', () => {
  it('apagado devuelve null; consola prohibida en producción; fcm exige la cuenta', () => {
    vi.stubEnv('PUSH_MODO', 'apagado');
    expect(crearEnviadorPush()).toBeNull();
    vi.stubEnv('PUSH_MODO', 'consola');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => crearEnviadorPush()).toThrow(/prohibido/);
    vi.stubEnv('PUSH_MODO', 'fcm');
    vi.stubEnv('FCM_CUENTA_SERVICIO_B64', '');
    expect(() => crearEnviadorPush()).toThrow(/FCM_CUENTA_SERVICIO_B64/);
  });
});
