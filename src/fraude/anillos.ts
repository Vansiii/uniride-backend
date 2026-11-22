/**
 * PB-11 RN-6: anillos de colusión. Grafo de compañeros frecuentes (el par suma ≥ 20 % de los viajes pagados de 30 días
 * de cada uno); se quitan, una y otra vez, las personas con menos de 2 compañeros frecuentes en el grupo (núcleo 2: exige
 * ciclos, como la rotación de roles de la colusión; un auto compartido con pasajeros fijos es una estrella y no queda) y
 * las que hacen menos del 80 % de sus viajes dentro del grupo. Lo que queda con ≥ 3 personas y ≥ 6 viajes internos es un
 * grupo que casi solo viaja entre sí: el patrón que una regla por pares no ve.
 */

export const ANILLO_MINIMO_PERSONAS = 3;
export const ANILLO_MINIMO_VIAJES = 6;
export const ANILLO_FRACCION_INTERNA = 0.8;
export const COMPANERO_FRECUENTE = 0.2;
export const COMPANEROS_MINIMOS = 2;

export interface Arista {
  a: string;
  b: string;
  viajes: number;
}

export interface Anillo {
  /** Ordenadas: sirven de clave para no repetir la alerta. */
  personas: string[];
  viajesInternos: number;
  /** Viajes internos ÷ viajes totales de las personas del grupo. */
  proporcion: number;
  aristas: Arista[];
}

function componentes(personas: Set<string>, aristas: Arista[]): string[][] {
  const vecinos = new Map<string, string[]>();
  for (const p of personas) vecinos.set(p, []);
  for (const { a, b } of aristas)
    if (personas.has(a) && personas.has(b)) {
      vecinos.get(a)!.push(b);
      vecinos.get(b)!.push(a);
    }
  const visto = new Set<string>();
  const grupos: string[][] = [];
  for (const inicio of [...personas].sort()) {
    if (visto.has(inicio)) continue;
    const grupo: string[] = [];
    const pila = [inicio];
    visto.add(inicio);
    while (pila.length) {
      const p = pila.pop()!;
      grupo.push(p);
      for (const v of vecinos.get(p)!)
        if (!visto.has(v)) {
          visto.add(v);
          pila.push(v);
        }
    }
    grupos.push(grupo.sort());
  }
  return grupos;
}

/** `totales`: viajes pagados de 30 días de cada persona, como conductora o pasajera, con cualquiera. */
export function buscarAnillos(
  aristas: Arista[],
  totales: Map<string, number>,
): Anillo[] {
  const total = (p: string) => totales.get(p) ?? 0;
  const fuertes = aristas.filter(
    (x) =>
      x.viajes >= COMPANERO_FRECUENTE * total(x.a) &&
      x.viajes >= COMPANERO_FRECUENTE * total(x.b),
  );
  const vivas = new Set(fuertes.flatMap((x) => [x.a, x.b]));
  for (;;) {
    const quitar = new Set<string>();
    const grado = new Map<string, number>();
    for (const x of fuertes)
      if (vivas.has(x.a) && vivas.has(x.b)) {
        grado.set(x.a, (grado.get(x.a) ?? 0) + 1);
        grado.set(x.b, (grado.get(x.b) ?? 0) + 1);
      }
    for (const p of vivas)
      if ((grado.get(p) ?? 0) < COMPANEROS_MINIMOS) quitar.add(p);
    for (const grupo of componentes(vivas, fuertes)) {
      const dentro = new Set(grupo);
      const internos = new Map<string, number>();
      for (const x of aristas)
        if (dentro.has(x.a) && dentro.has(x.b)) {
          internos.set(x.a, (internos.get(x.a) ?? 0) + x.viajes);
          internos.set(x.b, (internos.get(x.b) ?? 0) + x.viajes);
        }
      for (const p of grupo) {
        const t = Math.max(total(p), internos.get(p) ?? 0);
        if (!t || (internos.get(p) ?? 0) / t < ANILLO_FRACCION_INTERNA)
          quitar.add(p);
      }
    }
    if (!quitar.size) break;
    for (const p of quitar) vivas.delete(p);
  }

  const anillos: Anillo[] = [];
  for (const grupo of componentes(vivas, fuertes)) {
    if (grupo.length < ANILLO_MINIMO_PERSONAS) continue;
    const dentro = new Set(grupo);
    const propias = aristas
      .filter((x) => dentro.has(x.a) && dentro.has(x.b))
      .map((x) => (x.a < x.b ? x : { a: x.b, b: x.a, viajes: x.viajes }))
      .sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
    const viajesInternos = propias.reduce((s, x) => s + x.viajes, 0);
    if (viajesInternos < ANILLO_MINIMO_VIAJES) continue;
    const totalGrupo = grupo.reduce(
      (s, p) => s + Math.max(totales.get(p) ?? 0, 0),
      0,
    );
    anillos.push({
      personas: grupo,
      viajesInternos,
      // Cada viaje interno cuenta para dos personas.
      proporcion: totalGrupo
        ? Math.min(
            1,
            Math.round(((2 * viajesInternos) / totalGrupo) * 100) / 100,
          )
        : 1,
      aristas: propias,
    });
  }
  return anillos;
}
