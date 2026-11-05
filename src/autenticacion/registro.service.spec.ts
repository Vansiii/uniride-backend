import bcrypt from 'bcryptjs';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { PrismaService } from '../comun/prisma.service.js';
import { AutenticacionService } from './autenticacion.service.js';
import type { RegistroDto } from './dto/registro.dto.js';
import { OtpService } from './otp.service.js';
import { RegistroService } from './registro.service.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function crear() {
  const tx = {
    organizacion: {
      findUnique: vi.fn().mockResolvedValue({
        id: ORG_A,
        estado: 'activa',
        modoAprobacion: 'automatica',
      }),
    },
    usuario: { create: vi.fn().mockResolvedValue({ id: 'u-1' }) },
    membresia: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: ORG_A }]),
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    fijarOrganizacion: vi.fn().mockResolvedValue(undefined),
    usuario: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  const otp = {
    generar: vi.fn().mockResolvedValue({ reenviarEn: new Date() }),
    reenviar: vi.fn().mockResolvedValue({ reenviarEn: new Date() }),
    verificar: vi.fn().mockResolvedValue({
      nombreCompleto: 'Ana Pérez',
      hashContrasena: '$2b$12$hash',
      organizacionId: ORG_A,
      consentimientoEn: '2026-10-24T12:00:00.000Z',
    }),
  };
  const autenticacion = {
    abrirSesion: vi
      .fn()
      .mockResolvedValue({ tokenAcceso: 'a', tokenRefresco: 'r' }),
  };
  const auditoria = { registrar: vi.fn().mockResolvedValue(undefined) };
  const servicio = new RegistroService(
    prisma as unknown as PrismaService,
    otp as unknown as OtpService,
    autenticacion as unknown as AutenticacionService,
    auditoria as unknown as AuditoriaService,
  );
  return { servicio, prisma, tx, otp, autenticacion, auditoria };
}

const dto = (extra: Partial<RegistroDto> = {}): RegistroDto => ({
  nombreCompleto: 'Ana Pérez',
  correo: 'Ana@UAGRM.edu.bo',
  contrasena: 'Clave1234',
  aceptaTratamientoDatos: true,
  ...extra,
});

describe('RegistroService.registrar', () => {
  it('CA-9: sin consentimiento → CONSENTIMIENTO_REQUERIDO, sin buscar la organización', async () => {
    const o = crear();
    await expect(
      o.servicio.registrar(dto({ aceptaTratamientoDatos: false })),
    ).rejects.toMatchObject({ codigo: 'CONSENTIMIENTO_REQUERIDO' });
    expect(o.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('RN-5: contraseña débil → CONTRASENA_DEBIL', async () => {
    const o = crear();
    for (const contrasena of ['Clave12', 'SoloLetras', '123456789'])
      await expect(
        o.servicio.registrar(dto({ contrasena })),
      ).rejects.toMatchObject({ codigo: 'CONTRASENA_DEBIL' });
    expect(o.otp.generar).not.toHaveBeenCalled();
  });

  it('CA-3: dominio sin organización → ORGANIZACION_NO_AFILIADA (422) y no se genera código', async () => {
    const o = crear();
    o.prisma.$queryRaw.mockResolvedValue([{ id: null }]);
    await expect(o.servicio.registrar(dto())).rejects.toMatchObject({
      codigo: 'ORGANIZACION_NO_AFILIADA',
      status: 422,
    });
    expect(o.otp.generar).not.toHaveBeenCalled();
  });

  it('CA-1 y CA-8: la organización sale del dominio, nunca del `organizacionId` enviado', async () => {
    const o = crear();
    await o.servicio.registrar(dto({ organizacionId: ORG_B }));
    // Se consulta el dominio del correo, en minúsculas.
    expect(o.prisma.$queryRaw.mock.calls[0].slice(1)).toEqual(['uagrm.edu.bo']);
    const [correo, proposito, datos] = o.otp.generar.mock.calls[0];
    expect(correo).toBe('ana@uagrm.edu.bo');
    expect(proposito).toBe('registro');
    expect(datos).toMatchObject({
      nombreCompleto: 'Ana Pérez',
      organizacionId: ORG_A,
      consentimientoEn: expect.any(String),
    });
    // RN-6: solo el hash.
    expect(JSON.stringify(datos)).not.toContain('Clave1234');
    expect(await bcrypt.compare('Clave1234', datos.hashContrasena)).toBe(true);
  });

  it('CA-7: si el correo ya tiene cuenta, genera un aviso y no guarda datos de registro', async () => {
    const o = crear();
    o.prisma.usuario.findFirst.mockResolvedValue({ id: 'existente' });
    await o.servicio.registrar(dto());
    expect(o.otp.generar).toHaveBeenCalledWith('ana@uagrm.edu.bo', 'registro', {
      aviso: 'ya_tienes_cuenta',
    });
  });

  it('reenviar normaliza el correo', async () => {
    const o = crear();
    await o.servicio.reenviar(' Ana@UAGRM.edu.bo ');
    expect(o.otp.reenviar).toHaveBeenCalledWith('ana@uagrm.edu.bo', 'registro');
  });

  it('reenviar también sirve al código de agregar organización (HU-07)', async () => {
    const o = crear();
    await o.servicio.reenviar('ana@uagrm.edu.bo', 'agregar_organizacion');
    expect(o.otp.reenviar).toHaveBeenCalledWith(
      'ana@uagrm.edu.bo',
      'agregar_organizacion',
    );
  });
});

describe('RegistroService.verificar', () => {
  it('CA-2: organización automática → cuenta, membresía aprobada, auditoría y sesión con organización activa', async () => {
    const o = crear();
    const r = await o.servicio.verificar('Ana@UAGRM.edu.bo', '123456');
    expect(r).toEqual({
      tokenAcceso: 'a',
      tokenRefresco: 'r',
      estadoMembresia: 'aprobada',
    });
    expect(o.otp.verificar).toHaveBeenCalledWith(
      o.tx,
      'ana@uagrm.edu.bo',
      'registro',
      '123456',
    );
    // RLS: la membresía se crea con la organización de los datos del código.
    expect(o.prisma.fijarOrganizacion).toHaveBeenCalledWith(o.tx, ORG_A);
    expect(o.tx.usuario.create).toHaveBeenCalledWith({
      data: {
        correo: 'ana@uagrm.edu.bo',
        hashContrasena: '$2b$12$hash',
        nombreCompleto: 'Ana Pérez',
        consentimientoDatosEn: new Date('2026-10-24T12:00:00.000Z'),
        ultimaOrganizacionId: ORG_A,
      },
    });
    expect(o.tx.membresia.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizacionId: ORG_A,
        usuarioId: 'u-1',
        rol: 'miembro',
        estado: 'aprobada',
        correoInstitucional: 'ana@uagrm.edu.bo',
      }),
    });
    expect(o.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'registro.alta',
        actorId: 'u-1',
        organizacionId: ORG_A,
      }),
      o.tx,
    );
    expect(o.autenticacion.abrirSesion).toHaveBeenCalledWith(
      'u-1',
      ORG_A,
      'movil',
    );
  });

  it('CA-2: organización manual → pendiente y sesión sin organización activa', async () => {
    const o = crear();
    o.tx.organizacion.findUnique.mockResolvedValue({
      id: ORG_A,
      estado: 'activa',
      modoAprobacion: 'manual',
    });
    const r = await o.servicio.verificar('ana@uagrm.edu.bo', '123456');
    expect(r.estadoMembresia).toBe('pendiente');
    expect(o.tx.usuario.create.mock.calls[0][0].data.ultimaOrganizacionId).toBe(
      null,
    );
    expect(o.tx.membresia.create.mock.calls[0][0].data).toMatchObject({
      estado: 'pendiente',
      decididoEn: null,
    });
    expect(o.autenticacion.abrirSesion).toHaveBeenCalledWith(
      'u-1',
      null,
      'movil',
    );
  });

  it('organización suspendida antes de confirmar → ORGANIZACION_NO_AFILIADA, sin cuenta ni sesión', async () => {
    const o = crear();
    o.tx.organizacion.findUnique.mockResolvedValue({
      id: ORG_A,
      estado: 'suspendida',
      modoAprobacion: 'automatica',
    });
    await expect(
      o.servicio.verificar('ana@uagrm.edu.bo', '123456'),
    ).rejects.toMatchObject({ codigo: 'ORGANIZACION_NO_AFILIADA' });
    expect(o.tx.usuario.create).not.toHaveBeenCalled();
    expect(o.autenticacion.abrirSesion).not.toHaveBeenCalled();
  });

  it('un código rechazado no crea nada', async () => {
    const o = crear();
    o.otp.verificar.mockRejectedValue(new Error('OTP_INVALIDO'));
    await expect(
      o.servicio.verificar('ana@uagrm.edu.bo', '000000'),
    ).rejects.toThrow('OTP_INVALIDO');
    expect(o.tx.usuario.create).not.toHaveBeenCalled();
    expect(o.autenticacion.abrirSesion).not.toHaveBeenCalled();
  });
});
