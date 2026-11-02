import { createHmac } from 'node:crypto';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService, type Transaccion } from '../comun/prisma.service.js';
import { CorreosService } from '../notificaciones/correos.service.js';
import { OtpService, proximoEnvio } from './otp.service.js';

const CORREO = 'ana@uagrm.edu.bo';
const AHORA = new Date('2026-10-24T12:00:00.000Z');
const MIN = 60_000;
const hace = (ms: number) => new Date(AHORA.getTime() - ms);
const en = (ms: number) => new Date(AHORA.getTime() + ms);
const hmac = (codigo: string, proposito = 'registro') =>
  createHmac('sha256', 'secreto-unitario')
    .update(`${proposito}:${CORREO}:${codigo}`)
    .digest('hex');

function crear() {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    codigoOtp: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    codigoOtp: {
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({ intentos: 1 }),
    },
  };
  const correos = {
    enviarAhora: vi.fn().mockResolvedValue(undefined),
    encolar: vi.fn().mockResolvedValue(undefined),
  };
  const auditoria = { registrar: vi.fn().mockResolvedValue(undefined) };
  const servicio = new OtpService(
    prisma as unknown as PrismaService,
    correos as unknown as CorreosService,
    auditoria as unknown as AuditoriaService,
  );
  return { servicio, prisma, tx, correos, auditoria };
}

const fila = (extra: object = {}) => ({
  id: 'otp-1',
  hashCodigo: hmac('123456'),
  venceEn: en(10 * MIN),
  intentos: 0,
  bloqueadoHasta: null,
  usadoEn: null,
  datos: { organizacionId: 'org-a' },
  ...extra,
});

const verificar = (
  o: ReturnType<typeof crear>,
  codigo = '123456',
  proposito: 'registro' | 'recuperacion' = 'registro',
) =>
  o.servicio.verificar(
    o.tx as unknown as Transaccion,
    CORREO,
    proposito,
    codigo,
  );

const respuestaDe = (error: unknown) => {
  expect(error).toBeInstanceOf(ErrorNegocio);
  return {
    estado: (error as ErrorNegocio).getStatus(),
    ...((error as ErrorNegocio).getResponse() as object),
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AHORA);
  vi.stubEnv('OTP_SECRETO', 'secreto-unitario');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('proximoEnvio (RN-4)', () => {
  it('sin envíos en la hora: libre', () => {
    expect(proximoEnvio([])).toBeNull();
  });

  it('uno por minuto', () => {
    expect(proximoEnvio([hace(30_000)])).toEqual(en(30_000));
  });

  it('con 5 en la hora, espera a que salga el más antiguo', () => {
    const cinco = [50, 40, 30, 20, 10].map((m) => hace(m * MIN));
    expect(proximoEnvio(cinco)).toEqual(en(10 * MIN));
    expect(proximoEnvio(cinco.slice(1))).toEqual(en(-9 * MIN));
  });
});

describe('OtpService.generar', () => {
  it('CA-1: 6 dígitos, solo su HMAC, vence en 10 minutos, se envía en el momento', async () => {
    const o = crear();
    const r = await o.servicio.generar(CORREO, 'registro', {
      organizacionId: 'org-a',
    });
    expect(r).toEqual({ reenviarEn: en(MIN) });
    const [destinatario, plantilla, datos] = o.correos.enviarAhora.mock
      .calls[0] as [string, string, { codigo: string; minutos: number }];
    expect(destinatario).toBe(CORREO);
    expect(plantilla).toBe('otp_registro');
    expect(datos.codigo).toMatch(/^\d{6}$/);
    expect(datos.minutos).toBe(10);
    const creado = o.tx.codigoOtp.create.mock.calls[0][0].data;
    expect(creado).toMatchObject({
      correo: CORREO,
      proposito: 'registro',
      hashCodigo: hmac(datos.codigo),
      datos: { organizacionId: 'org-a' },
      venceEn: en(10 * MIN),
      intentos: 0,
      creadoEn: AHORA,
    });
    expect(JSON.stringify(creado)).not.toContain(`"${datos.codigo}"`);
    // Serializa por correo y propósito antes de leer nada.
    expect(o.tx.$executeRaw).toHaveBeenCalledBefore(o.tx.codigoOtp.findFirst);
  });

  it('CA-6: invalida los códigos anteriores y borra sus datos', async () => {
    const o = crear();
    await o.servicio.generar(CORREO, 'registro', {});
    expect(o.tx.codigoOtp.updateMany).toHaveBeenCalledWith({
      where: {
        correo: CORREO,
        proposito: 'registro',
        usadoEn: null,
        invalidadoEn: null,
      },
      data: { invalidadoEn: AHORA, datos: {} },
    });
    expect(o.tx.codigoOtp.updateMany).toHaveBeenCalledBefore(
      o.tx.codigoOtp.create,
    );
  });

  it('CA-6 / RN-4: un segundo código antes del minuto → OTP_LIMITE_REENVIO, sin crear ni enviar', async () => {
    const o = crear();
    o.tx.codigoOtp.findMany.mockResolvedValue([{ creadoEn: hace(20_000) }]);
    const error = await o.servicio
      .generar(CORREO, 'registro', {})
      .catch((e) => e);
    expect(respuestaDe(error)).toMatchObject({
      estado: 429,
      codigo: 'OTP_LIMITE_REENVIO',
      reenviarEn: en(40_000).toISOString(),
    });
    expect(o.tx.codigoOtp.create).not.toHaveBeenCalled();
    expect(o.correos.enviarAhora).not.toHaveBeenCalled();
  });

  it('RN-4: el sexto en la hora → OTP_LIMITE_REENVIO; con el quinto avisa cuándo se libera', async () => {
    const o = crear();
    const cuatro = [50, 40, 30, 20].map((m) => ({ creadoEn: hace(m * MIN) }));
    o.tx.codigoOtp.findMany.mockResolvedValue(cuatro);
    expect(await o.servicio.generar(CORREO, 'registro', {})).toEqual({
      reenviarEn: en(10 * MIN),
    });
    o.tx.codigoOtp.findMany.mockResolvedValue([
      ...cuatro,
      { creadoEn: hace(10 * MIN) },
    ]);
    const error = await o.servicio
      .generar(CORREO, 'registro', {})
      .catch((e) => e);
    expect(respuestaDe(error)).toMatchObject({
      codigo: 'OTP_LIMITE_REENVIO',
      reenviarEn: en(10 * MIN).toISOString(),
    });
    // La ventana es la última hora.
    expect(o.tx.codigoOtp.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          correo: CORREO,
          proposito: 'registro',
          creadoEn: { gt: hace(60 * MIN) },
        },
      }),
    );
  });

  it('CA-4: durante el bloqueo no se genera otro código', async () => {
    const o = crear();
    o.tx.codigoOtp.findFirst.mockResolvedValueOnce(
      fila({ bloqueadoHasta: en(5 * MIN) }),
    );
    const error = await o.servicio
      .generar(CORREO, 'registro', {})
      .catch((e) => e);
    expect(respuestaDe(error)).toMatchObject({
      estado: 429,
      codigo: 'OTP_BLOQUEADO',
      reintentarEn: en(5 * MIN).toISOString(),
    });
    expect(o.tx.codigoOtp.create).not.toHaveBeenCalled();
  });

  it('CA-4: los errores siguen contando con el código nuevo; tras un uso empiezan de cero', async () => {
    const o = crear();
    o.tx.codigoOtp.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(fila({ intentos: 3 }));
    await o.servicio.generar(CORREO, 'registro', {});
    expect(o.tx.codigoOtp.create.mock.calls[0][0].data.intentos).toBe(3);
    o.tx.codigoOtp.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(fila({ intentos: 3, usadoEn: hace(MIN) }));
    await o.servicio.generar(CORREO, 'registro', {});
    expect(o.tx.codigoOtp.create.mock.calls[1][0].data.intentos).toBe(0);
  });

  it('aviso (CA-7): envía esa plantilla en vez del código', async () => {
    const o = crear();
    await o.servicio.generar(CORREO, 'registro', {
      aviso: 'ya_tienes_cuenta',
    });
    expect(o.correos.enviarAhora.mock.calls[0][1]).toBe('ya_tienes_cuenta');
  });

  it('si el correo falla → CORREO_NO_DISPONIBLE (la transacción se revierte)', async () => {
    const o = crear();
    o.correos.enviarAhora.mockRejectedValue(new Error('SES caído'));
    const error = await o.servicio
      .generar(CORREO, 'registro', {})
      .catch((e) => e);
    expect(respuestaDe(error)).toMatchObject({
      estado: 503,
      codigo: 'CORREO_NO_DISPONIBLE',
    });
  });

  it('sin OTP_SECRETO no genera códigos', async () => {
    vi.stubEnv('OTP_SECRETO', '');
    const o = crear();
    await expect(o.servicio.generar(CORREO, 'registro', {})).rejects.toThrow(
      'OTP_SECRETO',
    );
    expect(o.correos.enviarAhora).not.toHaveBeenCalled();
  });
});

describe('OtpService.verificar', () => {
  it('CA-2: código correcto y vigente → lo consume una sola vez y devuelve sus datos', async () => {
    const o = crear();
    o.tx.codigoOtp.findFirst.mockResolvedValue(fila());
    await expect(verificar(o)).resolves.toEqual({ organizacionId: 'org-a' });
    expect(o.tx.codigoOtp.updateMany).toHaveBeenCalledWith({
      where: { id: 'otp-1', usadoEn: null },
      data: { usadoEn: AHORA, datos: {} },
    });
  });

  it('dos verificaciones simultáneas: la que no consume → OTP_INVALIDO', async () => {
    const o = crear();
    o.tx.codigoOtp.findFirst.mockResolvedValue(fila());
    o.tx.codigoOtp.updateMany.mockResolvedValue({ count: 0 });
    await expect(verificar(o)).rejects.toMatchObject({
      codigo: 'OTP_INVALIDO',
    });
  });

  it('código incorrecto → OTP_INVALIDO y suma un error fuera de la transacción', async () => {
    const o = crear();
    o.tx.codigoOtp.findFirst.mockResolvedValue(fila());
    const error = await verificar(o, '654321').catch((e) => e);
    expect(respuestaDe(error)).toMatchObject({
      estado: 400,
      codigo: 'OTP_INVALIDO',
    });
    expect(o.prisma.codigoOtp.update).toHaveBeenCalledWith({
      where: { id: 'otp-1' },
      data: { intentos: { increment: 1 } },
    });
    expect(o.tx.codigoOtp.updateMany).not.toHaveBeenCalled();
  });

  it('CA-4: el quinto error seguido bloquea 15 minutos y se audita', async () => {
    const o = crear();
    o.tx.codigoOtp.findFirst.mockResolvedValue(fila({ intentos: 4 }));
    o.prisma.codigoOtp.update.mockResolvedValueOnce({ intentos: 5 });
    const error = await verificar(o, '654321').catch((e) => e);
    expect(respuestaDe(error)).toMatchObject({
      estado: 429,
      codigo: 'OTP_BLOQUEADO',
      reintentarEn: en(15 * MIN).toISOString(),
    });
    expect(o.prisma.codigoOtp.update).toHaveBeenLastCalledWith({
      where: { id: 'otp-1' },
      data: { intentos: 0, bloqueadoHasta: en(15 * MIN) },
    });
    expect(o.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'otp.bloqueo', entidadId: 'otp-1' }),
    );
  });

  it('CA-4: bloqueado, ni el código correcto sirve; pasados los 15 minutos, sí', async () => {
    const o = crear();
    o.tx.codigoOtp.findFirst.mockResolvedValue(
      fila({ bloqueadoHasta: en(15 * MIN) }),
    );
    await expect(verificar(o)).rejects.toMatchObject({
      codigo: 'OTP_BLOQUEADO',
    });
    expect(o.prisma.codigoOtp.update).not.toHaveBeenCalled();
    vi.setSystemTime(en(15 * MIN + 1));
    o.tx.codigoOtp.findFirst.mockResolvedValue(
      fila({ bloqueadoHasta: en(15 * MIN), venceEn: en(30 * MIN) }),
    );
    await expect(verificar(o)).resolves.toBeTruthy();
  });

  it('CA-5: a los 10 minutos el código vence → OTP_VENCIDO (410), aunque sea correcto', async () => {
    const o = crear();
    o.tx.codigoOtp.findFirst.mockResolvedValue(fila());
    vi.setSystemTime(en(10 * MIN - 1));
    await expect(verificar(o)).resolves.toBeTruthy();
    vi.setSystemTime(en(10 * MIN));
    const error = await verificar(o).catch((e) => e);
    expect(respuestaDe(error)).toMatchObject({
      estado: 410,
      codigo: 'OTP_VENCIDO',
    });
  });

  it('sin código, o ya usado → OTP_INVALIDO', async () => {
    const o = crear();
    await expect(verificar(o)).rejects.toMatchObject({
      codigo: 'OTP_INVALIDO',
    });
    o.tx.codigoOtp.findFirst.mockResolvedValue(fila({ usadoEn: hace(MIN) }));
    await expect(verificar(o)).rejects.toMatchObject({
      codigo: 'OTP_INVALIDO',
    });
    expect(o.prisma.codigoOtp.update).not.toHaveBeenCalled();
  });

  it('CA-7: una fila de aviso nunca se confirma, ni con el código correcto', async () => {
    const o = crear();
    o.tx.codigoOtp.findFirst.mockResolvedValue(
      fila({ datos: { aviso: 'ya_tienes_cuenta' } }),
    );
    await expect(verificar(o)).rejects.toMatchObject({
      codigo: 'OTP_INVALIDO',
    });
    expect(o.prisma.codigoOtp.update).toHaveBeenCalled();
    expect(o.tx.codigoOtp.updateMany).not.toHaveBeenCalled();
  });

  it('el HMAC depende del correo: el código de otro correo no sirve', async () => {
    const o = crear();
    const deOtro = createHmac('sha256', 'secreto-unitario')
      .update('registro:otra@uagrm.edu.bo:123456')
      .digest('hex');
    o.tx.codigoOtp.findFirst.mockResolvedValue(fila({ hashCodigo: deOtro }));
    await expect(verificar(o)).rejects.toMatchObject({
      codigo: 'OTP_INVALIDO',
    });
  });
});

describe('OtpService · propósito recuperacion (HU-34)', () => {
  const filaRecuperacion = (extra: object = {}) =>
    fila({
      hashCodigo: hmac('123456', 'recuperacion'),
      datos: { usuarioId: 'u-1' },
      ...extra,
    });

  it('CA-1: el código va por la cola, en la misma transacción, no en el momento', async () => {
    const o = crear();
    const r = await o.servicio.generar(CORREO, 'recuperacion', {
      usuarioId: 'u-1',
    });
    expect(r).toEqual({ reenviarEn: en(MIN) });
    expect(o.correos.enviarAhora).not.toHaveBeenCalled();
    const [tx, correo] = o.correos.encolar.mock.calls[0] as [
      unknown,
      { destinatario: string; plantilla: string; datos: { codigo: string } },
    ];
    expect(tx).toBe(o.tx);
    expect(correo).toMatchObject({
      destinatario: CORREO,
      plantilla: 'otp_recuperacion',
      datos: { minutos: 10 },
    });
    expect(correo.datos.codigo).toMatch(/^\d{6}$/);
    expect(o.tx.codigoOtp.create.mock.calls[0][0].data.hashCodigo).toBe(
      hmac(correo.datos.codigo, 'recuperacion'),
    );
  });

  it('CA-2: la fila señuelo se guarda igual que una real pero no envía nada', async () => {
    const o = crear();
    const r = await o.servicio.generar(CORREO, 'recuperacion', {
      senuelo: true,
    });
    expect(r).toEqual({ reenviarEn: en(MIN) });
    expect(o.tx.codigoOtp.create.mock.calls[0][0].data).toMatchObject({
      proposito: 'recuperacion',
      datos: { senuelo: true },
      venceEn: en(10 * MIN),
    });
    expect(o.correos.encolar).not.toHaveBeenCalled();
    expect(o.correos.enviarAhora).not.toHaveBeenCalled();
  });

  it('CA-2: los límites de la fila señuelo son los de una real', async () => {
    const o = crear();
    o.tx.codigoOtp.findMany.mockResolvedValue([{ creadoEn: hace(20_000) }]);
    await expect(
      o.servicio.generar(CORREO, 'recuperacion', { senuelo: true }),
    ).rejects.toMatchObject({ codigo: 'OTP_LIMITE_REENVIO' });
    expect(o.tx.codigoOtp.create).not.toHaveBeenCalled();
  });

  it('CA-2: la fila señuelo nunca valida, ni con el código correcto, y cuenta el error', async () => {
    const o = crear();
    o.tx.codigoOtp.findFirst.mockResolvedValue(
      filaRecuperacion({ datos: { senuelo: true } }),
    );
    await expect(verificar(o, '123456', 'recuperacion')).rejects.toMatchObject({
      codigo: 'OTP_INVALIDO',
    });
    expect(o.prisma.codigoOtp.update).toHaveBeenCalledWith({
      where: { id: 'otp-1' },
      data: { intentos: { increment: 1 } },
    });
    expect(o.tx.codigoOtp.updateMany).not.toHaveBeenCalled();
  });

  it('CA-4: el quinto error seguido bloquea 15 minutos, con cuenta o señuelo', async () => {
    for (const datos of [{ usuarioId: 'u-1' }, { senuelo: true }]) {
      const o = crear();
      o.tx.codigoOtp.findFirst.mockResolvedValue(
        filaRecuperacion({ intentos: 4, datos }),
      );
      o.prisma.codigoOtp.update.mockResolvedValueOnce({ intentos: 5 });
      const error = await verificar(o, '654321', 'recuperacion').catch(
        (e) => e,
      );
      expect(respuestaDe(error)).toMatchObject({
        estado: 429,
        codigo: 'OTP_BLOQUEADO',
        reintentarEn: en(15 * MIN).toISOString(),
      });
    }
  });

  it('CA-5: vencido → OTP_VENCIDO (410); ya usado → OTP_INVALIDO', async () => {
    const o = crear();
    o.tx.codigoOtp.findFirst.mockResolvedValue(
      filaRecuperacion({ venceEn: hace(1) }),
    );
    expect(
      respuestaDe(await verificar(o, '123456', 'recuperacion').catch((e) => e)),
    ).toMatchObject({ estado: 410, codigo: 'OTP_VENCIDO' });
    o.tx.codigoOtp.findFirst.mockResolvedValue(
      filaRecuperacion({ usadoEn: hace(MIN) }),
    );
    expect(
      respuestaDe(await verificar(o, '123456', 'recuperacion').catch((e) => e)),
    ).toMatchObject({ estado: 400, codigo: 'OTP_INVALIDO' });
  });

  it('CA-3: código correcto → devuelve el usuario y lo consume', async () => {
    const o = crear();
    o.tx.codigoOtp.findFirst.mockResolvedValue(filaRecuperacion());
    await expect(verificar(o, '123456', 'recuperacion')).resolves.toEqual({
      usuarioId: 'u-1',
    });
    // El código de registro no sirve para recuperar: el HMAC incluye el propósito.
    o.tx.codigoOtp.findFirst.mockResolvedValue(fila());
    await expect(verificar(o, '123456', 'recuperacion')).rejects.toMatchObject({
      codigo: 'OTP_INVALIDO',
    });
  });
});

describe('OtpService.reenviar', () => {
  it('CA-6: con un código pendiente genera otro con los mismos datos', async () => {
    const o = crear();
    o.prisma.codigoOtp.findFirst.mockResolvedValue(fila());
    const generar = vi.spyOn(o.servicio, 'generar');
    await o.servicio.reenviar(CORREO, 'registro');
    expect(generar).toHaveBeenCalledWith(CORREO, 'registro', {
      organizacionId: 'org-a',
    });
  });

  it('sin registro pendiente (nunca hubo o ya se usó): misma respuesta y no envía nada', async () => {
    const o = crear();
    await expect(o.servicio.reenviar(CORREO, 'registro')).resolves.toEqual({
      reenviarEn: en(MIN),
    });
    o.prisma.codigoOtp.findFirst.mockResolvedValue(
      fila({ usadoEn: hace(MIN) }),
    );
    await o.servicio.reenviar(CORREO, 'registro');
    expect(o.prisma.$transaction).not.toHaveBeenCalled();
    expect(o.correos.enviarAhora).not.toHaveBeenCalled();
  });
});
