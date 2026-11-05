import { ExecutionContext } from '@nestjs/common';
import { IdentidadVerificadaGuard } from './identidad.guard.js';
import { PrismaService } from './prisma.service.js';

const contextoDe = (peticion: object) =>
  ({
    switchToHttp: () => ({ getRequest: () => peticion }),
  }) as unknown as ExecutionContext;

function crear(fila: { estado: string } | null) {
  const findUnique = vi.fn().mockResolvedValue(fila);
  const guard = new IdentidadVerificadaGuard({
    identidad: { findUnique },
  } as unknown as PrismaService);
  return { guard, findUnique };
}

describe('IdentidadVerificadaGuard (CA-6, RN-7)', () => {
  it('deja pasar a una identidad verificada, buscándola por el usuario del token', async () => {
    const { guard, findUnique } = crear({ estado: 'verificada' });
    await expect(
      guard.canActivate(contextoDe({ usuario: { id: 'u1' } })),
    ).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { usuarioId: 'u1' },
      select: { estado: true },
    });
  });

  it.each([
    ['sin fila (no verificada)', null],
    ['no_verificada', { estado: 'no_verificada' }],
    ['en_revision (pendiente)', { estado: 'en_revision' }],
    ['rechazada', { estado: 'rechazada' }],
    ['bloqueada_temporal', { estado: 'bloqueada_temporal' }],
  ])('403 IDENTIDAD_NO_VERIFICADA con %s', async (_, fila) => {
    const { guard } = crear(fila);
    const error = await guard
      .canActivate(contextoDe({ usuario: { id: 'u1' } }))
      .catch((e) => e);
    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toMatchObject({
      codigo: 'IDENTIDAD_NO_VERIFICADA',
      mensaje: 'Debes verificar tu identidad para realizar esta acción.',
    });
  });

  it('sin usuario en la petición (sin JwtGuard antes) responde 401 y no consulta la BD', async () => {
    const { guard, findUnique } = crear({ estado: 'verificada' });
    await expect(guard.canActivate(contextoDe({}))).rejects.toMatchObject({
      codigo: 'NO_AUTENTICADO',
    });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
