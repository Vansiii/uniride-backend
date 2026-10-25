import { PrismaService } from '../comun/prisma.service.js';
import { CorreosService } from './correos.service.js';
import { crearEnviador } from './enviador.js';
import { renderizar } from './plantillas.js';

function crear() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'c-1' }]),
    correoSaliente: {
      create: vi.fn().mockResolvedValue({}),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: 'c-1',
        destinatario: 'ana@uagrm.edu.bo',
        plantilla: 'ya_tienes_cuenta',
        datos: {},
        intentos: 1,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const servicio = new CorreosService(prisma as unknown as PrismaService);
  const enviar = vi.fn().mockResolvedValue(undefined);
  servicio.enviador = { enviar };
  return { servicio, tx, enviar };
}

afterEach(() => vi.unstubAllEnvs());

describe('plantillas', () => {
  it('otp_registro: el código y los minutos de vigencia (HU-05 CA-1)', () => {
    const c = renderizar('otp_registro', { codigo: '042817', minutos: 10 });
    expect(c.asunto).toBe('Tu código de UniRide: 042817');
    expect(c.texto).toContain('042817');
    expect(c.texto).toContain('Vence en 10 minutos');
  });

  it('ya_tienes_cuenta: avisa sin código (HU-05 CA-7)', () => {
    const c = renderizar('ya_tienes_cuenta', { codigo: '042817' });
    expect(c.asunto).toBe('Ya tienes una cuenta en UniRide');
    expect(c.texto).not.toMatch(/\d{6}/);
  });

  it('un dato faltante queda vacío', () => {
    expect(renderizar('otp_registro', {}).asunto).toBe(
      'Tu código de UniRide: ',
    );
  });
});

describe('crearEnviador', () => {
  it('consola en desarrollo; ses si se pide', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('CORREO_MODO', 'consola');
    expect(crearEnviador().constructor.name).toBe('EnviadorConsola');
    vi.stubEnv('CORREO_MODO', 'ses');
    expect(crearEnviador().constructor.name).toBe('EnviadorSes');
  });

  it('consola está prohibida en producción, y un modo desconocido también', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CORREO_MODO', 'consola');
    expect(() => crearEnviador()).toThrow('CORREO_MODO');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('CORREO_MODO', 'otro');
    expect(() => crearEnviador()).toThrow('CORREO_MODO');
  });

  it('el enviador de consola no falla', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('CORREO_MODO', 'consola');
    await expect(
      crearEnviador().enviar('ana@uagrm.edu.bo', { asunto: 'a', texto: 'b' }),
    ).resolves.toBeUndefined();
  });
});

describe('CorreosService', () => {
  it('enviarAhora: renderiza y envía en el momento, sin pasar por la cola', async () => {
    const { servicio, tx, enviar } = crear();
    await servicio.enviarAhora('ana@uagrm.edu.bo', 'otp_registro', {
      codigo: '042817',
      minutos: 10,
    });
    expect(enviar).toHaveBeenCalledWith('ana@uagrm.edu.bo', {
      asunto: 'Tu código de UniRide: 042817',
      texto: expect.stringContaining('042817'),
    });
    expect(tx.correoSaliente.create).not.toHaveBeenCalled();
  });

  it('enviarAhora: si el envío falla, lanza para que el llamador revierta', async () => {
    const { servicio, enviar } = crear();
    enviar.mockRejectedValue(new Error('SES caído'));
    await expect(
      servicio.enviarAhora('ana@uagrm.edu.bo', 'otp_registro', {}),
    ).rejects.toThrow('SES caído');
  });

  it('encolar: guarda el correo en la transacción del llamador', async () => {
    const { servicio, tx } = crear();
    await servicio.encolar(tx as never, {
      destinatario: 'ana@uagrm.edu.bo',
      plantilla: 'ya_tienes_cuenta',
      datos: {},
    });
    expect(tx.correoSaliente.create).toHaveBeenCalledWith({
      data: {
        destinatario: 'ana@uagrm.edu.bo',
        plantilla: 'ya_tienes_cuenta',
        datos: {},
      },
    });
  });

  it('procesarPendientes: envía, marca enviado y borra los datos', async () => {
    const { servicio, tx, enviar } = crear();
    expect(await servicio.procesarPendientes()).toBe(1);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(tx.correoSaliente.update).toHaveBeenCalledWith({
      where: { id: 'c-1' },
      data: { estado: 'enviado', datos: {}, ultimoError: null },
    });
  });

  it('procesarPendientes: un fallo suma un intento y reprograma con espera creciente', async () => {
    const { servicio, tx, enviar } = crear();
    enviar.mockRejectedValue(new Error('SES caído'));
    expect(await servicio.procesarPendientes()).toBe(0);
    expect(tx.correoSaliente.update).toHaveBeenCalledWith({
      where: { id: 'c-1' },
      data: expect.objectContaining({
        intentos: 2,
        estado: 'pendiente',
        ultimoError: 'Error: SES caído',
      }),
    });
  });
});
