import { describe, expect, it } from 'vitest';
import { aFila, entrenarModelo, evaluarPar } from './cifras-par.js';
import {
  auc,
  evaluar,
  organizacionSimulada,
  SEMILLA_VALIDACION,
} from './escenarios.js';

describe('CA-11 validación del modelo con escenarios simulados', () => {
  const v = evaluar();

  it('área bajo la curva ROC ≥ 0,85', () => {
    expect(v.auc).toBeGreaterThanOrEqual(0.85);
  });

  it('detecta ≥ 80 % de la colusión con ≤ 10 % de falsas alarmas', () => {
    expect(v.falsasAlarmas).toBeLessThanOrEqual(0.1);
    expect(v.deteccion).toBeGreaterThanOrEqual(0.8);
  });

  it('con el umbral del producto (80) casi no hay falsas alarmas', () => {
    expect(v.falsasAlarmasUmbral).toBeLessThanOrEqual(0.05);
    expect(v.deteccionUmbral).toBeGreaterThan(0);
  });

  it('la curva ROC va de (0,0) a (1,1) y no decrece', () => {
    expect(v.roc[0]).toEqual({ x: 0, y: 0 });
    expect(v.roc.at(-1)).toEqual({ x: 1, y: 1 });
    for (let i = 1; i < v.roc.length; i++) {
      expect(v.roc[i].x).toBeGreaterThanOrEqual(v.roc[i - 1].x);
      expect(v.roc[i].y).toBeGreaterThanOrEqual(v.roc[i - 1].y);
    }
  });

  it('cada tipo de colusión puntúa más que los compañeros habituales', () => {
    const org = organizacionSimulada(SEMILLA_VALIDACION);
    const m = entrenarModelo(
      org.map((x) => aFila(x.cifras)),
      SEMILLA_VALIDACION,
    );
    const mediana = (tipo: string) => {
      const l = org
        .filter((x) => x.tipo === tipo)
        .map((x) => evaluarPar(m, aFila(x.cifras)).puntaje)
        .sort((a, b) => a - b);
      return l[l.length >> 1];
    };
    const habitual = mediana('normal_habitual');
    for (const t of [
      'par_repetido',
      'sin_desplazamiento',
      'cuentas_nuevas',
      'anillo',
    ])
      expect(mediana(t), t).toBeGreaterThan(habitual);
  });

  it('es reproducible: la misma semilla da la misma validación', () => {
    expect(evaluar()).toEqual(v);
  });
});

describe('auc', () => {
  it('1 si todo fraude puntúa más, 0,5 si empatan', () => {
    expect(
      auc([
        { p: 90, fraude: true },
        { p: 10, fraude: false },
      ]),
    ).toBe(1);
    expect(
      auc([
        { p: 50, fraude: true },
        { p: 50, fraude: false },
      ]),
    ).toBe(0.5);
  });
});
