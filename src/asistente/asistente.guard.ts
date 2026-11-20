import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService } from '../comun/prisma.service.js';
import type { UsuarioToken } from '../comun/decoradores.js';

const noAutorizado = () =>
  new ErrorNegocio(403, 'NO_AUTORIZADO', 'comun.errores.no_autorizado');

/** RN-6: máximo de consultas por usuario en una ventana de un minuto. */
export const LIMITE_CONSULTAS = 15;
const VENTANA_MS = 60_000;

/**
 * AsistenteGuard: cualquier usuario autenticado puede consultar.
 * - super_admin (leído de la BD): rol 'super_admin', sin organización fija.
 * - Con organización: exige membresía 'aprobada' (A-13) y fija rolOrganizacion.
 * - Sin organización activa: rol 'sin_organizacion' (el asistente solo lo guía a afiliarse).
 * Aplica el límite de consultas por minuto (RN-6).
 */
@Injectable()
export class AsistenteGuard implements CanActivate {
  // ponytail: contador en memoria por instancia; pasar a Redis si el backend escala a varias instancias.
  private readonly consultas = new Map<string, number[]>();

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const peticion = contexto.switchToHttp().getRequest();
    const usuarioToken: UsuarioToken | undefined = peticion.usuario;
    if (!usuarioToken) throw noAutorizado();

    const usuario = await this.prisma.usuario.findUnique({
      where: { id: usuarioToken.id },
      select: { rolPlataforma: true },
    });

    if (usuario?.rolPlataforma === 'super_admin') {
      peticion.rolOrganizacion = 'super_admin';
    } else if (!usuarioToken.org) {
      peticion.rolOrganizacion = 'sin_organizacion';
    } else {
      const org = usuarioToken.org;
      const membresia = await this.prisma.enOrganizacion(org, (tx) =>
        tx.membresia.findUnique({
          where: {
            organizacionId_usuarioId: {
              organizacionId: org,
              usuarioId: usuarioToken.id,
            },
          },
        }),
      );
      if (membresia?.estado !== 'aprobada') throw noAutorizado();
      peticion.organizacionId = membresia.organizacionId;
      peticion.rolOrganizacion = membresia.rol;
    }

    this.limitar(usuarioToken.id);
    return true;
  }

  private limitar(usuarioId: string): void {
    const ahora = Date.now();
    const recientes = (this.consultas.get(usuarioId) ?? []).filter(
      (marca) => ahora - marca < VENTANA_MS,
    );
    if (recientes.length >= LIMITE_CONSULTAS) {
      this.consultas.set(usuarioId, recientes);
      throw new ErrorNegocio(
        429,
        'LIMITE_ALCANZADO',
        'asistente.limite_alcanzado',
      );
    }
    recientes.push(ahora);
    this.consultas.set(usuarioId, recientes);
  }
}
