import { Logger } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { CorreoRenderizado } from './plantillas.js';

export interface Enviador {
  enviar(destinatario: string, correo: CorreoRenderizado): Promise<void>;
}

/** Desarrollo: escribe el correo en el log. Prohibido en producción. */
class EnviadorConsola implements Enviador {
  private readonly registro = new Logger('Correo');
  async enviar(destinatario: string, c: CorreoRenderizado): Promise<void> {
    this.registro.log(`Para ${destinatario} · ${c.asunto}\n${c.texto}`);
  }
}

class EnviadorSes implements Enviador {
  private readonly cliente = new SESv2Client({
    region: process.env.AWS_REGION,
  });
  async enviar(destinatario: string, c: CorreoRenderizado): Promise<void> {
    await this.cliente.send(
      new SendEmailCommand({
        FromEmailAddress: process.env.SES_REMITENTE,
        Destination: { ToAddresses: [destinatario] },
        Content: {
          Simple: {
            Subject: { Data: c.asunto, Charset: 'UTF-8' },
            Body: { Text: { Data: c.texto, Charset: 'UTF-8' } },
          },
        },
      }),
    );
  }
}

/** Brevo (API HTTP v3): sin sandbox, basta con un remitente verificado. */
export class EnviadorBrevo implements Enviador {
  constructor(
    private readonly claveApi: string,
    private readonly remitente: { email: string; name: string },
    private readonly llamar: typeof fetch = fetch,
  ) {}
  async enviar(destinatario: string, c: CorreoRenderizado): Promise<void> {
    const r = await this.llamar('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': this.claveApi, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: this.remitente,
        to: [{ email: destinatario }],
        subject: c.asunto,
        textContent: c.texto,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    // Nunca se registra la respuesta completa: solo el código.
    if (!r.ok) throw new Error(`Brevo respondió ${r.status}`);
  }
}

export function crearEnviador(): Enviador {
  const modo = process.env.CORREO_MODO ?? 'consola';
  if (modo === 'ses') return new EnviadorSes();
  if (modo === 'brevo') {
    const { BREVO_API_KEY: clave, BREVO_SENDER_EMAIL: email } = process.env;
    if (!clave || !email)
      throw new Error('BREVO_API_KEY y BREVO_SENDER_EMAIL son obligatorias');
    return new EnviadorBrevo(clave, {
      email,
      name: process.env.BREVO_SENDER_NAME ?? 'UniRide',
    });
  }
  if (modo === 'consola' && process.env.NODE_ENV !== 'production')
    return new EnviadorConsola();
  throw new Error(`CORREO_MODO inválido o prohibido en este entorno: ${modo}`);
}
