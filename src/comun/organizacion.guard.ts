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

const noAutorizado = () =>
  new ErrorNegocio(403, 'NO_AUTORIZADO', 'comun.errores.no_autorizado');

/**
 * Exige una membresía `aprobada` en la organización activa del token (A-13).
 * La membresía se lee de la BD en cada petición: revocarla surte efecto de inmediato.
 * Deja `organizacionId` y `rolOrganizacion` en la petición; el servicio opera dentro de `enOrganizacion`.
 */
@Injectable()
export class OrganizacionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const peticion = contexto.switchToHttp().getRequest();
    const usuario: UsuarioToken | undefined = peticion.usuario;
    if (!usuario?.org) throw noAutorizado();
    const membresia = await this.prisma.enOrganizacion(usuario.org, (tx) =>
      tx.membresia.findUnique({
        where: {
          organizacionId_usuarioId: {
            organizacionId: usuario.org as string,
            usuarioId: usuario.id,
          },
        },
      }),
    );
    if (membresia?.estado !== 'aprobada') throw noAutorizado();
    peticion.organizacionId = membresia.organizacionId;
    peticion.rolOrganizacion = membresia.rol;
    return true;
  }
}

const ROL = 'rolOrganizacion';
/** Exige ese rol en la organización activa; va después de `OrganizacionGuard` en `@UseGuards`. */
export const RolOrganizacion = (rol: 'admin_organizacion') =>
  SetMetadata(ROL, rol);

@Injectable()
export class RolOrganizacionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(contexto: ExecutionContext): boolean {
    const rol = this.reflector.getAllAndOverride<string>(ROL, [
      contexto.getHandler(),
      contexto.getClass(),
    ]);
    const { rolOrganizacion } = contexto.switchToHttp().getRequest();
    if (!rol || rolOrganizacion !== rol) throw noAutorizado();
    return true;
  }
}
