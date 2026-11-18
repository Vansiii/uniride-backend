import { co2Kg } from './metricas.sql.js';

describe('co2Kg', () => {
  it('10 km + 5 km = 15 km × 0,12 = 1,8 kg', () => expect(co2Kg(15)).toBe(1.8));
  it('redondea una sola vez al final, a un decimal', () => {
    expect(co2Kg(10.4 + 5.4)).toBe(1.9);
    expect(co2Kg(0)).toBe(0);
  });
});
