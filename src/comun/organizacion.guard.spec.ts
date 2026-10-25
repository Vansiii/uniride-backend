import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  OrganizacionGuard,
  RolOrganizacionGuard,
} from './organizacion.guard.js';
import { PrismaService } from './prisma.service.js';

const ORG = '11111111-1111-4111-8111-111111111111';

const contextoDe = (peticion: object) =>
  ({
    switchToHttp: () => ({ getRequest: () => peticion }),
    getHandler: () => undefined,
    getClass: () => undefined,
  }) as unknown as ExecutionContext;

function guardOrganizacion(membresia: object | null) {
  const tx = {
    membresia: { findUnique: vi.fn().mockResolvedValue(membresia) },
  };
  const prisma = {
    enOrganizacion: vi.fn((_: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return {
    guard: new OrganizacionGuard(prisma as unknown as PrismaService),
    prisma,
    tx,
  };
}

describe('OrganizacionGuard', () => {
  it('con membresía aprobada deja la organización y el rol en la petición', async () => {
    const { guard, prisma, tx } = guardOrganizacion({
      organizacionId: ORG,
      estado: 'aprobada',
      rol: 'admin_organizacion',
    });
    const peticion: Record<string, unknown> = {
      usuario: { id: 'u1', org: ORG, cli: 'web' },
    };
    await expect(guard.canActivate(contextoDe(peticion))).resolves.toBe(true);
    expect(peticion.organizacionId).toBe(ORG);
    expect(peticion.rolOrganizacion).toBe('admin_organizacion');
    // La membresía se busca dentro del contexto RLS de la organización del token.
    expect(prisma.enOrganizacion).toHaveBeenCalledWith(
      ORG,
      expect.any(Function),
    );
    expect(tx.membresia.findUnique).toHaveBeenCalledWith({
      where: {
        organizacionId_usuarioId: { organizacionId: ORG, usuarioId: 'u1' },
      },
    });
  });

  it.each([
    ['sin organización en el token', { id: 'u1', org: null }, null],
    ['sin membresía', { id: 'u1', org: ORG }, null],
    [
      'con membresía pendiente',
      { id: 'u1', org: ORG },
      { organizacionId: ORG, estado: 'pendiente', rol: 'miembro' },
    ],
    [
      'con membresía rechazada',
      { id: 'u1', org: ORG },
      { organizacionId: ORG, estado: 'rechazada', rol: 'miembro' },
    ],
  ])('403 %s', async (_, usuario, membresia) => {
    const { guard } = guardOrganizacion(membresia);
    await expect(
      guard.canActivate(contextoDe({ usuario })),
    ).rejects.toMatchObject({ codigo: 'NO_AUTORIZADO' });
  });
});

describe('RolOrganizacionGuard', () => {
  const guardCon = (rol: string | undefined) =>
    new RolOrganizacionGuard({
      getAllAndOverride: () => rol,
    } as unknown as Reflector);

  it('deja pasar con el rol exigido', () => {
    expect(
      guardCon('admin_organizacion').canActivate(
        contextoDe({ rolOrganizacion: 'admin_organizacion' }),
      ),
    ).toBe(true);
  });

  it.each([
    ['un miembro', 'admin_organizacion', 'miembro'],
    ['sin OrganizacionGuard antes', 'admin_organizacion', undefined],
    ['sin rol declarado', undefined, 'admin_organizacion'],
  ])('403 para %s', (_, rol, rolOrganizacion) => {
    expect(() =>
      guardCon(rol).canActivate(contextoDe({ rolOrganizacion })),
    ).toThrow(expect.objectContaining({ codigo: 'NO_AUTORIZADO' }));
  });
});
