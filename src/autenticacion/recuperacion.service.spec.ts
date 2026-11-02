import bcrypt from 'bcryptjs';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService } from '../comun/prisma.service.js';
import { CorreosService } from '../notificaciones/correos.service.js';
import { AutenticacionService } from './autenticacion.service.js';
import { OtpService } from './otp.service.js';
import { RecuperacionService } from './recuperacion.service.js';

const REENVIAR_EN = new Date('2026-10-26T12:01:00.000Z');

function crear() {
  const tx = { usuario: { update: vi.fn().mockResolvedValue({}) } };
  const prisma = {
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    usuario: { findFirst: vi.fn().mockResolvedValue({ id: 'u-1' }) },
  };
  const otp = {
    generar: vi.fn().mockResolvedValue({ reenviarEn: REENVIAR_EN }),
    verificar: vi.fn().mockResolvedValue({ usuarioId: 'u-1' }),
  };
  const autenticacion = {
    revocarTodas: vi.fn().mockResolvedValue({ count: 2 }),
  };
  const correos = { encolar: vi.fn().mockResolvedValue(undefined) };
  const auditoria = { registrar: vi.fn().mockResolvedValue(undefined) };
  const servicio = new RecuperacionService(
    prisma as unknown as PrismaService,
    otp as unknown as OtpService,
    autenticacion as unknown as AutenticacionService,
    correos as unknown as CorreosService,
    auditoria as unknown as AuditoriaService,
  );
  return { servicio, prisma, tx, otp, autenticacion, correos, auditoria };
}

describe('RecuperacionService.solicitar', () => {
  it('CA-1: con cuenta genera el código de recuperación con el usuario y lo audita', async () => {
    const o = crear();
    await expect(o.servicio.solicitar(' Ana@UAGRM.edu.bo ')).resolves.toEqual({
      reenviarEn: REENVIAR_EN,
    });
    expect(o.prisma.usuario.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { correo: { equals: 'ana@uagrm.edu.bo', mode: 'insensitive' } },
      }),
    );
    expect(o.otp.generar).toHaveBeenCalledWith(
      'ana@uagrm.edu.bo',
      'recuperacion',
      { usuarioId: 'u-1' },
    );
    expect(o.auditoria.registrar).toHaveBeenCalledWith({
      accion: 'recuperacion.solicitud',
      entidad: 'usuario',
      entidadId: 'u-1',
      actorId: 'u-1',
      resultado: 'ok',
      detalle: { dominio: 'uagrm.edu.bo', conCuenta: true },
    });
  });

  it('CA-2: sin cuenta, fila señuelo y la misma respuesta; la auditoría no guarda el correo', async () => {
    const o = crear();
    o.prisma.usuario.findFirst.mockResolvedValue(null);
    await expect(o.servicio.solicitar('nadie@gmail.com')).resolves.toEqual({
      reenviarEn: REENVIAR_EN,
    });
    expect(o.otp.generar).toHaveBeenCalledWith(
      'nadie@gmail.com',
      'recuperacion',
      { senuelo: true },
    );
    const evento = o.auditoria.registrar.mock.calls[0][0];
    expect(evento).toMatchObject({
      resultado: 'ok',
      detalle: { dominio: 'gmail.com', conCuenta: false },
    });
    expect(evento.actorId).toBeUndefined();
    expect(JSON.stringify(evento)).not.toContain('nadie');
  });

  it('RN-6: un límite o bloqueo se audita como fallo con su motivo y se propaga', async () => {
    const o = crear();
    const limite = new ErrorNegocio(
      429,
      'OTP_LIMITE_REENVIO',
      'autenticacion.otp.limite_reenvio',
    );
    o.otp.generar.mockRejectedValue(limite);
    await expect(o.servicio.solicitar('ana@uagrm.edu.bo')).rejects.toBe(limite);
    expect(o.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'recuperacion.solicitud',
        resultado: 'fallo',
        detalle: {
          dominio: 'uagrm.edu.bo',
          conCuenta: true,
          motivo: 'OTP_LIMITE_REENVIO',
        },
      }),
    );
  });

  it('un error inesperado no se audita como intento y se propaga', async () => {
    const o = crear();
    o.otp.generar.mockRejectedValue(new Error('BD caída'));
    await expect(o.servicio.solicitar('ana@uagrm.edu.bo')).rejects.toThrow(
      'BD caída',
    );
    expect(o.auditoria.registrar).not.toHaveBeenCalled();
  });
});

describe('RecuperacionService.restablecer', () => {
  it('CA-3: en una transacción cambia el hash, levanta el bloqueo, cierra todas las sesiones, audita y encola el aviso', async () => {
    const o = crear();
    await o.servicio.restablecer('Ana@UAGRM.edu.bo', '123456', 'Nueva1234');
    expect(o.otp.verificar).toHaveBeenCalledWith(
      o.tx,
      'ana@uagrm.edu.bo',
      'recuperacion',
      '123456',
    );
    const { where, data } = o.tx.usuario.update.mock.calls[0][0];
    expect(where).toEqual({ id: 'u-1' });
    expect(data).toMatchObject({ intentosFallidos: 0, bloqueadoHasta: null });
    expect(data.hashContrasena).toMatch(/^\$2[aby]\$12\$/);
    expect(data.hashContrasena).not.toContain('Nueva1234');
    expect(await bcrypt.compare('Nueva1234', data.hashContrasena)).toBe(true);
    expect(o.autenticacion.revocarTodas).toHaveBeenCalledWith('u-1', o.tx);
    expect(o.auditoria.registrar).toHaveBeenCalledWith(
      {
        accion: 'recuperacion.cambio',
        entidad: 'usuario',
        entidadId: 'u-1',
        actorId: 'u-1',
        resultado: 'ok',
        detalle: { dominio: 'uagrm.edu.bo' },
      },
      o.tx,
    );
    expect(o.correos.encolar).toHaveBeenCalledWith(o.tx, {
      destinatario: 'ana@uagrm.edu.bo',
      plantilla: 'contrasena_cambiada',
      datos: {},
    });
  });

  it('CA-6: contraseña débil → CONTRASENA_DEBIL sin tocar el código', async () => {
    for (const contrasena of ['corta1', 'soloLetrasAqui', '12345678']) {
      const o = crear();
      const error = await o.servicio
        .restablecer('ana@uagrm.edu.bo', '123456', contrasena)
        .catch((e) => e);
      expect(error).toMatchObject({ codigo: 'CONTRASENA_DEBIL' });
      expect((error as ErrorNegocio).getStatus()).toBe(400);
      expect(o.otp.verificar).not.toHaveBeenCalled();
      expect(o.prisma.$transaction).not.toHaveBeenCalled();
      expect(o.auditoria.registrar).toHaveBeenCalledWith(
        expect.objectContaining({
          resultado: 'fallo',
          detalle: { dominio: 'uagrm.edu.bo', motivo: 'CONTRASENA_DEBIL' },
        }),
      );
    }
  });

  it('código rechazado: no cambia nada, no cierra sesiones y audita el motivo', async () => {
    const o = crear();
    o.otp.verificar.mockRejectedValue(
      new ErrorNegocio(400, 'OTP_INVALIDO', 'autenticacion.otp.invalido'),
    );
    await expect(
      o.servicio.restablecer('ana@uagrm.edu.bo', '000000', 'Nueva1234'),
    ).rejects.toMatchObject({ codigo: 'OTP_INVALIDO' });
    expect(o.tx.usuario.update).not.toHaveBeenCalled();
    expect(o.autenticacion.revocarTodas).not.toHaveBeenCalled();
    expect(o.correos.encolar).not.toHaveBeenCalled();
    expect(o.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'recuperacion.cambio',
        resultado: 'fallo',
        detalle: { dominio: 'uagrm.edu.bo', motivo: 'OTP_INVALIDO' },
      }),
    );
  });
});
