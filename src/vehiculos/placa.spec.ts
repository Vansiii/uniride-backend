import { esPlacaValida, normalizarPlaca } from './placa.js';

describe('placa', () => {
  it('CA-3: mayúsculas, sin espacios ni guiones', () => {
    expect(normalizarPlaca('1234-abc')).toBe('1234ABC');
    expect(normalizarPlaca(' 123 a-b c ')).toBe('123ABC');
    expect(normalizarPlaca('1234\tABC')).toBe('1234ABC');
    expect(normalizarPlaca('1234ABC')).toBe('1234ABC');
  });

  it('RN-2: 3 o 4 dígitos seguidos de 3 letras', () => {
    for (const valida of ['123ABC', '1234ABC', '0001ZZZ'])
      expect(esPlacaValida(valida)).toBe(true);
    for (const invalida of [
      '12ABC',
      '12345ABC',
      '1234AB',
      '1234ABCD',
      'ABC1234',
      '1234abc',
      '1234ÑAB',
      '1234.ABC',
      '1234 ABC',
      '',
    ])
      expect(esPlacaValida(invalida)).toBe(false);
  });

  it('CA-3 y RN-1: escrituras distintas de la misma placa dan la misma forma', () => {
    const formas = ['1234-abc', '1234 ABC', '1234abc', ' 1234-ABC '].map(
      normalizarPlaca,
    );
    expect(new Set(formas)).toEqual(new Set(['1234ABC']));
    expect(formas.every(esPlacaValida)).toBe(true);
  });
});
