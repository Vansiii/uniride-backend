import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { ErrorNegocio } from './error-negocio.js';
import { PrismaService } from './prisma.service.js';

/**
 * CA-6 y RN-7: solo pasa quien tiene la identidad `verificada` en `identidades` (sin fila = no verificada).
 * Va después del `JwtGuard` global, que deja `request.usuario`. El estado se lee en cada petición: no viaja en el token.
 */
@Injectable()
export class IdentidadVerificadaGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const usuario = contexto.switchToHttp().getRequest().usuario as
      { id?: string } | undefined;
    if (!usuario?.id)
      throw new ErrorNegocio(
        401,
        'NO_AUTENTICADO',
        'comun.errores.no_autenticado',
      );
    const identidad = await this.prisma.identidad.findUnique({
      where: { usuarioId: usuario.id },
      select: { estado: true },
    });
    if (identidad?.estado !== 'verificada')
      throw new ErrorNegocio(
        403,
        'IDENTIDAD_NO_VERIFICADA',
        'identidad.verificacion.requerida',
      );
    return true;
  }
}

/** HU-12, HU-17 y HU-19: `@RequiereIdentidadVerificada()` en el endpoint (el módulo ya tiene `PrismaService`, que es global). */
export const RequiereIdentidadVerificada = () =>
  UseGuards(IdentidadVerificadaGuard);
