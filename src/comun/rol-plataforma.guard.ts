import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorNegocio } from './error-negocio.js';
import { PrismaService } from './prisma.service.js';
import type { UsuarioToken } from './decoradores.js';

const ROL = 'rolPlataforma';
/** Exige ese rol de plataforma; se usa junto con `@UseGuards(RolPlataformaGuard)`. */
export const RolPlataforma = (rol: 'super_admin') => SetMetadata(ROL, rol);

/** El rol se lee de la BD, no del token: revocarlo surte efecto de inmediato. */
@Injectable()
export class RolPlataformaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const rol = this.reflector.getAllAndOverride<string>(ROL, [
      contexto.getHandler(),
      contexto.getClass(),
    ]);
    const actual: UsuarioToken | undefined = contexto
      .switchToHttp()
      .getRequest().usuario;
    const usuario = actual
      ? await this.prisma.usuario.findUnique({ where: { id: actual.id } })
      : null;
    if (!rol || usuario?.rolPlataforma !== rol)
      throw new ErrorNegocio(
        403,
        'NO_AUTORIZADO',
        'comun.errores.no_autorizado',
      );
    return true;
  }
}
