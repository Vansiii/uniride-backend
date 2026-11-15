import type { Transaccion } from '../comun/prisma.service.js';
import { EstadoViajeService } from './estado-viaje.service.js';

function crear(filas: number) {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(filas),
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  return { tx, transaccion: tx as unknown as Transaccion };
}
const sql = (c: ReturnType<typeof crear>, llamada = 0) =>
  (c.tx.$executeRaw.mock.calls[llamada][0] as string[])
    .join('?')
    .replace(/\s+/g, ' ');

describe('EstadoViajeService.recalcular (D-23)', () => {
  const servicio = new EstadoViajeService();

  it('publicado → reservado con una reserva confirmada: devuelve que cambió', async () => {
    const c = crear(1);
    await expect(servicio.recalcular(c.transaccion, 'v1')).resolves.toBe(true);
    expect(sql(c)).toContain("SET estado = 'reservado'");
    expect(sql(c)).toContain("estado = 'publicado'");
  });

  it('sin reserva confirmada, o con el viaje ya avanzado, no cambia nada y repetirlo es seguro', async () => {
    const c = crear(0);
    await expect(servicio.recalcular(c.transaccion, 'v1')).resolves.toBe(false);
    await expect(servicio.recalcular(c.transaccion, 'v1')).resolves.toBe(false);
  });

  it('solo avanza desde publicado: nunca revive uno cancelado ni retrocede uno en curso', async () => {
    const c = crear(0);
    await servicio.recalcular(c.transaccion, 'v1');
    const consulta = sql(c);
    // La única condición de estado del viaje es `publicado`; cancelado, en curso, verificado y pagado quedan fuera.
    expect(consulta.match(/estado = '/g)).toHaveLength(2);
    expect(consulta).not.toMatch(
      /cancelado|en_curso|verificado|pagado|expirado/,
    );
  });

  it('cuenta las reservas que ya pasaron por confirmada, no las pendientes ni las fallidas', async () => {
    const c = crear(0);
    await servicio.recalcular(c.transaccion, 'v1');
    expect(sql(c)).toContain(
      "IN ('confirmada', 'abordada', 'verificada', 'pagada')",
    );
    expect(sql(c)).not.toContain("'pendiente'");
    expect(sql(c)).not.toContain("'fallida'");
  });

  it('HU-22 RN-7: reservado → en_curso con el primer abordaje, después del paso a reservado', async () => {
    const c = crear(0);
    await servicio.recalcular(c.transaccion, 'v1');
    const enCurso = sql(c, 1);
    expect(enCurso).toContain("SET estado = 'en_curso'");
    expect(enCurso).toContain("estado = 'reservado'");
    expect(enCurso).toContain("IN ('abordada', 'verificada', 'pagada')");
    expect(enCurso).not.toContain("'confirmada'");
  });

  it('HU-23 RN-10: en_curso → verificado cuando nadie queda sin bajar ni con la verificación fallida', async () => {
    const c = crear(0);
    await servicio.recalcular(c.transaccion, 'v1');
    const verificado = sql(c, 2);
    expect(verificado).toContain("SET estado = 'verificado'");
    expect(verificado).toContain("estado = 'en_curso'");
    expect(verificado).toContain("IN ('verificada', 'pagada')");
    expect(verificado).toMatch(
      /NOT EXISTS .*IN \('pendiente', 'confirmada', 'abordada', 'verificacion_fallida'\)/,
    );
  });

  it('HU-24 CA-10: verificado → pagado cuando ninguna reserva queda sin pagar, al final', async () => {
    const c = crear(0);
    await servicio.recalcular(c.transaccion, 'v1');
    const pagado = sql(c, 3);
    expect(pagado).toContain("SET estado = 'pagado'");
    expect(pagado).toContain("estado = 'verificado'");
    expect(pagado).toMatch(
      /NOT EXISTS .*IN \('pendiente', 'confirmada', 'abordada', 'verificada', 'verificacion_fallida'\)/,
    );
    expect(c.tx.$executeRaw).toHaveBeenCalledTimes(4);
  });

  it('HU-23 RN-10: bloquea la fila del viaje antes de mirar sus reservas (dos bajadas a la vez)', async () => {
    const c = crear(0);
    await servicio.recalcular(c.transaccion, 'v1');
    expect((c.tx.$queryRaw.mock.calls[0][0] as string[]).join('?')).toContain(
      'FOR UPDATE',
    );
    expect(c.tx.$queryRaw).toHaveBeenCalledBefore(c.tx.$executeRaw);
  });
});
