import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService } from '../comun/prisma.service.js';
import type { UsuarioToken } from '../comun/decoradores.js';

const noAutorizado = () =>
  new ErrorNegocio(403, 'NO_AUTORIZADO', 'comun.errores.no_autorizado');

/**
 * AsistenteGuard:
 * Permite la consulta al asistente a cualquier usuario autenticado con sesión válida.
 * - Si es super_admin (leído de la BD): habilita la consulta con rol 'super_admin' sin exigir organización fija.
 * - Si tiene organización: verifica que la membresía esté 'aprobada' (A-13) y fija rolOrganizacion.
 * - Si no es super_admin y no tiene organización o membresía aprobada: rechaza con 403.
 */
@Injectable()
export class AsistenteGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const peticion = contexto.switchToHttp().getRequest();
    const usuarioToken: UsuarioToken | undefined = peticion.usuario;
    if (!usuarioToken) throw noAutorizado();

    if (this.prisma.usuario?.findUnique) {
      const usuario = await this.prisma.usuario.findUnique({
        where: { id: usuarioToken.id },
        select: { rolPlataforma: true },
      });

      if (usuario?.rolPlataforma === 'super_admin') {
        peticion.rolOrganizacion = 'super_admin';
        return true;
      }
    }

    if (!usuarioToken.org) throw noAutorizado();

    const membresia = await this.prisma.enOrganizacion(usuarioToken.org, (tx) =>
      tx.membresia.findUnique({
        where: {
          organizacionId_usuarioId: {
            organizacionId: usuarioToken.org as string,
            usuarioId: usuarioToken.id,
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
