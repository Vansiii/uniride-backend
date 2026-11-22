import { describe, expect, it } from 'vitest';
import { buscarAnillos, type Arista } from './anillos.js';

const totales = (o: Record<string, number>) => new Map(Object.entries(o));

describe('anillos de colusión (PB-11 CA-4, RN-6)', () => {
  it('detecta un grupo de 4 que solo viaja entre sí', () => {
    const aristas: Arista[] = [
      { a: 'a', b: 'b', viajes: 3 },
      { a: 'b', b: 'c', viajes: 3 },
      { a: 'c', b: 'd', viajes: 3 },
      { a: 'd', b: 'a', viajes: 3 },
    ];
    const r = buscarAnillos(aristas, totales({ a: 6, b: 6, c: 6, d: 6 }));
    expect(r).toHaveLength(1);
    expect(r[0].personas).toEqual(['a', 'b', 'c', 'd']);
    expect(r[0].viajesInternos).toBe(12);
    expect(r[0].proporcion).toBe(1);
    expect(r[0].aristas).toHaveLength(4);
  });

  it('un par suelto no es anillo (menos de 3 personas)', () => {
    expect(
      buscarAnillos(
        [{ a: 'a', b: 'b', viajes: 20 }],
        totales({ a: 20, b: 20 }),
      ),
    ).toEqual([]);
  });

  it('no alcanza con 79 % de viajes internos', () => {
    const aristas: Arista[] = [
      { a: 'a', b: 'b', viajes: 4 },
      { a: 'b', b: 'c', viajes: 4 },
      { a: 'c', b: 'a', viajes: 4 },
    ];
    // Cada una hizo 8 internos de 10,2 → 78 %.
    expect(
      buscarAnillos(aristas, totales({ a: 10.2, b: 10.2, c: 10.2 })),
    ).toEqual([]);
    expect(
      buscarAnillos(aristas, totales({ a: 10, b: 10, c: 10 })),
    ).toHaveLength(1);
  });

  it('menos de 6 viajes internos no es anillo', () => {
    const aristas: Arista[] = [
      { a: 'a', b: 'b', viajes: 1 },
      { a: 'b', b: 'c', viajes: 2 },
      { a: 'c', b: 'a', viajes: 2 },
    ];
    expect(buscarAnillos(aristas, totales({ a: 3, b: 3, c: 4 }))).toEqual([]);
  });

  it('quita a quien viaja mucho afuera y conserva el núcleo', () => {
    const aristas: Arista[] = [
      { a: 'a', b: 'b', viajes: 4 },
      { a: 'b', b: 'c', viajes: 4 },
      { a: 'c', b: 'a', viajes: 4 },
      { a: 'c', b: 'x', viajes: 1 },
      // x hace 80 viajes en total: la mayoría con gente de afuera.
      { a: 'x', b: 'y', viajes: 30 },
    ];
    const r = buscarAnillos(
      aristas,
      totales({ a: 8, b: 8, c: 9, x: 80, y: 30 }),
    );
    expect(r.map((g) => g.personas)).toEqual([['a', 'b', 'c']]);
  });

  it('una persona conectada a todos pero con pocos viajes internos rompe el grupo', () => {
    // Estrella: el centro solo hace 50 % de sus viajes con ellos.
    const aristas: Arista[] = ['b', 'c', 'd'].map((p) => ({
      a: 'a',
      b: p,
      viajes: 3,
    }));
    expect(
      buscarAnillos(aristas, totales({ a: 18, b: 3, c: 3, d: 3 })),
    ).toEqual([]);
  });

  it('una organización que viaja mezclada no es un anillo aunque sea un solo grupo conexo', () => {
    // 10 personas, un viaje con cada una de las otras: nadie tiene un compañero frecuente (1 de 9 = 11 %).
    const ids = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const aristas: Arista[] = [];
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++)
        aristas.push({ a: ids[i], b: ids[j], viajes: 1 });
    expect(
      buscarAnillos(
        aristas,
        totales(Object.fromEntries(ids.map((p) => [p, 9]))),
      ),
    ).toEqual([]);
  });

  it('un auto compartido habitual (conductor con pasajeros fijos) no es anillo', () => {
    const aristas: Arista[] = ['p1', 'p2', 'p3'].map((p) => ({
      a: 'c',
      b: p,
      viajes: 10,
    }));
    expect(
      buscarAnillos(aristas, totales({ c: 30, p1: 10, p2: 10, p3: 10 })),
    ).toEqual([]);
  });

  it('el anillo se encuentra aunque la organización tenga mucho tráfico normal alrededor', () => {
    const aristas: Arista[] = [
      { a: 'r1', b: 'r2', viajes: 3 },
      { a: 'r2', b: 'r3', viajes: 3 },
      { a: 'r3', b: 'r1', viajes: 3 },
    ];
    const ids = Array.from({ length: 8 }, (_, i) => `n${i}`);
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++)
        aristas.push({ a: ids[i], b: ids[j], viajes: 1 });
    const r = buscarAnillos(
      aristas,
      totales({
        r1: 6,
        r2: 6,
        r3: 6,
        ...Object.fromEntries(ids.map((p) => [p, 7])),
      }),
    );
    expect(r.map((g) => g.personas)).toEqual([['r1', 'r2', 'r3']]);
  });
});
