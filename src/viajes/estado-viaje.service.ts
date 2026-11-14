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
   * abordaje verificado (HU-22 RN-7) y `en_curso → verificado` (HU-23 RN-10, D-23) cuando ninguna reserva queda sin
   * bajar ni con la verificación fallida y alguna se verificó. En orden, así un viaje no salta estados. Devuelve si el
   * viaje cambió.
   */
  async recalcular(tx: Transaccion, viajeId: string): Promise<boolean> {
    // Una transacción a la vez por viaje: dos bajadas que terminan juntas, con READ COMMITTED, verían cada una la
    // reserva de la otra todavía `abordada` y ninguna lo pasaría a `verificado`. La segunda espera aquí y sus consultas
    // siguientes ya ven lo que la primera confirmó.
    await tx.$queryRaw`SELECT 1 FROM viajes WHERE id = ${viajeId}::uuid FOR UPDATE`;
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
    // Una `verificacion_fallida` deja el viaje en curso (la resuelve D-24) sin frenar el pago de las demás reservas.
    const verificado = await tx.$executeRaw`
      UPDATE viajes SET estado = 'verificado'
      WHERE id = ${viajeId}::uuid AND estado = 'en_curso'
        AND EXISTS (
          SELECT 1 FROM reservas r
          WHERE r.viaje_id = viajes.id AND r.estado IN ('verificada', 'pagada')
        )
        AND NOT EXISTS (
          SELECT 1 FROM reservas r
          WHERE r.viaje_id = viajes.id
            AND r.estado IN ('pendiente', 'confirmada', 'abordada', 'verificacion_fallida')
        )`;
    return reservado + enCurso + verificado > 0;
  }
}

/** Lo usan el worker de la cola on-chain (billetera) y las reservas, sin que un módulo dependa del otro. */
@Module({ providers: [EstadoViajeService], exports: [EstadoViajeService] })
export class EstadoViajeModule {}
