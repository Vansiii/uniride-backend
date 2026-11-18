import { distanciaM, type Punto } from './geo.js';

/** RN-4: más que esto entre dos posiciones seguidas de la misma persona es un salto imposible. */
export const VELOCIDAD_MAXIMA_KMH = 150;
/** RN-3: un par coincide a esta distancia o menos. */
export const DISTANCIA_PAR_M = 100;
/** RN-2: diferencia de hora máxima entre las dos posiciones de un par. */
export const DESFASE_PAR_MS = 15_000;
/** RN-5: pares mínimos (≈ 1 minuto de viaje). */
export const PARES_MINIMOS = 4;

export interface PuntoTraza extends Punto {
  /** Epoch en ms, del GPS del teléfono. */
  tomadaEn: number;
  simulada: boolean;
}

/** En orden de prioridad: si aplican varios, se guarda el primero. */
export type MotivoTrayecto =
  | 'ubicacion_simulada'
  | 'salto_imposible'
  | 'datos_insuficientes'
  | 'trayectos_separados';

/** CA-15: lo que queda en `reservas.evaluacion`. */
export interface Evaluacion {
  resultado: 'verificada' | 'verificacion_fallida';
  motivo: MotivoTrayecto | null;
  puntosPasajero: number;
  pares: number;
  coincidentes: number;
  /** Coincidentes / puntos del pasajero, de 0 a 100, con un decimal. */
  coincidenciaPct: number;
  velocidadMaximaKmh: number;
}

const porHora = (a: PuntoTraza, b: PuntoTraza) => a.tomadaEn - b.tomadaEn;

/** Velocidad más alta entre posiciones seguidas de una traza ordenada. */
function velocidadMaximaKmh(traza: PuntoTraza[]): number {
  let maxima = 0;
  for (let i = 1; i < traza.length; i++) {
    const horas = (traza[i].tomadaEn - traza[i - 1].tomadaEn) / 3_600_000;
    // `UNIQUE(viaje, usuario, tomada_en)`: no hay dos con la misma hora.
    if (horas <= 0) continue;
    const kmh = distanciaM(traza[i - 1], traza[i]) / 1000 / horas;
    if (kmh > maxima) maxima = kmh;
  }
  return maxima;
}

/**
 * HU-23 RN-2 a RN-6: compara la traza del pasajero con la del conductor en el intervalo de su viaje. Función pura: el
 * servidor la llama con los puntos que recibió; el teléfono no decide nada (`AGENTS.md` §5.1).
 */
export function evaluarTrayecto(
  pasajero: PuntoTraza[],
  conductor: PuntoTraza[],
): Evaluacion {
  const p = [...pasajero].sort(porHora);
  const c = [...conductor].sort(porHora);

  // RN-2: a cada punto del pasajero, el del conductor más cercano en el tiempo (dos punteros sobre trazas ordenadas).
  let pares = 0;
  let coincidentes = 0;
  let j = 0;
  for (const punto of p) {
    while (
      j + 1 < c.length &&
      Math.abs(c[j + 1].tomadaEn - punto.tomadaEn) <=
        Math.abs(c[j].tomadaEn - punto.tomadaEn)
    )
      j++;
    const pareja = c[j];
    if (!pareja || Math.abs(pareja.tomadaEn - punto.tomadaEn) > DESFASE_PAR_MS)
      continue;
    pares++;
    if (distanciaM(punto, pareja) <= DISTANCIA_PAR_M) coincidentes++;
  }

  // Se decide con el mismo valor que se guarda (0,1 km/h): 150 exactos no pasan por 150,0000001 de coma flotante.
  const velocidad =
    Math.round(Math.max(velocidadMaximaKmh(p), velocidadMaximaKmh(c)) * 10) /
    10;
  // RN-3 en enteros: coincidentes / total ≥ 0,8 ⇔ 5·coincidentes ≥ 4·total (0,8 · 15 no da 12 en coma flotante).
  const separados = coincidentes * 5 < p.length * 4;
  const motivo: MotivoTrayecto | null = [...p, ...c].some((x) => x.simulada)
    ? 'ubicacion_simulada'
    : velocidad > VELOCIDAD_MAXIMA_KMH
      ? 'salto_imposible'
      : pares < PARES_MINIMOS
        ? 'datos_insuficientes'
        : separados
          ? 'trayectos_separados'
          : null;

  return {
    resultado: motivo ? 'verificacion_fallida' : 'verificada',
    motivo,
    puntosPasajero: p.length,
    pares,
    coincidentes,
    coincidenciaPct:
      p.length === 0 ? 0 : Math.round((coincidentes / p.length) * 1000) / 10,
    velocidadMaximaKmh: velocidad,
  };
}
