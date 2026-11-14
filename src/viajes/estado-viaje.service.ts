import { Injectable, Module } from '@nestjs/common';
import type { Transaccion } from '../comun/prisma.service.js';

/**
 * Único lugar que deriva el estado del viaje de sus reservas (D-23, `AGENTS.md` §5.9). Solo avanza y nunca salta
 * estados: cada transición es un `UPDATE … WHERE estado = <anterior>`, así que repetirla no hace nada.
 * HU-22 (`en_curso`), HU-23 (`verificado`) y HU-24 (`pagado`) agregan aquí su transición.
 */
@Injectable()
export class EstadoViajeService {
  /**
   * `publicado → reservado` con la primera reserva confirmada (HU-19 CA-13) y `reservado → en_curso` con el primer
   * abordaje verificado (HU-22 RN-7). En orden, así un viaje no salta `reservado`. Devuelve si el viaje cambió.
   */
  async recalcular(tx: Transaccion, viajeId: string): Promise<boolean> {
    const reservado = await tx.$executeRaw`
      UPDATE viajes SET estado = 'reservado'
      WHERE id = ${viajeId}::uuid AND estado = 'publicado'
        AND EXISTS (
          SELECT 1 FROM reservas r
          WHERE r.viaje_id = viajes.id
            AND r.estado IN ('confirmada', 'abordada', 'verificada', 'pagada')
        )`;
    const enCurso = await tx.$executeRaw`
      UPDATE viajes SET estado = 'en_curso'
      WHERE id = ${viajeId}::uuid AND estado = 'reservado'
        AND EXISTS (
          SELECT 1 FROM reservas r
          WHERE r.viaje_id = viajes.id
            AND r.estado IN ('abordada', 'verificada', 'pagada')
        )`;
    return reservado + enCurso > 0;
  }
}

/** Lo usan el worker de la cola on-chain (billetera) y las reservas, sin que un módulo dependa del otro. */
@Module({ providers: [EstadoViajeService], exports: [EstadoViajeService] })
export class EstadoViajeModule {}
