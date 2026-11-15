/** RN-2: distancia máxima entre conductor y pasajero. RN-4: precisión máxima informada. */
export const DISTANCIA_MAXIMA_M = 50;
export const PRECISION_MAXIMA_M = 50;
/** RN-4: antigüedad máxima de una posición (y tolerancia de un reloj adelantado). */
export const ANTIGUEDAD_MAXIMA_MS = 30_000;
/** RN-1: vida del código. */
export const VIDA_DESAFIO_MS = 30_000;
/** RN-3: ventana de abordaje alrededor de la hora de salida. */
export const ANTES_DE_SALIDA_MS = 30 * 60_000;
export const DESPUES_DE_SALIDA_MS = 15 * 60_000;

const RADIO_TIERRA_M = 6_371_008.8;
const rad = (g: number) => (g * Math.PI) / 180;

export interface Punto {
  lat: number;
  lng: number;
}

/** Haversine: a 50 m el error frente al elipsoide es de centímetros. */
export function distanciaM(a: Punto, b: Punto): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** RN-3: desde y hasta cuándo se puede abordar un viaje que sale a `salida`. */
export function ventanaAbordaje(salida: Date): { desde: Date; hasta: Date } {
  return {
    desde: new Date(salida.getTime() - ANTES_DE_SALIDA_MS),
    hasta: new Date(salida.getTime() + DESPUES_DE_SALIDA_MS),
  };
}

export interface Posicion extends Punto {
  precisionM: number;
  /** Epoch en ms, del GPS del teléfono. */
  tomadaEn: number;
  simulada: boolean;
}

/** RN-4: `null` si la posición sirve; si no, el motivo del rechazo. */
export function motivoPosicionInvalida(
  p: Posicion,
  ahora = Date.now(),
): 'ubicacion_simulada' | 'senal_gps' | null {
  if (p.simulada) return 'ubicacion_simulada';
  if (
    p.precisionM > PRECISION_MAXIMA_M ||
    Math.abs(ahora - p.tomadaEn) > ANTIGUEDAD_MAXIMA_MS
  )
    return 'senal_gps';
  return null;
}
