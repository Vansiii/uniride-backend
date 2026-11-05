import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { AutenticacionService } from '../autenticacion/autenticacion.service.js';
import { OtpService } from '../autenticacion/otp.service.js';
import { PrismaService } from '../comun/prisma.service.js';
import { MisMembresiasService } from './mis-membresias.service.js';

const ORG_B = '22222222-2222-4222-8222-222222222222';
const YO = 'u-1';

function crear() {
  const tx = {
    organizacion: {
      findUnique: vi.fn().mockResolvedValue({
        id: ORG_B,
        nombre: 'Empresa B',
        estado: 'activa',
        modoAprobacion: 'automatica',
      }),
    },
    membresia: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'm-1', rol: 'miembro' }),
    },
    usuario: {
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: ORG_B }]),
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    enOrganizacion: vi.fn((_: string, fn: (t: typeof tx) => unknown) => fn(tx)),
    fijarOrganizacion: vi.fn().mockResolvedValue(undefined),
  };
  const otp = {
    generar: vi.fn().mockResolvedValue({ reenviarEn: new Date() }),
    verificar: vi
      .fn()
      .mockResolvedValue({ usuarioId: YO, organizacionId: ORG_B }),
  };
  const autenticacion = {
    emitirAcceso: vi.fn().mockResolvedValue('token-b'),
  };
  const auditoria = { registrar: vi.fn().mockResolvedValue(undefined) };
  const servicio = new MisMembresiasService(
    prisma as unknown as PrismaService,
    otp as unknown as OtpService,
    autenticacion as unknown as AutenticacionService,
    auditoria as unknown as AuditoriaService,
  );
  return { servicio, prisma, tx, otp, autenticacion, auditoria };
}

describe('MisMembresiasService.solicitar', () => {
  it('CA-1: la organización sale del dominio; el código guarda quién lo pidió y para qué organización', async () => {
    const o = crear();
    await o.servicio.solicitar(YO, ' Ana@Empresa.com.bo ');
    expect(o.prisma.$queryRaw.mock.calls[0].slice(1)).toEqual([
      'empresa.com.bo',
    ]);
    expect(o.prisma.enOrganizacion.mock.calls[0][0]).toBe(ORG_B);
    expect(o.otp.generar).toHaveBeenCalledWith(
      'ana@empresa.com.bo',
      'agregar_organizacion',
      { usuarioId: YO, organizacionId: ORG_B },
    );
  });

  it('dominio no afiliado → ORGANIZACION_NO_AFILIADA (422) y no se genera código', async () => {
    const o = crear();
    o.prisma.$queryRaw.mockResolvedValue([{ id: null }]);
    await expect(
      o.servicio.solicitar(YO, 'ana@gmail.com'),
    ).rejects.toMatchObject({
      codigo: 'ORGANIZACION_NO_AFILIADA',
      status: 422,
    });
    expect(o.otp.generar).not.toHaveBeenCalled();
  });

  it.each([
    ['aprobada', 'YA_ES_MIEMBRO'],
    ['pendiente', 'YA_ES_MIEMBRO'],
    ['rechazada', 'MEMBRESIA_RECHAZADA'],
  ])(
    'CA-7: membresía %s en esa organización → %s (409)',
    async (estado, codigo) => {
      const o = crear();
      o.tx.membresia.findUnique.mockResolvedValue({ estado });
      await expect(
        o.servicio.solicitar(YO, 'ana@empresa.com.bo'),
      ).rejects.toMatchObject({ codigo, status: 409 });
      expect(o.tx.membresia.findUnique).toHaveBeenCalledWith({
        where: {
          organizacionId_usuarioId: { organizacionId: ORG_B, usuarioId: YO },
        },
      });
      expect(o.otp.generar).not.toHaveBeenCalled();
    },
  );

  it('CA-7: correo de otra membresía o de otra cuenta → CORREO_EN_USO (409)', async () => {
    for (const ocupado of ['membresia', 'usuario'] as const) {
      const o = crear();
      o.tx[ocupado].findFirst.mockResolvedValue({ id: 'otro' });
      await expect(
        o.servicio.solicitar(YO, 'ana@empresa.com.bo'),
      ).rejects.toMatchObject({ codigo: 'CORREO_EN_USO', status: 409 });
      expect(o.otp.generar).not.toHaveBeenCalled();
    }
    const o = crear();
    await o.servicio.solicitar(YO, 'ana@empresa.com.bo');
    // Su propio correo de inicio de sesión no cuenta como "de otra cuenta".
    expect(o.tx.usuario.findFirst).toHaveBeenCalledWith({
      where: {
        correo: { equals: 'ana@empresa.com.bo', mode: 'insensitive' },
        id: { not: YO },
      },
      select: { id: true },
    });
  });
});

describe('MisMembresiasService.confirmar', () => {
  it('CA-2: automática → membresía aprobada con el correo, auditoría y, sin activa, pasa a serlo', async () => {
    const o = crear();
    const r = await o.servicio.confirmar(YO, 'Ana@Empresa.com.bo', '123456');
    expect(r).toEqual({
      membresia: {
        organizacionId: ORG_B,
        organizacion: 'Empresa B',
        rol: 'miembro',
        estado: 'aprobada',
      },
    });
    expect(o.otp.verificar).toHaveBeenCalledWith(
      o.tx,
      'ana@empresa.com.bo',
      'agregar_organizacion',
      '123456',
    );
    expect(o.prisma.fijarOrganizacion).toHaveBeenCalledWith(o.tx, ORG_B);
    expect(o.tx.membresia.create.mock.calls[0][0].data).toMatchObject({
      organizacionId: ORG_B,
      usuarioId: YO,
      rol: 'miembro',
      estado: 'aprobada',
      correoInstitucional: 'ana@empresa.com.bo',
      decididoEn: expect.any(Date),
    });
    expect(o.tx.usuario.updateMany).toHaveBeenCalledWith({
      where: { id: YO, ultimaOrganizacionId: null },
      data: { ultimaOrganizacionId: ORG_B },
    });
    expect(o.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'membresia.agregar',
        entidadId: 'm-1',
        actorId: YO,
        organizacionId: ORG_B,
        detalle: { estadoMembresia: 'aprobada' },
      }),
      o.tx,
    );
  });

  it('CA-2: manual → pendiente, sin tocar la organización activa', async () => {
    const o = crear();
    o.tx.organizacion.findUnique.mockResolvedValue({
      id: ORG_B,
      nombre: 'Empresa B',
      estado: 'activa',
      modoAprobacion: 'manual',
    });
    const r = await o.servicio.confirmar(YO, 'ana@empresa.com.bo', '123456');
    expect(r.membresia.estado).toBe('pendiente');
    expect(o.tx.membresia.create.mock.calls[0][0].data.decididoEn).toBeNull();
    expect(o.tx.usuario.updateMany).not.toHaveBeenCalled();
  });

  it('un código pedido por otra cuenta → OTP_INVALIDO, sin membresía', async () => {
    const o = crear();
    o.otp.verificar.mockResolvedValue({
      usuarioId: 'otra',
      organizacionId: ORG_B,
    });
    await expect(
      o.servicio.confirmar(YO, 'ana@empresa.com.bo', '123456'),
    ).rejects.toMatchObject({ codigo: 'OTP_INVALIDO', status: 400 });
    expect(o.tx.membresia.create).not.toHaveBeenCalled();
  });

  it('organización suspendida antes de confirmar → ORGANIZACION_NO_AFILIADA', async () => {
    const o = crear();
    o.tx.organizacion.findUnique.mockResolvedValue({
      id: ORG_B,
      estado: 'suspendida',
    });
    await expect(
      o.servicio.confirmar(YO, 'ana@empresa.com.bo', '123456'),
    ).rejects.toMatchObject({ codigo: 'ORGANIZACION_NO_AFILIADA' });
    expect(o.tx.membresia.create).not.toHaveBeenCalled();
  });

  it('se vuelve a validar al confirmar: ya miembro → YA_ES_MIEMBRO', async () => {
    const o = crear();
    o.tx.membresia.findUnique.mockResolvedValue({ estado: 'pendiente' });
    await expect(
      o.servicio.confirmar(YO, 'ana@empresa.com.bo', '123456'),
    ).rejects.toMatchObject({ codigo: 'YA_ES_MIEMBRO' });
    expect(o.tx.membresia.create).not.toHaveBeenCalled();
  });

  it('choque con el UNIQUE del correo institucional → CORREO_EN_USO; otros errores pasan igual', async () => {
    const o = crear();
    o.tx.membresia.create.mockRejectedValue({ code: 'P2002' });
    await expect(
      o.servicio.confirmar(YO, 'ana@empresa.com.bo', '123456'),
    ).rejects.toMatchObject({ codigo: 'CORREO_EN_USO', status: 409 });
    const falla = new Error('BD caída');
    o.tx.membresia.create.mockRejectedValue(falla);
    await expect(
      o.servicio.confirmar(YO, 'ana@empresa.com.bo', '123456'),
    ).rejects.toBe(falla);
  });
});

describe('MisMembresiasService.cambiarActiva', () => {
  it('CA-4: aprobada → la recuerda (RN-6) y emite un token de acceso con esa organización', async () => {
    const o = crear();
    o.tx.membresia.findUnique.mockResolvedValue({ estado: 'aprobada' });
    await expect(o.servicio.cambiarActiva(YO, ORG_B, 'web')).resolves.toEqual({
      tokenAcceso: 'token-b',
    });
    expect(o.prisma.enOrganizacion.mock.calls[0][0]).toBe(ORG_B);
    expect(o.tx.usuario.update).toHaveBeenCalledWith({
      where: { id: YO },
      data: { ultimaOrganizacionId: ORG_B },
    });
    expect(o.autenticacion.emitirAcceso).toHaveBeenCalledWith(YO, ORG_B, 'web');
  });

  it.each([['pendiente'], ['rechazada'], [null]])(
    'CA-5: membresía %s → MEMBRESIA_NO_APROBADA (403), sin token ni cambios',
    async (estado) => {
      const o = crear();
      o.tx.membresia.findUnique.mockResolvedValue(estado && { estado });
      await expect(
        o.servicio.cambiarActiva(YO, ORG_B, 'movil'),
      ).rejects.toMatchObject({ codigo: 'MEMBRESIA_NO_APROBADA', status: 403 });
      expect(o.tx.usuario.update).not.toHaveBeenCalled();
      expect(o.autenticacion.emitirAcceso).not.toHaveBeenCalled();
    },
  );
});
