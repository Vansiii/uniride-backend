import { createSign } from 'node:crypto';
import { Logger } from '@nestjs/common';

export interface Push {
  titulo: string;
  cuerpo: string;
  /** Pantalla de la app que abre el aviso al tocarlo. */
  ruta?: string;
}

/** El token ya no sirve (app desinstalada o token renovado): no se reintenta. */
export class TokenPushInvalido extends Error {}

export interface EnviadorPush {
  enviar(token: string, push: Push): Promise<void>;
}

/** Desarrollo: escribe el aviso en el log. Prohibido en producción. */
class EnviadorPushConsola implements EnviadorPush {
  private readonly registro = new Logger('Push');
  async enviar(_token: string, p: Push): Promise<void> {
    this.registro.log(`${p.titulo} · ${p.cuerpo} · ${p.ruta ?? ''}`);
  }
}

interface CuentaServicio {
  project_id: string;
  client_email: string;
  private_key: string;
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/**
 * Firebase Cloud Messaging, API HTTP v1. El token OAuth se pide con un JWT firmado con la cuenta de servicio
 * (RS256, `node:crypto`): sin `firebase-admin`. La llave de la cuenta solo vive en la variable de entorno.
 */
export class EnviadorFcm implements EnviadorPush {
  private acceso?: { token: string; vence: number };

  constructor(
    private readonly cuenta: CuentaServicio,
    private readonly llamar: typeof fetch = fetch,
  ) {}

  private async tokenAcceso(): Promise<string> {
    if (this.acceso && this.acceso.vence > Date.now() + 60_000)
      return this.acceso.token;
    const ahora = Math.floor(Date.now() / 1000);
    const cabecera = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const reclamos = b64url(
      JSON.stringify({
        iss: this.cuenta.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: ahora,
        exp: ahora + 3600,
      }),
    );
    const firma = createSign('RSA-SHA256')
      .update(`${cabecera}.${reclamos}`)
      .sign(this.cuenta.private_key);
    const r = await this.llamar('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${cabecera}.${reclamos}.${b64url(firma)}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`OAuth de Google respondió ${r.status}`);
    const { access_token, expires_in } = (await r.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.acceso = {
      token: access_token,
      vence: Date.now() + expires_in * 1000,
    };
    return access_token;
  }

  async enviar(token: string, p: Push): Promise<void> {
    const r = await this.llamar(
      `https://fcm.googleapis.com/v1/projects/${this.cuenta.project_id}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await this.tokenAcceso()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: p.titulo, body: p.cuerpo },
            data: p.ruta ? { ruta: p.ruta } : {},
            android: {
              priority: 'HIGH',
              notification: { channel_id: 'avisos', sound: 'default' },
            },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (r.ok) return;
    // 404 UNREGISTERED o 400 con token mal formado: el token no volverá a servir.
    if (r.status === 404 || r.status === 400)
      throw new TokenPushInvalido(`FCM respondió ${r.status}`);
    // Nunca se registra la respuesta completa: solo el código.
    throw new Error(`FCM respondió ${r.status}`);
  }
}

/** `null` con `PUSH_MODO=apagado`: los avisos quedan en la cola hasta que se configure FCM. */
export function crearEnviadorPush(): EnviadorPush | null {
  // Sin configurar: en producción se apaga (no llena el log cada 5 s); en desarrollo, al log.
  const modo =
    process.env.PUSH_MODO ??
    (process.env.NODE_ENV === 'production' ? 'apagado' : 'consola');
  if (modo === 'apagado') return null;
  if (modo === 'fcm') {
    const b64 = process.env.FCM_CUENTA_SERVICIO_B64;
    if (!b64) throw new Error('FCM_CUENTA_SERVICIO_B64 es obligatoria');
    return new EnviadorFcm(JSON.parse(Buffer.from(b64, 'base64').toString()));
  }
  if (modo === 'consola' && process.env.NODE_ENV !== 'production')
    return new EnviadorPushConsola();
  throw new Error(`PUSH_MODO inválido o prohibido en este entorno: ${modo}`);
}
