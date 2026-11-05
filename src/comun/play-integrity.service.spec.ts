import { ErrorNegocio } from './error-negocio.js';
import {
  crearPlayIntegrity,
  PlayIntegrityReal,
  PlayIntegritySimulado,
} from './play-integrity.service.js';

const PAQUETE = 'bo.edu.uniride';
const DESAFIO = 'desafio-de-prueba';

const payload = (cambios: Record<string, unknown> = {}) => ({
  requestDetails: {
    requestPackageName: PAQUETE,
    nonce: DESAFIO,
    timestampMillis: String(Date.now()),
  },
  appIntegrity: {
    packageName: PAQUETE,
    appRecognitionVerdict: 'PLAY_RECOGNIZED',
  },
  deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
  ...cambios,
});
const real = (resultado: unknown) =>
  new PlayIntegrityReal(PAQUETE, () =>
    typeof resultado === 'function'
      ? (resultado as () => Promise<never>)()
      : Promise.resolve(resultado as never),
  );

describe('crearPlayIntegrity', () => {
  it('por defecto usa la implementación real', () => {
    expect(crearPlayIntegrity({})).toBeInstanceOf(PlayIntegrityReal);
    expect(crearPlayIntegrity({ MODO_EMULADOR_DEV: 'false' })).toBeInstanceOf(
      PlayIntegrityReal,
    );
  });

  it('MODO_EMULADOR_DEV=true fuera de producción usa la simulada', () => {
    expect(
      crearPlayIntegrity({
        MODO_EMULADOR_DEV: 'true',
        NODE_ENV: 'development',
      }),
    ).toBeInstanceOf(PlayIntegritySimulado);
  });

  it('A-03: MODO_EMULADOR_DEV=true con NODE_ENV=production hace fallar el arranque', () => {
    for (const valor of ['true', 'TRUE', ' true ']) {
      expect(() =>
        crearPlayIntegrity({
          MODO_EMULADOR_DEV: valor,
          NODE_ENV: 'production',
        }),
      ).toThrow(/prohibido en producción/);
    }
  });

  it('en producción con el bypass apagado arranca con la real', () => {
    expect(
      crearPlayIntegrity({
        NODE_ENV: 'production',
        PLAY_INTEGRITY_PAQUETE: 'x',
      }),
    ).toBeInstanceOf(PlayIntegrityReal);
  });
});

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

describe('PlayIntegrityReal', () => {
  it('aprueba un veredicto íntegro, de la app y del desafío', async () => {
    await expect(real(payload()).verificar('t', DESAFIO)).resolves.toEqual({
      integro: true,
      veredicto: 'MEETS_DEVICE_INTEGRITY',
    });
  });

  const rechazos: [string, Record<string, unknown>][] = [
    [
      'dispositivo_no_integro',
      { deviceIntegrity: { deviceRecognitionVerdict: [] } },
    ],
    [
      'dispositivo_no_integro',
      {
        deviceIntegrity: {
          deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY'],
        },
      },
    ],
    [
      'app_no_reconocida',
      {
        appIntegrity: {
          packageName: PAQUETE,
          appRecognitionVerdict: 'UNRECOGNIZED_VERSION',
        },
      },
    ],
    [
      'paquete',
      {
        appIntegrity: {
          packageName: 'com.falso',
          appRecognitionVerdict: 'PLAY_RECOGNIZED',
        },
      },
    ],
    [
      'paquete',
      {
        requestDetails: {
          requestPackageName: 'com.falso',
          nonce: DESAFIO,
          timestampMillis: String(Date.now()),
        },
      },
    ],
    [
      'nonce',
      {
        requestDetails: {
          requestPackageName: PAQUETE,
          nonce: 'otro-desafio',
          timestampMillis: String(Date.now()),
        },
      },
    ],
    [
      'token_vencido',
      {
        requestDetails: {
          requestPackageName: PAQUETE,
          nonce: DESAFIO,
          timestampMillis: String(Date.now() - 11 * 60 * 1000),
        },
      },
    ],
  ];
  it.each(rechazos)('A-03: rechaza por %s', async (motivo, cambios) => {
    await expect(
      real(payload(cambios)).verificar('t', DESAFIO),
    ).resolves.toMatchObject({ integro: false, motivo });
  });

  it('un token que Google rechaza (400) es no íntegro, no una caída', async () => {
    const r = real(() => Promise.reject({ status: 400 }));
    await expect(r.verificar('t', DESAFIO)).resolves.toMatchObject({
      integro: false,
      motivo: 'token_invalido',
    });
  });

  it('si Google falla responde 503 SERVICIO_NO_DISPONIBLE', async () => {
    const r = real(() => Promise.reject(new Error('timeout')));
    const error = await r.verificar('t', DESAFIO).catch((e) => e);
    expect(error).toBeInstanceOf(ErrorNegocio);
    expect(error).toMatchObject({ codigo: 'SERVICIO_NO_DISPONIBLE' });
    expect(error.getStatus()).toBe(503);
  });

  it('sin PLAY_INTEGRITY_PAQUETE falla cerrado con 503 sin llamar a Google', async () => {
    const decodificar = vi.fn();
    const r = new PlayIntegrityReal('', decodificar);
    await expect(r.verificar('t', DESAFIO)).rejects.toMatchObject({
      codigo: 'SERVICIO_NO_DISPONIBLE',
    });
    expect(decodificar).not.toHaveBeenCalled();
  });
});
