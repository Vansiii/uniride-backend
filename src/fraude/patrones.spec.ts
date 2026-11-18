import { describe, expect, it } from 'vitest';
import {
  DIA_MS,
  HORA_MS,
  ordenarPar,
  p1ViajesRepetidos,
  p2SinDesplazamiento,
  p3VerificacionesFallidas,
} from './patrones.js';

const base = new Date('2026-11-17T08:00:00Z');
const en = (ms: number) => new Date(base.getTime() + ms);

describe('P-1 viajes repetidos (A-10)', () => {
  it('2 viajes en 24 h (ida y vuelta) no es anomalía', () => {
    expect(p1ViajesRepetidos([base, en(10 * HORA_MS)], base)).toBe(false);
  });
  it('3 viajes en menos de 24 h es anomalía', () => {
    const s = [base, en(8 * HORA_MS), en(16 * HORA_MS)];
    expect(p1ViajesRepetidos(s, s[2])).toBe(true);
    // pagados en otro orden: la que se evalúa es la del medio
    expect(p1ViajesRepetidos(s, s[1])).toBe(true);
  });
  it('borde: 3 salidas separadas por exactamente 24 h no cuentan; 23:59 sí', () => {
    expect(p1ViajesRepetidos([base, en(12 * HORA_MS), en(DIA_MS)], base)).toBe(
      false,
    );
    expect(
      p1ViajesRepetidos([base, en(12 * HORA_MS), en(DIA_MS - 60_000)], base),
    ).toBe(true);
  });
  it('un tercer viaje lejano no se suma a los dos primeros', () => {
    const s = [base, en(HORA_MS), en(2 * DIA_MS)];
    expect(p1ViajesRepetidos(s, s[2])).toBe(false);
  });
});

describe('P-2 viaje sin desplazamiento (A-10)', () => {
  it('999 m es anomalía y 1000 m no', () => {
    expect(p2SinDesplazamiento(999, 600_000)).toEqual({
      distanciaM: 999,
      minutos: 10,
    });
    expect(p2SinDesplazamiento(1000, 600_000)).toBeNull();
  });
  it('2:59 es anomalía y 3:00 no', () => {
    expect(p2SinDesplazamiento(5000, 179_000)).not.toBeNull();
    expect(p2SinDesplazamiento(5000, 180_000)).toBeNull();
  });
  it('las cifras no llevan coordenadas', () => {
    expect(Object.keys(p2SinDesplazamiento(10, 1000)!).sort()).toEqual([
      'distanciaM',
      'minutos',
    ]);
  });
});

describe('P-3 verificaciones fallidas repetidas (A-07)', () => {
  const ahora = base;
  const hace = (ms: number) => new Date(ahora.getTime() - ms);
  it('2 no es anomalía; 3 sí, con su cantidad', () => {
    expect(p3VerificacionesFallidas([hace(1), hace(2)], ahora)).toBe(0);
    expect(p3VerificacionesFallidas([hace(1), hace(2), hace(3)], ahora)).toBe(
      3,
    );
  });
  it('borde de 7 días: una de hace exactamente 7 días ya no cuenta', () => {
    expect(
      p3VerificacionesFallidas([hace(1), hace(2), hace(7 * DIA_MS)], ahora),
    ).toBe(0);
    expect(
      p3VerificacionesFallidas([hace(1), hace(2), hace(7 * DIA_MS - 1)], ahora),
    ).toBe(3);
  });
});

describe('ordenarPar', () => {
  it('es el mismo par en cualquier orden', () => {
    expect(ordenarPar('b', 'a')).toEqual(['a', 'b']);
    expect(ordenarPar('a', 'b')).toEqual(['a', 'b']);
  });
});
