import { randomUUID } from 'node:crypto';
import { AnomaliasService } from '../../src/fraude/anomalias.service.js';
import type { Entorno } from '../ayudas-organizaciones.js';
import { ayudasReservas, type Persona } from '../reservas/ayudas-reservas.js';

export const HORA_MS = 3_600_000;
export const DIA_MS = 24 * HORA_MS;

export interface Punto {
  lat: number;
  lng: number;
}

/** ~10 km al norte de `A`: sobra para pasar el umbral de 1 km de P-2. */
export const A: Punto = { lat: -17.78, lng: -63.18 };
export const LEJOS: Punto = { lat: -17.69, lng: -63.18 };

export interface Opciones {
  estado?: 'pagada' | 'verificacion_fallida';
  /** Posiciones del pasajero en el abordaje y la bajada (`en` en ms desde la salida). */
  abordaje?: Punto & { en?: number };
  bajada?: Punto & { en?: number };
}

/** Ayudas de HU-25: reservas ya cobradas o fallidas creadas directo en la base y el tic de anomalías a mano. */
export function ayudasFraude(e: () => Entorno) {
  const r = ayudasReservas(e);
  const tic = (ahora?: Date) =>
    e().app.get(AnomaliasService).evaluarPendientes(ahora);

  /** Un viaje del conductor con la salida dada y una reserva suya en el estado pedido, con sus pruebas de presencia. */
  const reservaEn = async (
    org: string,
    c: Persona,
    p: Persona,
    salida: Date,
    o: Opciones = {},
  ) => {
    const viajeId = await r.publicar(c, {
      fechaHoraSalida: salida.toISOString(),
    });
    const { rows } = await e().bd.query(
      `INSERT INTO reservas (organizacion_id, viaje_id, pasajero_id, monto, estado, clave_idempotencia)
       VALUES ($1, $2, $3, 10.50, $4, $5) RETURNING id`,
      [org, viajeId, p.id, o.estado ?? 'pagada', randomUUID()],
    );
    const reservaId = rows[0].id as string;
    const prueba = async (
      tipo: 'abordaje' | 'bajada',
      pos: (Punto & { en?: number }) | undefined,
      porDefecto: number,
    ) => {
      if (!pos) return;
      await e().bd.query(
        `INSERT INTO pruebas_presencia (organizacion_id, reserva_id, tipo, pasajero_lat, pasajero_lng, resultado, hash_prueba, creado_en)
         VALUES ($1, $2, $3, $4, $5, 'aceptada', 'hash-de-prueba', $6)`,
        [
          org,
          reservaId,
          tipo,
          pos.lat,
          pos.lng,
          new Date(salida.getTime() + (pos.en ?? porDefecto)),
        ],
      );
    };
    await prueba('abordaje', o.abordaje, 0);
    await prueba('bajada', o.bajada, 30 * 60_000);
    return { reservaId, viajeId };
  };

  /** Reserva con desplazamiento normal (10 km en 30 min). */
  const viajeNormal = (
    org: string,
    c: Persona,
    p: Persona,
    salida: Date,
    estado: Opciones['estado'] = 'pagada',
  ) => reservaEn(org, c, p, salida, { estado, abordaje: A, bajada: LEJOS });

  const bloqueos = async (usuarioId: string) =>
    (
      await e().bd.query(
        `SELECT tipo, usuario_id, usuario_par_id, patron, reserva_id, vence_en
         FROM bloqueos_preventivos WHERE usuario_id = $1 OR usuario_par_id = $1 ORDER BY creado_en`,
        [usuarioId],
      )
    ).rows;

  const alertas = async (usuarioIds: string[], accion = 'fraude.alerta') =>
    (
      await e().bd.query(
        `SELECT organizacion_id, accion, detalle FROM registros_auditoria
         WHERE accion = $2 AND detalle->'personas' ?| $1 ORDER BY creado_en`,
        [usuarioIds, accion],
      )
    ).rows;

  const sinEvaluar = async (reservaId: string) =>
    (
      await e().bd.query(
        `SELECT anomalias_evaluadas_en FROM reservas WHERE id = $1`,
        [reservaId],
      )
    ).rows[0].anomalias_evaluadas_en === null;

  /** Una persona que además publica: conductor con billetera y saldo para reservar. */
  const persona = async (org: string): Promise<Persona> => {
    const c = await r.conductor(org);
    await r.fondear(c, '50.00');
    return c;
  };

  return {
    r,
    tic,
    reservaEn,
    viajeNormal,
    bloqueos,
    alertas,
    sinEvaluar,
    persona,
  };
}
