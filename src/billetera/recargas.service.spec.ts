import { montoDeRecarga } from './recargas.service.js';

describe('montoDeRecarga', () => {
  it.each([
    [10, '10.00'],
    [500, '500.00'],
    [12.35, '12.35'],
    [19.9, '19.90'],
  ])('%d es válido: %s', (monto, esperado) => {
    expect(montoDeRecarga(monto)).toBe(esperado);
  });

  it.each([9.99, 500.01, 0, -5, 1000])('%d está fuera de rango', (monto) => {
    expect(() => montoDeRecarga(monto)).toThrow(
      expect.objectContaining({ codigo: 'MONTO_FUERA_DE_RANGO', status: 400 }),
    );
  });

  it.each([50.001, 10.999, 1e-7, 1e21, NaN, Infinity])(
    '%d no se redondea: se rechaza',
    (monto) => {
      expect(() => montoDeRecarga(monto)).toThrow(
        expect.objectContaining({ codigo: 'MONTO_INVALIDO', status: 400 }),
      );
    },
  );
});
