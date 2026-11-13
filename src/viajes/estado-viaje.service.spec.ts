import type { Transaccion } from '../comun/prisma.service.js';
import { EstadoViajeService } from './estado-viaje.service.js';

function crear(filas: number) {
  const tx = { $executeRaw: vi.fn().mockResolvedValue(filas) };
  return { tx, transaccion: tx as unknown as Transaccion };
}
const sql = (c: ReturnType<typeof crear>) =>
  (c.tx.$executeRaw.mock.calls[0][0] as string[])
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
});
