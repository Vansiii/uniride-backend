import { PlayIntegritySimulado } from './play-integrity.service.js';

describe('PlayIntegritySimulado', () => {
  const simulado = new PlayIntegritySimulado();

  it('aprueba solo simulado:integro', async () => {
    await expect(simulado.verificar('simulado:integro')).resolves.toMatchObject(
      {
        integro: true,
      },
    );
  });

  it('A-03: emulador, root o cualquier otro valor se rechaza como no íntegro', async () => {
    for (const token of ['simulado:emulador', 'simulado:root', '', 'otro']) {
      await expect(simulado.verificar(token)).resolves.toMatchObject({
        integro: false,
      });
    }
  });

  it('simulado:caido simula la caída del servicio (503)', async () => {
    await expect(simulado.verificar('simulado:caido')).rejects.toMatchObject({
      codigo: 'SERVICIO_NO_DISPONIBLE',
    });
  });
});
