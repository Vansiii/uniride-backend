/**
 * PB-11 RN-2/RN-4: Isolation Forest (Liu, Ting y Zhou, 2008) en TypeScript puro, sin servicios externos.
 * Aprende qué es normal sin ejemplos de fraude: un punto raro se aísla con menos cortes al azar que uno común.
 * Con la misma semilla y las mismas filas el bosque es idéntico, así que el puntaje es reproducible.
 */

export const ARBOLES = 100;
export const MUESTRA = 128;

type Nodo =
  | { hoja: true; tamano: number }
  | { hoja: false; cifra: number; corte: number; izq: Nodo; der: Nodo };

export interface Bosque {
  arboles: Nodo[];
  muestra: number;
}

/** Generador pseudoaleatorio con semilla (mulberry32): mismo número, misma secuencia. */
export function aleatorio(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Largo promedio de un camino sin éxito en un árbol binario de búsqueda con `n` puntos. */
export function largoPromedio(n: number): number {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n;
}

function construir(
  filas: number[][],
  profundidad: number,
  limite: number,
  azar: () => number,
): Nodo {
  if (profundidad >= limite || filas.length <= 1)
    return { hoja: true, tamano: filas.length };
  const columnas = filas[0].length;
  // Solo cifras que todavía varían en este grupo: cortar una constante no aísla nada.
  const candidatas: { cifra: number; min: number; max: number }[] = [];
  for (let c = 0; c < columnas; c++) {
    let min = Infinity;
    let max = -Infinity;
    for (const f of filas) {
      if (f[c] < min) min = f[c];
      if (f[c] > max) max = f[c];
    }
    if (max > min) candidatas.push({ cifra: c, min, max });
  }
  if (!candidatas.length) return { hoja: true, tamano: filas.length };
  const { cifra, min, max } =
    candidatas[Math.floor(azar() * candidatas.length)];
  const corte = min + azar() * (max - min);
  const izq: number[][] = [];
  const der: number[][] = [];
  for (const f of filas) (f[cifra] < corte ? izq : der).push(f);
  return {
    hoja: false,
    cifra,
    corte,
    izq: construir(izq, profundidad + 1, limite, azar),
    der: construir(der, profundidad + 1, limite, azar),
  };
}

export function entrenar(
  filas: number[][],
  semilla: number,
  arboles = ARBOLES,
  muestra = MUESTRA,
): Bosque {
  if (!filas.length) throw new Error('Sin filas para entrenar');
  const azar = aleatorio(semilla);
  const tamano = Math.min(muestra, filas.length);
  const limite = Math.ceil(Math.log2(Math.max(tamano, 2)));
  const lista: Nodo[] = [];
  for (let i = 0; i < arboles; i++) {
    // Submuestra sin reemplazo (Fisher-Yates parcial).
    const indices = filas.map((_, j) => j);
    for (let j = 0; j < tamano; j++) {
      const k = j + Math.floor(azar() * (indices.length - j));
      [indices[j], indices[k]] = [indices[k], indices[j]];
    }
    lista.push(
      construir(
        indices.slice(0, tamano).map((j) => filas[j]),
        0,
        limite,
        azar,
      ),
    );
  }
  return { arboles: lista, muestra: tamano };
}

function camino(nodo: Nodo, fila: number[], profundidad: number): number {
  if (nodo.hoja) return profundidad + largoPromedio(nodo.tamano);
  return camino(
    fila[nodo.cifra] < nodo.corte ? nodo.izq : nodo.der,
    fila,
    profundidad + 1,
  );
}

/** Puntaje de anomalía en 0–1: ~0,5 o menos es normal; cerca de 1, muy raro. */
export function puntuar(bosque: Bosque, fila: number[]): number {
  const promedio =
    bosque.arboles.reduce((s, a) => s + camino(a, fila, 0), 0) /
    bosque.arboles.length;
  return 2 ** (-promedio / largoPromedio(bosque.muestra));
}
