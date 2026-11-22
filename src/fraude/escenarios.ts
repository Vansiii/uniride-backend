/**
 * PB-11 CA-11: organizaciones simuladas con pares normales y de colusión para medir el modelo sin datos reales.
 * Los normales incluyen compañeros de viaje habituales (mismo par todos los días, fracciones altas), que es lo que
 * hace el problema difícil: un modelo que marque a todo par frecuente falla esta evaluación.
 */
import { aleatorio } from './bosque-aislamiento.js';
import {
  aFila,
  entrenarModelo,
  evaluarPar,
  redondear,
  type CifrasPar,
} from './cifras-par.js';

export type TipoEscenario =
  | 'normal_ocasional'
  | 'normal_habitual'
  | 'par_repetido'
  | 'sin_desplazamiento'
  | 'cuentas_nuevas'
  | 'anillo';

export interface ParSimulado {
  tipo: TipoEscenario;
  fraude: boolean;
  cifras: CifrasPar;
}

export const SEMILLA_VALIDACION = 20261121;

function herramientas(azar: () => number) {
  const entre = (a: number, b: number) => a + azar() * (b - a);
  const entero = (a: number, b: number) => Math.floor(entre(a, b + 1));
  return { entre, entero };
}

export function generarPar(tipo: TipoEscenario, azar: () => number): CifrasPar {
  const { entre, entero } = herramientas(azar);
  // 12 % de los viajes reales son cortos (del campus a una parada cercana): el modelo no debe confundirlos.
  const viajeReal = () => {
    const distancia =
      azar() < 0.12
        ? entre(900, 1800)
        : Math.exp(entre(Math.log(2500), Math.log(16000)));
    return {
      distanciaPromedioM: Math.round(distancia),
      duracionPromedioMin: redondear(
        (distancia / 1000) * entre(1.6, 3.2) + 2,
        1,
      ),
    };
  };
  switch (tipo) {
    case 'normal_ocasional': {
      const v30 = entero(1, 4);
      return {
        viajes7d: Math.min(v30, entero(0, 2)),
        viajes30d: v30,
        ...viajeReal(),
        fraccionConductor: redondear(v30 / entero(6, 40), 2),
        fraccionPasajero: redondear(Math.min(1, v30 / entero(3, 20)), 2),
        fraccionCalificacionesDelPar: redondear(entre(0, 0.25), 2),
        antiguedadMinimaDias: azar() < 0.1 ? entero(3, 30) : entero(30, 600),
        cobrosSinRecarga: azar() < 0.1 ? entero(1, 2) : 0,
        fallidas7d: azar() < 0.05 ? 1 : 0,
      };
    }
    case 'normal_habitual': {
      const v30 = entero(6, 18);
      return {
        viajes7d: Math.min(v30, entero(2, 5)),
        viajes30d: v30,
        ...viajeReal(),
        fraccionConductor: redondear(entre(0.2, 0.6), 2),
        fraccionPasajero: redondear(entre(0.5, 1), 2),
        fraccionCalificacionesDelPar: redondear(entre(0.2, 0.7), 2),
        // Inicio de semestre: compañeros con cuentas nuevas que ya viajan juntos.
        antiguedadMinimaDias: azar() < 0.15 ? entero(3, 20) : entero(20, 600),
        cobrosSinRecarga: azar() < 0.15 ? entero(1, 2) : 0,
        fallidas7d: azar() < 0.05 ? 1 : 0,
      };
    }
    case 'par_repetido': {
      const v30 = entero(16, 40);
      return {
        viajes7d: entero(7, 15),
        viajes30d: v30,
        distanciaPromedioM: entero(1500, 6000),
        duracionPromedioMin: redondear(entre(4, 14), 1),
        fraccionConductor: redondear(entre(0.75, 1), 2),
        fraccionPasajero: redondear(entre(0.8, 1), 2),
        fraccionCalificacionesDelPar: redondear(entre(0.8, 1), 2),
        antiguedadMinimaDias: entero(5, 200),
        cobrosSinRecarga: entero(3, 12),
        fallidas7d: entero(0, 1),
      };
    }
    case 'sin_desplazamiento': {
      const v30 = entero(4, 12);
      return {
        viajes7d: Math.min(v30, entero(2, 6)),
        viajes30d: v30,
        distanciaPromedioM: entero(40, 700),
        duracionPromedioMin: redondear(entre(0.5, 3.5), 1),
        fraccionConductor: redondear(entre(0.4, 1), 2),
        fraccionPasajero: redondear(entre(0.5, 1), 2),
        fraccionCalificacionesDelPar: redondear(entre(0.5, 1), 2),
        antiguedadMinimaDias: entero(5, 300),
        cobrosSinRecarga: entero(1, 6),
        fallidas7d: entero(0, 2),
      };
    }
    case 'cuentas_nuevas': {
      const v30 = entero(4, 10);
      return {
        viajes7d: Math.min(v30, entero(3, 7)),
        viajes30d: v30,
        ...viajeReal(),
        fraccionConductor: redondear(entre(0.85, 1), 2),
        fraccionPasajero: 1,
        fraccionCalificacionesDelPar: 1,
        antiguedadMinimaDias: entero(1, 10),
        cobrosSinRecarga: entero(2, 6),
        fallidas7d: 0,
      };
    }
    case 'anillo': {
      const v30 = entero(4, 10);
      return {
        viajes7d: Math.min(v30, entero(2, 5)),
        viajes30d: v30,
        distanciaPromedioM: entero(800, 5000),
        duracionPromedioMin: redondear(entre(3, 12), 1),
        fraccionConductor: redondear(entre(0.25, 0.5), 2),
        fraccionPasajero: redondear(entre(0.25, 0.5), 2),
        fraccionCalificacionesDelPar: redondear(entre(0.25, 0.5), 2),
        antiguedadMinimaDias: entero(2, 45),
        cobrosSinRecarga: entero(3, 10),
        fallidas7d: entero(0, 1),
      };
    }
  }
}

/** Una organización simulada: 150 pares normales (70 % ocasionales, 30 % habituales) y 20 de colusión. */
export function organizacionSimulada(semilla: number): ParSimulado[] {
  const azar = aleatorio(semilla);
  const pares: ParSimulado[] = [];
  const agregar = (tipo: TipoEscenario, n: number, fraude: boolean) => {
    for (let i = 0; i < n; i++)
      pares.push({ tipo, fraude, cifras: generarPar(tipo, azar) });
  };
  agregar('normal_ocasional', 105, false);
  agregar('normal_habitual', 45, false);
  agregar('par_repetido', 5, true);
  agregar('sin_desplazamiento', 5, true);
  agregar('cuentas_nuevas', 4, true);
  agregar('anillo', 6, true);
  return pares;
}

export interface Validacion {
  auc: number;
  /** Fracción de pares de colusión detectados con a lo sumo 10 % de falsas alarmas. */
  deteccion: number;
  falsasAlarmas: number;
  /** Detección y falsas alarmas con el umbral de alerta del producto (80). */
  deteccionUmbral: number;
  falsasAlarmasUmbral: number;
  roc: { x: number; y: number }[];
  escenarios: number;
  semillas: number;
}

/** Área bajo la curva ROC (Mann-Whitney): probabilidad de que un fraude puntúe más que un normal. */
export function auc(puntajes: { p: number; fraude: boolean }[]): number {
  const f = puntajes.filter((x) => x.fraude).map((x) => x.p);
  const n = puntajes.filter((x) => !x.fraude).map((x) => x.p);
  let suma = 0;
  for (const a of f) for (const b of n) suma += a > b ? 1 : a === b ? 0.5 : 0;
  return suma / (f.length * n.length);
}

/**
 * CA-11: entrena sin etiquetas sobre cada organización simulada (como en producción, el fraude va mezclado) y mide
 * contra las etiquetas. Promedia `semillas` organizaciones distintas.
 */
export function evaluar(
  semilla = SEMILLA_VALIDACION,
  semillas = 5,
  umbral = 80,
): Validacion {
  const todos: { p: number; fraude: boolean }[] = [];
  for (let i = 0; i < semillas; i++) {
    const org = organizacionSimulada(semilla + i);
    const modelo = entrenarModelo(
      org.map((x) => aFila(x.cifras)),
      semilla + i,
    );
    for (const x of org)
      todos.push({
        p: evaluarPar(modelo, aFila(x.cifras)).puntaje,
        fraude: x.fraude,
      });
  }
  const fraudes = todos.filter((x) => x.fraude).length;
  const normales = todos.length - fraudes;
  const tasa = (t: number) => ({
    x: todos.filter((v) => !v.fraude && v.p >= t).length / normales,
    y: todos.filter((v) => v.fraude && v.p >= t).length / fraudes,
  });
  const roc = Array.from({ length: 21 }, (_, i) => tasa(100 - i * 5));
  roc.unshift({ x: 0, y: 0 });
  const umbrales = [...new Set(todos.map((v) => v.p))].sort((a, b) => b - a);
  let mejor = { x: 0, y: 0 };
  for (const t of umbrales) {
    const r = tasa(t);
    if (r.x <= 0.1 && r.y > mejor.y) mejor = r;
  }
  const enUmbral = tasa(umbral);
  return {
    auc: redondear(auc(todos), 3),
    deteccion: redondear(mejor.y, 3),
    falsasAlarmas: redondear(mejor.x, 3),
    deteccionUmbral: redondear(enUmbral.y, 3),
    falsasAlarmasUmbral: redondear(enUmbral.x, 3),
    roc: roc.map((r) => ({ x: redondear(r.x, 3), y: redondear(r.y, 3) })),
    escenarios: todos.length,
    semillas,
  };
}
