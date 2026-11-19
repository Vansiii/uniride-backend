import { GetFederationTokenCommand, STSClient } from '@aws-sdk/client-sts';
import { pedirCredencialesLiveness } from './credenciales-liveness.js';

const ENTORNO = {
  AWS_REKOGNITION_ACCESS_KEY_ID: 'AKIATEST',
  AWS_REKOGNITION_SECRET_ACCESS_KEY: 'secreto-de-prueba',
  AWS_REKOGNITION_REGION: 'us-east-1',
} as NodeJS.ProcessEnv;

afterEach(() => vi.restoreAllMocks());

describe('pedirCredencialesLiveness', () => {
  it('pide un token de 15 min limitado a StartFaceLivenessSession', async () => {
    const vence = new Date('2026-11-19T12:00:00Z');
    const enviar = vi.spyOn(STSClient.prototype, 'send').mockImplementation(
      async () =>
        ({
          Credentials: {
            AccessKeyId: 'ASIA1',
            SecretAccessKey: 's',
            SessionToken: 't',
            Expiration: vence,
          },
        }) as never,
    );

    const c = await pedirCredencialesLiveness(ENTORNO);

    expect(c).toEqual({
      accessKeyId: 'ASIA1',
      secretAccessKey: 's',
      sessionToken: 't',
      expiracion: vence.toISOString(),
      region: 'us-east-1',
    });
    const comando = enviar.mock.calls[0][0] as GetFederationTokenCommand;
    expect(comando).toBeInstanceOf(GetFederationTokenCommand);
    expect(comando.input.DurationSeconds).toBe(900);
    // La política de sesión es lo que impide usar las credenciales para otra cosa (A-01).
    const politica = JSON.parse(comando.input.Policy as string);
    expect(politica.Statement).toHaveLength(1);
    expect(politica.Statement[0].Action).toBe(
      'rekognition:StartFaceLivenessSession',
    );
  });

  it('sin credenciales dedicadas devuelve null y no llama a STS', async () => {
    const enviar = vi.spyOn(STSClient.prototype, 'send');
    await expect(
      pedirCredencialesLiveness({} as NodeJS.ProcessEnv),
    ).resolves.toBeNull();
    expect(enviar).not.toHaveBeenCalled();
  });

  it('una respuesta sin credenciales falla', async () => {
    vi.spyOn(STSClient.prototype, 'send').mockResolvedValue({} as never);
    await expect(pedirCredencialesLiveness(ENTORNO)).rejects.toThrow();
  });
});
