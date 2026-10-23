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

export function crearEnviador(): Enviador {
  const modo = process.env.CORREO_MODO ?? 'consola';
  if (modo === 'ses') return new EnviadorSes();
  if (modo === 'consola' && process.env.NODE_ENV !== 'production')
    return new EnviadorConsola();
  throw new Error(`CORREO_MODO inválido o prohibido en este entorno: ${modo}`);
}
