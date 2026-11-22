import { describe, expect, it } from 'vitest';
import {
  aleatorio,
  entrenar,
  largoPromedio,
  puntuar,
} from './bosque-aislamiento.js';

const nube = (n: number, semilla: number) => {
  const azar = aleatorio(semilla);
  return Array.from({ length: n }, () => [azar(), azar(), azar()]);
};

describe('Isolation Forest (PB-11 RN-2, RN-4)', () => {
  it('el generador con semilla repite la secuencia', () => {
    const a = aleatorio(7);
    const b = aleatorio(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(aleatorio(8)()).not.toBe(aleatorio(7)());
  });

  it('un punto lejano puntúa más que uno del centro', () => {
    const bosque = entrenar(nube(300, 1), 42);
    const centro = puntuar(bosque, [0.5, 0.5, 0.5]);
    const lejano = puntuar(bosque, [5, 5, 5]);
    expect(lejano).toBeGreaterThan(0.6);
    expect(centro).toBeLessThan(0.5);
    expect(lejano).toBeGreaterThan(centro);
  });

  it('reproducible: misma semilla y filas → mismo puntaje', () => {
    const filas = nube(200, 3);
    const p = (s: number) => puntuar(entrenar(filas, s), [2, 0.1, 0.9]);
    expect(p(11)).toBe(p(11));
  });

  it('el puntaje queda en 0–1 y tolera columnas constantes', () => {
    const filas = nube(50, 5).map((f) => [...f, 1]);
    const bosque = entrenar(filas, 1);
    for (const f of filas) {
      const s = puntuar(bosque, f);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('sin filas no entrena', () => {
    expect(() => entrenar([], 1)).toThrow();
  });

  it('largo promedio conocido', () => {
    expect(largoPromedio(1)).toBe(0);
    expect(largoPromedio(2)).toBe(1);
    expect(largoPromedio(256)).toBeCloseTo(10.24, 1);
  });
});
