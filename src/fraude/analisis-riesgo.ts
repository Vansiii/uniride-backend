/** PB-10: funciones puras del análisis de riesgo con IA (perfil seudónimo, prompt y validación). */
import type { ClaveCifra, Factor } from './cifras-par.js';

export const RIESGOS = ['bajo', 'medio', 'alto'] as const;
export type Riesgo = (typeof RIESGOS)[number];

/** RN-7, CA-3. */
export const ALERTAS_POR_CICLO = 5;
export const INTENTOS_MAXIMOS = 3;
/** RN-5. */
export const MOTIVOS_MAXIMOS = 3;
export const LARGO_MOTIVO = 160;
export const LARGO_RECOMENDACION = 200;

export interface Analisis {
  riesgo: Riesgo;
  puntaje: number;
  motivos: string[];
  recomendacion: string;
}

/** Cifras de una persona de la alerta. Solo números: nunca ids, nombres ni coordenadas (CA-8). */
export interface CifrasPersona {
  antiguedadDias: number;
  fallidas7d: number;
  calificacionPromedio: number | null;
  calificaciones: number;
  calificacionesDelPar: number;
  recargas30d: number;
  cobros30d: number;
  pagos30d: number;
}

export interface CifrasPar {
  reservas7d: number;
  reservas30d: number;
  distanciaPromedioM: number | null;
  duracionPromedioMin: number | null;
}

/** PB-11: lo que decidió el modelo propio. La IA de lenguaje solo lo explica (RN-7). */
export interface PerfilModelo {
  puntaje: number;
  riesgo: Riesgo;
  factores: Factor[];
  /** Percentil de cada cifra del par dentro de la organización. */
  percentiles: Record<ClaveCifra, number>;
}

export interface Perfil {
  patron: string;
  modelo?: PerfilModelo;
  /** PB-11: alerta de anillo (las personas pasan a ser «A», «B», «C»…). */
  anillo?: { personas: number; viajesInternos: number; proporcion: number };
  cantidad?: number;
  distanciaM?: number;
  minutos?: number;
  alertasPrevias: number;
  par: CifrasPar | null;
  personas: CifrasPersona[];
}

export const PROMPT_SISTEMA = `Eres analista antifraude de UniRide, un servicio de viajes compartidos entre miembros de una misma organización (universidad o empresa).
Contexto: el pasaje se paga con saldo en garantía y se libera al conductor solo si el viaje se verifica al subir y al bajar. Los viajes no crean saldo, así que el fraude típico es la colusión para simular viajes (mismo par repetido, sin desplazamiento real, cuentas nuevas que solo se califican entre sí, cobros sin recargas) o el GPS falso (verificaciones fallidas repetidas).
Recibes las cifras de una alerta que ya disparó una regla. Las personas se llaman "A" y "B".
Responde SOLO un objeto JSON con esta forma exacta:
{"riesgo":"bajo"|"medio"|"alto","puntaje":<entero 0-100>,"motivos":[<1 a 3 frases de hasta 160 caracteres>],"recomendacion":"<hasta 200 caracteres>"}
Reglas: en español; basa cada motivo en una cifra recibida; no inventes datos; no menciones blockchain; tu respuesta es una sugerencia para un administrador humano, no una sanción.`;

/** PB-11 RN-7: con modelo propio, el riesgo y el puntaje ya están decididos; la IA solo los explica. */
export const PROMPT_SISTEMA_MODELO = `Eres analista antifraude de UniRide, un servicio de viajes compartidos entre miembros de una misma organización (universidad o empresa).
Contexto: el pasaje se paga con saldo en garantía y se libera al conductor solo si el viaje se verifica al subir y al bajar. Los viajes no crean saldo, así que el fraude típico es la colusión para simular viajes o el GPS falso.
Un modelo estadístico propio (Isolation Forest entrenado con los viajes de la organización) ya calculó el puntaje de anomalía y el riesgo, y te pasa en "modelo.factores" las cifras que más se apartan de lo normal, con su percentil dentro de la organización (percentil 99 = más alto que el 99 % de los pares). Las personas se llaman "A", "B", "C".
No cambies el puntaje ni el riesgo. Explícalos al administrador.
Responde SOLO un objeto JSON con esta forma exacta:
{"motivos":[<1 a 3 frases de hasta 160 caracteres>],"recomendacion":"<hasta 200 caracteres>"}
Reglas: en español; cada motivo DEBE citar una cifra o un percentil recibido, con el número; no inventes datos; no menciones blockchain; es una sugerencia para un administrador humano, no una sanción.`;

/** Arma el texto que se envía a la IA. Las personas solo aparecen como «A» y «B». */
export function textoPerfil(p: Perfil): string {
  const personas = Object.fromEntries(
    p.personas.map((c, i) => [String.fromCharCode(65 + i), c]),
  );
  return JSON.stringify({
    patron: p.patron,
    modelo: p.modelo,
    anillo: p.anillo,
    cifrasDeLaAlerta: {
      cantidad: p.cantidad,
      distanciaM: p.distanciaM,
      minutos: p.minutos,
    },
    alertasPreviasDelPar: p.alertasPrevias,
    par: p.par,
    ...personas,
  });
}

const NUMERO = /\d+(?:[.,]\d+)?/g;
const normalizar = (n: string) => String(Number(n.replace(',', '.')));

/** Números que aparecen en el texto enviado a la IA (PB-11 CA-6). */
export const numerosDe = (texto: string): Set<string> =>
  new Set((texto.match(NUMERO) ?? []).map(normalizar));

/**
 * RN-5 / CA-4: `null` si la respuesta no cumple el formato. PB-11: con `modelo`, el riesgo y el puntaje salen del
 * modelo (lo que diga la IA se ignora) y cada motivo debe citar un número del perfil enviado (CA-6).
 */
export function validarAnalisis(
  json: string,
  modelo?: { puntaje: number; riesgo: Riesgo; numeros: Set<string> },
): Analisis | null {
  let dato: unknown;
  try {
    dato = JSON.parse(json);
  } catch {
    return null;
  }
  if (!dato || typeof dato !== 'object') return null;
  const campos = dato as Record<string, unknown>;
  const { motivos, recomendacion } = campos;
  const riesgo = modelo ? modelo.riesgo : campos.riesgo;
  const puntaje = modelo ? modelo.puntaje : campos.puntaje;
  if (!RIESGOS.includes(riesgo as Riesgo)) return null;
  if (
    !Number.isInteger(puntaje) ||
    (puntaje as number) < 0 ||
    (puntaje as number) > 100
  )
    return null;
  if (
    !Array.isArray(motivos) ||
    motivos.length < 1 ||
    motivos.length > MOTIVOS_MAXIMOS ||
    !motivos.every(
      (m) => typeof m === 'string' && m.trim() && m.length <= LARGO_MOTIVO,
    )
  )
    return null;
  if (
    modelo &&
    !(motivos as string[]).every((m) =>
      (m.match(NUMERO) ?? []).some((n) => modelo.numeros.has(normalizar(n))),
    )
  )
    return null;
  if (
    typeof recomendacion !== 'string' ||
    !recomendacion.trim() ||
    recomendacion.length > LARGO_RECOMENDACION
  )
    return null;
  return {
    riesgo: riesgo as Riesgo,
    puntaje: puntaje as number,
    motivos: (motivos as string[]).map((m) => m.trim()),
    recomendacion: recomendacion.trim(),
  };
}
