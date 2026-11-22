import { entrenar, puntuar, type Bosque } from './bosque-aislamiento.js';

/**
 * PB-11 RN-3/RN-5: las cifras de cada par (conductor–pasajero), su preparación para el modelo, los percentiles dentro
 * de la organización y los factores que más apartan a un par de lo normal. Solo números: nunca ids ni coordenadas.
 */

/** `sospecha`: 1 si un valor alto es sospechoso, -1 si lo es uno bajo. `conteo`: se comprime con log1p. */
export const CIFRAS = [
  { clave: 'viajes7d', sospecha: 1, conteo: true },
  { clave: 'viajes30d', sospecha: 1, conteo: true },
  { clave: 'distanciaPromedioM', sospecha: -1, conteo: true },
  { clave: 'duracionPromedioMin', sospecha: -1, conteo: true },
  { clave: 'fraccionConductor', sospecha: 1, conteo: false },
  { clave: 'fraccionPasajero', sospecha: 1, conteo: false },
  { clave: 'fraccionCalificacionesDelPar', sospecha: 1, conteo: false },
  { clave: 'antiguedadMinimaDias', sospecha: -1, conteo: true },
  { clave: 'cobrosSinRecarga', sospecha: 1, conteo: true },
  { clave: 'fallidas7d', sospecha: 1, conteo: true },
] as const;

export type ClaveCifra = (typeof CIFRAS)[number]['clave'];
export type CifrasPar = Record<ClaveCifra, number>;

/** RN-4. */
export const UMBRAL_ALERTA = 80;
export const MINIMO_PARES = 20;
export const FACTORES = 3;

export const riesgoDe = (puntaje: number): 'bajo' | 'medio' | 'alto' =>
  puntaje >= 70 ? 'alto' : puntaje >= 40 ? 'medio' : 'bajo';

export const aFila = (c: CifrasPar): number[] => CIFRAS.map((d) => c[d.clave]);

export interface Estadisticas {
  /** Por cifra (en el orden de `CIFRAS`), sobre los valores crudos. */
  mediana: number[];
  /** Desvío robusto (1,4826 × MAD); si es 0, la desviación estándar; si también, 1. */
  escala: number[];
  /** 21 cuantiles (0 %, 5 %, … 100 %) para el percentil. */
  cuantiles: number[][];
}

function cuantil(ordenados: number[], q: number): number {
  const pos = (ordenados.length - 1) * q;
  const i = Math.floor(pos);
  const resto = pos - i;
  return i + 1 < ordenados.length
    ? ordenados[i] + resto * (ordenados[i + 1] - ordenados[i])
    : ordenados[i];
}

export function estadisticas(filas: number[][]): Estadisticas {
  const mediana: number[] = [];
  const escala: number[] = [];
  const cuantiles: number[][] = [];
  CIFRAS.forEach((_, c) => {
    const v = filas.map((f) => f[c]).sort((a, b) => a - b);
    const m = cuantil(v, 0.5);
    const mad = cuantil(
      v.map((x) => Math.abs(x - m)).sort((a, b) => a - b),
      0.5,
    );
    const media = v.reduce((s, x) => s + x, 0) / v.length;
    const desv = Math.sqrt(
      v.reduce((s, x) => s + (x - media) ** 2, 0) / v.length,
    );
    mediana.push(m);
    escala.push(mad > 0 ? 1.4826 * mad : desv > 0 ? desv : 1);
    cuantiles.push(
      Array.from({ length: 21 }, (_, i) => redondear(cuantil(v, i / 20), 4)),
    );
  });
  return { mediana, escala, cuantiles };
}

/**
 * Lo que ve el bosque: los conteos con log1p y, en la dirección que no es sospechosa, el valor se recorta a la
 * mediana. Así un par que viaja muy lejos o tiene una cuenta muy vieja no parece «raro»: solo aísla lo sospechoso.
 */
export function prepararFila(est: Estadisticas, fila: number[]): number[] {
  return CIFRAS.map((d, c) => {
    const x =
      d.sospecha > 0
        ? Math.max(fila[c], est.mediana[c])
        : Math.min(fila[c], est.mediana[c]);
    return d.conteo ? Math.log1p(Math.max(0, x)) : x;
  });
}

/** Percentil entero 0–100 del valor dentro de la organización. */
export function percentil(est: Estadisticas, c: number, v: number): number {
  const q = est.cuantiles[c];
  if (v <= q[0]) return 0;
  if (v >= q[20]) return 100;
  for (let i = 1; i <= 20; i++)
    if (v <= q[i]) {
      const ancho = q[i] - q[i - 1];
      const dentro = ancho > 0 ? (v - q[i - 1]) / ancho : 1;
      return Math.round((i - 1 + dentro) * 5);
    }
  return 100;
}

export interface Factor {
  cifra: ClaveCifra;
  valor: number;
  percentil: number;
}

/** RN-5: las 3 cifras con mayor desvío robusto en la dirección sospechosa. */
export function factores(est: Estadisticas, fila: number[]): Factor[] {
  return CIFRAS.map((d, c) => ({
    c,
    desvio: (d.sospecha * (fila[c] - est.mediana[c])) / est.escala[c],
  }))
    .filter((x) => x.desvio > 0)
    .sort((a, b) => b.desvio - a.desvio || a.c - b.c)
    .slice(0, FACTORES)
    .map(({ c }) => ({
      cifra: CIFRAS[c].clave,
      valor: redondear(fila[c], 2),
      percentil: percentil(est, c, fila[c]),
    }));
}

/**
 * RN-4: lleva el puntaje del bosque (0–1) a 0–100. Isolation Forest da ~0,5 o menos a lo normal; la escala se fijó con
 * los escenarios simulados (`escenarios.spec.ts`): 0,5 → 0, 0,62 → 80 (umbral de alerta), 0,65 → 100.
 */
export const escalarPuntaje = (s: number): number =>
  Math.max(0, Math.min(100, Math.round(((s - 0.5) * 80) / 0.12)));

export const redondear = (v: number, decimales: number): number => {
  const f = 10 ** decimales;
  return Math.round(v * f) / f;
};

export interface Modelo {
  bosque: Bosque;
  est: Estadisticas;
}

/** RN-2: entrena con las cifras crudas de los pares de la organización. */
export function entrenarModelo(filas: number[][], semilla: number): Modelo {
  const est = estadisticas(filas);
  return {
    est,
    bosque: entrenar(
      filas.map((f) => prepararFila(est, f)),
      semilla,
    ),
  };
}

export function evaluarPar(
  m: Modelo,
  fila: number[],
): {
  puntaje: number;
  factores: Factor[];
  percentiles: Record<ClaveCifra, number>;
} {
  return {
    puntaje: escalarPuntaje(puntuar(m.bosque, prepararFila(m.est, fila))),
    factores: factores(m.est, fila),
    percentiles: Object.fromEntries(
      CIFRAS.map((d, c) => [d.clave, percentil(m.est, c, fila[c])]),
    ) as Record<ClaveCifra, number>,
  };
}
