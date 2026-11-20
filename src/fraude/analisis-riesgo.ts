/** PB-10: funciones puras del análisis de riesgo con IA (perfil seudónimo, prompt y validación). */

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

export interface Perfil {
  patron: string;
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

/** Arma el texto que se envía a la IA. Las personas solo aparecen como «A» y «B». */
export function textoPerfil(p: Perfil): string {
  const personas = Object.fromEntries(
    p.personas.map((c, i) => [String.fromCharCode(65 + i), c]),
  );
  return JSON.stringify({
    patron: p.patron,
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

/** RN-5 / CA-4: `null` si la respuesta no cumple el formato. */
export function validarAnalisis(json: string): Analisis | null {
  let dato: unknown;
  try {
    dato = JSON.parse(json);
  } catch {
    return null;
  }
  if (!dato || typeof dato !== 'object') return null;
  const { riesgo, puntaje, motivos, recomendacion } = dato as Record<
    string,
    unknown
  >;
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
