import { randomUUID } from 'node:crypto';
import type { Entorno } from '../ayudas-organizaciones.js';
import { ayudasFraude, DIA_MS } from '../fraude/ayudas-fraude.js';
import type { Persona } from '../reservas/ayudas-reservas.js';

/** Ayudas de HU-21: reservas ya pagadas creadas directo en la base, con su fecha de pago a la medida. */
export function ayudasCalificaciones(e: () => Entorno) {
  const f = ayudasFraude(e);
  let n = 0;

  /** Una reserva en `estado`; si está pagada, con su movimiento `liberacion_viaje` hace `pagadaHace` días. */
  const reserva = async (
    org: string,
    c: Persona,
    p: Persona,
    pagadaHace = 1,
    estado: 'pagada' | 'verificacion_fallida' = 'pagada',
  ) => {
    const salida = new Date(Date.now() - (pagadaHace + 1) * DIA_MS);
    // Un mismo conductor no puede publicar viajes solapados: separa cada uno por horas.
    salida.setMinutes(salida.getMinutes() + 200 * n++);
    const { reservaId } = await f.reservaEn(org, c, p, salida, { estado });
    if (estado === 'pagada')
      await e().bd.query(
        `INSERT INTO movimientos_billetera (billetera_id, tipo, monto, estado, reserva_id, hash_tx, clave_idempotencia, creado_en)
         VALUES ($1, 'liberacion_viaje', 10.50, 'confirmado', $2, '0x' || repeat('a', 64), $3, $4)`,
        [
          c.billetera,
          reservaId,
          randomUUID(),
          new Date(Date.now() - pagadaHace * DIA_MS),
        ],
      );
    return reservaId;
  };

  const calificar = (
    token: string,
    reservaId: string,
    cuerpo: object = { estrellas: 5 },
  ) =>
    e()
      .api()
      .post(`/api/v1/reservas/${reservaId}/calificaciones`)
      .set({ Authorization: `Bearer ${token}` })
      .send(cuerpo);

  const estado = (token: string, reservaId: string) =>
    e()
      .api()
      .get(`/api/v1/reservas/${reservaId}/calificaciones`)
      .set({ Authorization: `Bearer ${token}` });

  const filas = async (reservaId: string) =>
    (
      await e().bd.query(
        `SELECT autor_id, destinatario_id, estrellas, comentario FROM calificaciones WHERE reserva_id = $1`,
        [reservaId],
      )
    ).rows;

  const promedio = async (usuarioId: string) =>
    (
      await e().bd.query(
        `SELECT promedio::float8 AS promedio, cantidad FROM promedio_calificacion($1)`,
        [usuarioId],
      )
    ).rows[0] as { promedio: number | null; cantidad: number };

  return { f, reserva, calificar, estado, filas, promedio };
}
