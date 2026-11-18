import { Injectable } from '@nestjs/common';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService, type Transaccion } from '../comun/prisma.service.js';
import { ordenarPar } from './patrones.js';

type Cliente = Transaccion | PrismaService;

/**
 * HU-25 RN-5..RN-9. Solo lectura: nadie levanta un bloqueo (CA-12); vence solo (CA-8). La tabla no tiene RLS porque
 * el bloqueo es de la persona y vale en todas sus organizaciones (RN-8).
 */
@Injectable()
export class BloqueosService {
  constructor(private readonly prisma: PrismaService) {}

  /** Fin del bloqueo preventivo de la cuenta, o `null` si no tiene uno vigente. */
  async finBloqueoCuenta(
    usuarioId: string,
    cliente: Cliente = this.prisma,
  ): Promise<Date | null> {
    const fila = await cliente.bloqueoPreventivo.findFirst({
      where: { tipo: 'cuenta', usuarioId, venceEn: { gt: new Date() } },
      orderBy: { venceEn: 'desc' },
      select: { venceEn: true },
    });
    return fila?.venceEn ?? null;
  }

  /** CA-6: rechaza publicar, reservar y recargar; dice solo la fecha de fin (RN-9). */
  async exigirSinBloqueoCuenta(
    usuarioId: string,
    cliente: Cliente = this.prisma,
  ): Promise<void> {
    const hasta = await this.finBloqueoCuenta(usuarioId, cliente);
    if (hasta)
      throw new ErrorNegocio(
        403,
        'BLOQUEO_PREVENTIVO',
        'comun.errores.bloqueo_preventivo',
        { hasta },
      );
  }

  /** CA-5: el par bloqueado no reserva entre sí, en ningún rol (una fila sirve a los dos). */
  async parBloqueado(
    a: string,
    b: string,
    cliente: Cliente = this.prisma,
  ): Promise<boolean> {
    const [usuarioId, usuarioParId] = ordenarPar(a, b);
    const fila = await cliente.bloqueoPreventivo.findFirst({
      where: {
        tipo: 'par',
        usuarioId,
        usuarioParId,
        venceEn: { gt: new Date() },
      },
      select: { id: true },
    });
    return fila !== null;
  }
}
