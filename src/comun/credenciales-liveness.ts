import { GetFederationTokenCommand, STSClient } from '@aws-sdk/client-sts';

export interface CredencialesLiveness {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** ISO 8601. La app las usa una sola vez, al abrir la cámara. */
  expiracion: string;
  region: string;
}

/** Lo único que el teléfono puede hacer con ellas: abrir el video de la prueba de vida. */
const POLITICA_SOLO_LIVENESS = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Action: 'rekognition:StartFaceLivenessSession',
      Resource: '*',
    },
  ],
});

/**
 * Credenciales temporales (15 min) para que el componente nativo de Face Liveness envíe el video a Rekognition
 * (RN-4). Salen de las credenciales dedicadas de Rekognition con una política de sesión que solo permite
 * `StartFaceLivenessSession`: la llave larga nunca llega al teléfono y el teléfono sigue sin decidir (A-01).
 * Devuelve `null` si no hay credenciales dedicadas: `GetFederationToken` no se puede llamar con las de un rol.
 */
export async function pedirCredencialesLiveness(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredencialesLiveness | null> {
  const accessKeyId = env.AWS_REKOGNITION_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_REKOGNITION_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  const region = env.AWS_REKOGNITION_REGION || env.AWS_REGION || 'us-east-1';

  const sts = new STSClient({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
  const r = await sts.send(
    new GetFederationTokenCommand({
      Name: 'uniride-liveness',
      DurationSeconds: 900,
      Policy: POLITICA_SOLO_LIVENESS,
    }),
  );
  const c = r.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration)
    throw new Error('STS no devolvió credenciales');
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    expiracion: c.Expiration.toISOString(),
    region,
  };
}
