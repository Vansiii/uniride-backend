import { describe, expect, it } from 'vitest';
import {
  aFila,
  CIFRAS,
  entrenarModelo,
  escalarPuntaje,
  estadisticas,
  evaluarPar,
  factores,
  percentil,
  prepararFila,
  riesgoDe,
  type CifrasPar,
} from './cifras-par.js';

const normal = (i: number): CifrasPar => ({
  viajes7d: i % 3,
  viajes30d: 1 + (i % 5),
  distanciaPromedioM: 4000 + (i % 10) * 800,
  duracionPromedioMin: 12 + (i % 7),
  fraccionConductor: 0.1 + (i % 4) * 0.05,
  fraccionPasajero: 0.2 + (i % 5) * 0.1,
  fraccionCalificacionesDelPar: (i % 4) * 0.05,
  antiguedadMinimaDias: 60 + i * 7,
  cobrosSinRecarga: 0,
  fallidas7d: 0,
});

const sospechoso: CifrasPar = {
  viajes7d: 12,
  viajes30d: 30,
  distanciaPromedioM: 150,
  duracionPromedioMin: 1,
  fraccionConductor: 1,
  fraccionPasajero: 1,
  fraccionCalificacionesDelPar: 1,
  antiguedadMinimaDias: 3,
  cobrosSinRecarga: 8,
  fallidas7d: 0,
};

const filas = Array.from({ length: 60 }, (_, i) => aFila(normal(i)));

describe('cifras del par (PB-11 RN-3, RN-5)', () => {
  it('aFila respeta el orden de CIFRAS', () => {
    expect(aFila(sospechoso)).toEqual(CIFRAS.map((c) => sospechoso[c.clave]));
  });

  it('percentil: extremos y mitad', () => {
    const est = estadisticas(filas);
    const i = CIFRAS.findIndex((c) => c.clave === 'distanciaPromedioM');
    expect(percentil(est, i, 0)).toBe(0);
    expect(percentil(est, i, 1e9)).toBe(100);
    expect(percentil(est, i, est.mediana[i])).toBeGreaterThanOrEqual(45);
    expect(percentil(est, i, est.mediana[i])).toBeLessThanOrEqual(55);
  });

  it('un viaje muy largo o una cuenta muy vieja no se ven raros', () => {
    const est = estadisticas(filas);
    const lejos = aFila({
      ...normal(1),
      distanciaPromedioM: 90000,
      antiguedadMinimaDias: 5000,
    });
    const base = aFila(normal(1));
    const m = entrenarModelo(filas, 9);
    // Recortados a la mediana: lo más común de la organización.
    expect(evaluarPar(m, lejos).puntaje).toBeLessThanOrEqual(
      evaluarPar(m, base).puntaje,
    );
    const i = CIFRAS.findIndex((c) => c.clave === 'distanciaPromedioM');
    expect(prepararFila(est, lejos)[i]).toBe(Math.log1p(est.mediana[i]));
    const claves = factores(est, lejos).map((f) => f.cifra);
    expect(claves).not.toContain('distanciaPromedioM');
    expect(claves).not.toContain('antiguedadMinimaDias');
  });

  it('factores: hasta 3, en la dirección sospechosa, con percentil', () => {
    const est = estadisticas(filas);
    const f = factores(est, aFila(sospechoso));
    expect(f).toHaveLength(3);
    for (const x of f) {
      expect(x.percentil).toBeGreaterThanOrEqual(0);
      expect(x.percentil).toBeLessThanOrEqual(100);
      expect(sospechoso[x.cifra]).toBe(x.valor);
    }
  });

  it('el par sospechoso puntúa ≥ 80 y uno normal < 40', () => {
    const m = entrenarModelo(filas, 9);
    expect(evaluarPar(m, aFila(sospechoso)).puntaje).toBeGreaterThanOrEqual(80);
    expect(evaluarPar(m, aFila(normal(10))).puntaje).toBeLessThan(40);
  });

  it('escala y riesgo', () => {
    expect(escalarPuntaje(0.3)).toBe(0);
    expect(escalarPuntaje(0.62)).toBe(80);
    expect(escalarPuntaje(0.9)).toBe(100);
    expect(riesgoDe(39)).toBe('bajo');
    expect(riesgoDe(40)).toBe('medio');
    expect(riesgoDe(70)).toBe('alto');
  });
});
