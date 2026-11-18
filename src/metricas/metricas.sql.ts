import type { Transaccion } from '../comun/prisma.service.js';

/** kg de CO₂ evitados por km recorrido y por pasajero (factor aprobado por el PO el 17/11/2026). */
export const KG_CO2_POR_KM = 0.12;

export interface Agregado {
  viajesPagados: number;
  pasajeros: number;
  /** Suma de la distancia en línea recta de cada reserva pagada, en km. */
  distanciaKm: number;
}

/**
 * Consulta única de HU-32 y HU-33. Una reserva cuenta cuando está `pagada`; su fecha es la del movimiento
 * `liberacion_viaje` (no `actualizado_en`, que otros procesos también tocan). La distancia es la recta entre origen y
 * destino (Haversine) porque el viaje no guarda la ruta. `organizacionId` nulo = todas (solo con `comoSuperAdmin`).
 */
export async function agregarPagadas(
  tx: Transaccion,
  organizacionId: string | null,
  desde: Date | null,
): Promise<Agregado> {
  const [fila] = await tx.$queryRaw<
    { viajes: bigint; pasajeros: bigint; km: number }[]
  >`
    SELECT count(DISTINCT r.viaje_id) AS viajes, count(*) AS pasajeros,
      coalesce(sum(2 * 6371 * asin(sqrt(
        power(sin(radians(v.destino_lat::float8 - v.origen_lat::float8) / 2), 2) +
        cos(radians(v.origen_lat::float8)) * cos(radians(v.destino_lat::float8)) *
        power(sin(radians(v.destino_lng::float8 - v.origen_lng::float8) / 2), 2)))), 0)::float8 AS km
    FROM reservas r
    JOIN viajes v ON v.id = r.viaje_id
    JOIN LATERAL (
      SELECT min(m.creado_en) AS pagada_en FROM movimientos_billetera m
      WHERE m.reserva_id = r.id AND m.tipo = 'liberacion_viaje') p ON p.pagada_en IS NOT NULL
    WHERE r.estado = 'pagada'
      AND (${organizacionId}::uuid IS NULL OR r.organizacion_id = ${organizacionId}::uuid)
      AND (${desde}::timestamptz IS NULL OR p.pagada_en >= ${desde}::timestamptz)`;
  return {
    viajesPagados: Number(fila.viajes),
    pasajeros: Number(fila.pasajeros),
    distanciaKm: fila.km,
  };
}

/** CO₂ en kg con un decimal, redondeado una sola vez al final. */
export const co2Kg = (distanciaKm: number) =>
  Math.round(distanciaKm * KG_CO2_POR_KM * 10) / 10;
