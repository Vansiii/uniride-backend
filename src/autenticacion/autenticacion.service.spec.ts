import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { PrismaService } from '../comun/prisma.service.js';
import { AutenticacionService } from './autenticacion.service.js';

const ahora = new Date('2026-10-21T12:00:00Z');
const DIA = 24 * 60 * 60 * 1000;

function crear() {
  const prisma = {
    usuario: {
      findFirst: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    tokenRefresco: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn().mockResolvedValue({}),
    },
  };
  const auditoria = { registrar: vi.fn().mockResolvedValue(undefined) };
  const jwt = { signAsync: vi.fn().mockResolvedValue('acceso') };
  const servicio = new AutenticacionService(
    prisma as unknown as PrismaService,
    jwt as unknown as JwtService,
    auditoria as unknown as AuditoriaService,
  );
  return { servicio, prisma, auditoria };
}

describe('AutenticacionService', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ahora);
  });
  afterEach(() => vi.useRealTimers());

  it('CA-10: la sesión móvil dura 30 días y la web 7', async () => {
    const hash = await bcrypt.hash('Clave1234', 4);
    const { servicio, prisma } = crear();
    prisma.usuario.findFirst.mockResolvedValue({
      id: 'u1',
      hashContrasena: hash,
      bloqueadoHasta: null,
      ultimaOrganizacionId: null,
    });
    await servicio.iniciarSesion('a@b.co', 'Clave1234', 'movil');
    await servicio.iniciarSesion('a@b.co', 'Clave1234', 'web');
    const [movil, web] = prisma.tokenRefresco.create.mock.calls.map(
      ([c]) => c.data.sesionVenceEn as Date,
    );
    expect(movil.getTime() - ahora.getTime()).toBe(30 * DIA);
    expect(web.getTime() - ahora.getTime()).toBe(7 * DIA);
  });

  it('CA-6: el quinto fallo bloquea la cuenta 15 minutos', async () => {
    const { servicio, prisma } = crear();
    prisma.usuario.findFirst.mockResolvedValue({
      id: 'u1',
      hashContrasena: await bcrypt.hash('otra', 4),
      bloqueadoHasta: null,
    });
    prisma.usuario.update.mockResolvedValueOnce({ intentosFallidos: 5 });
    await expect(
      servicio.iniciarSesion('a@b.co', 'mala', 'movil'),
    ).rejects.toMatchObject({
      codigo: 'CREDENCIALES_INVALIDAS',
    });
    expect(prisma.usuario.update).toHaveBeenLastCalledWith({
      where: { id: 'u1' },
      data: {
        intentosFallidos: 0,
        bloqueadoHasta: new Date(ahora.getTime() + 15 * 60 * 1000),
      },
    });
  });

  it('CA-2: un correo inexistente responde igual que una contraseña mala', async () => {
    const { servicio, prisma } = crear();
    prisma.usuario.findFirst.mockResolvedValue(null);
    await expect(
      servicio.iniciarSesion('x@y.co', 'mala', 'web'),
    ).rejects.toMatchObject({
      codigo: 'CREDENCIALES_INVALIDAS',
    });
  });

  it('CA-5: reusar un refresco ya revocado revoca todas las sesiones', async () => {
    const { servicio, prisma, auditoria } = crear();
    prisma.tokenRefresco.findUnique.mockResolvedValue({
      id: 't1',
      usuarioId: 'u1',
      tipoCliente: 'movil',
      sesionVenceEn: new Date(ahora.getTime() + DIA),
    });
    prisma.tokenRefresco.updateMany.mockResolvedValue({ count: 0 });
    await expect(servicio.refrescar('viejo')).rejects.toMatchObject({
      codigo: 'SESION_EXPIRADA',
    });
    expect(prisma.tokenRefresco.updateMany).toHaveBeenLastCalledWith({
      where: { usuarioId: 'u1', revocadoEn: null },
      data: { revocadoEn: ahora },
    });
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'sesion.reuso_refresco' }),
    );
  });

  it('CA-10: una sesión pasada de su límite absoluto no se renueva', async () => {
    const { servicio, prisma } = crear();
    prisma.tokenRefresco.findUnique.mockResolvedValue({
      id: 't1',
      usuarioId: 'u1',
      tipoCliente: 'web',
      sesionVenceEn: new Date(ahora.getTime() - 1000),
    });
    prisma.tokenRefresco.updateMany.mockResolvedValue({ count: 1 });
    await expect(servicio.refrescar('token')).rejects.toMatchObject({
      codigo: 'SESION_EXPIRADA',
    });
    expect(prisma.tokenRefresco.create).not.toHaveBeenCalled();
  });
});
