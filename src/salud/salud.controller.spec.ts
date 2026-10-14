import { SaludController } from './salud.controller.js';

describe('SaludController', () => {
  it('responde estado ok', () => {
    expect(new SaludController().consultar()).toEqual({ estado: 'ok' });
  });
});
