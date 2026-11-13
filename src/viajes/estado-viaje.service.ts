import { Injectable, Module } from '@nestjs/common';
import type { Transaccion } from '../comun/prisma.service.js';

/**
 * Único lugar que deriva el estado del viaje de sus reservas (D-23, `AGENTS.md` §5.9). Solo avanza y nunca salta
 * estados: cada transición es un `UPDATE … WHERE estado = <anterior>`, así que repetirla no hace nada.
 * HU-22 (`en_curso`), HU-23 (`verificado`) y HU-24 (`pagado`) agregan aquí su transición.
 */
@Injectable()
export class EstadoViajeService {
  /** `publicado → reservado` con la primera reserva confirmada (CA-13). Devuelve si el viaje cambió. */
  async recalcular(tx: Transaccion, viajeId: string): Promise<boolean> {
    const cambiadas = await tx.$executeRaw`
      UPDATE viajes SET estado = 'reservado'
      WHERE id = ${viajeId}::uuid AND estado = 'publicado'
        AND EXISTS (
          SELECT 1 FROM reservas r
          WHERE r.viaje_id = viajes.id
            AND r.estado IN ('confirmada', 'abordada', 'verificada', 'pagada')
        )`;
    return cambiadas > 0;
  }
}

/** Lo usan el worker de la cola on-chain (billetera) y las reservas, sin que un módulo dependa del otro. */
@Module({ providers: [EstadoViajeService], exports: [EstadoViajeService] })
export class EstadoViajeModule {}
