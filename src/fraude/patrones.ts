/** Patrones de HU-25 (RN-2, RN-3, RN-4); los comparten el tic de anomalías y las alertas de HU-26. */
export const PATRONES = [
  'viajes_repetidos',
  'sin_desplazamiento',
  'verificaciones_fallidas',
] as const;
export type Patron = (typeof PATRONES)[number];

/** PB-11: patrones del modelo propio y de anillos. Solo alertan: nunca bloquean (RN-1). */
export const PATRONES_ALERTA = [
  ...PATRONES,
  'comportamiento_atipico',
  'anillo_colusion',
] as const;
export type PatronAlerta = (typeof PATRONES_ALERTA)[number];

/** HU-25 RN-11: umbrales fijos en v1; cambiarlos es un cambio de spec. */
export const HORA_MS = 3_600_000;
export const DIA_MS = 24 * HORA_MS;
export const VIAJES_REPETIDOS_MINIMO = 3;
export const VENTANA_VIAJES_REPETIDOS_MS = DIA_MS;
export const DISTANCIA_MINIMA_M = 1000;
export const DURACION_MINIMA_MS = 3 * 60_000;
export const SIN_DESPLAZAMIENTO_PARA_BLOQUEO = 2;
export const VENTANA_SIN_DESPLAZAMIENTO_MS = 7 * DIA_MS;
export const FALLIDAS_MINIMO = 3;
export const VENTANA_FALLIDAS_MS = 7 * DIA_MS;
/** RN-5 y RN-6. */
export const BLOQUEO_PAR_MS = 7 * DIA_MS;
export const BLOQUEO_CUENTA_MS = 72 * HORA_MS;

/**
 * P-1 (RN-2): `salidas` son las horas de salida de las reservas pagadas del par, incluida la evaluada `s`.
 * Hay anomalía si `s` forma parte de 3 salidas seguidas dentro de menos de 24 h. Ida y vuelta (2) es normal.
 */
export function p1ViajesRepetidos(salidas: Date[], s: Date): boolean {
  const t = salidas.map((d) => d.getTime()).sort((a, b) => a - b);
  const pos = t.indexOf(s.getTime());
  if (pos < 0) return false;
  const n = VIAJES_REPETIDOS_MINIMO;
  for (let i = Math.max(0, pos - n + 1); i <= pos && i + n - 1 < t.length; i++)
    if (t[i + n - 1] - t[i] < VENTANA_VIAJES_REPETIDOS_MS) return true;
  return false;
}

export interface Prueba {
  lat: number;
  lng: number;
  /** Epoch en ms de la prueba aceptada. */
  en: number;
}

/** P-2 (RN-3): `null` si no hay anomalía; si no, las cifras que se guardan (nunca coordenadas, RN-10). */
export function p2SinDesplazamiento(
  distanciaMetros: number,
  duracionMs: number,
): { distanciaM: number; minutos: number } | null {
  if (distanciaMetros >= DISTANCIA_MINIMA_M && duracionMs >= DURACION_MINIMA_MS)
    return null;
  return {
    distanciaM: Math.round(distanciaMetros),
    minutos: Math.round((duracionMs / 60_000) * 10) / 10,
  };
}

/** P-3 (RN-4): `fechas` son las bajadas de reservas en verificación fallida; cuentan las de los últimos 7 días. */
export function p3VerificacionesFallidas(fechas: Date[], ahora: Date): number {
  const cuenta = fechas.filter(
    (f) => ahora.getTime() - f.getTime() < VENTANA_FALLIDAS_MS,
  ).length;
  return cuenta >= FALLIDAS_MINIMO ? cuenta : 0;
}

/** El par se guarda ordenado para que una fila sirva a los dos roles. */
export const ordenarPar = (a: string, b: string): [string, string] =>
  a < b ? [a, b] : [b, a];
