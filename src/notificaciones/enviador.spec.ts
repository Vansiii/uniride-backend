import { describe, expect, it, vi } from 'vitest';
import { EnviadorBrevo, crearEnviador } from './enviador.js';

const correo = { asunto: 'Código', texto: 'Tu código es 123456' } as never;

describe('EnviadorBrevo', () => {
  it('envía el correo a la API de Brevo con la clave en la cabecera', async () => {
    const llamar = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    await new EnviadorBrevo(
      'clave',
      { email: 'a@b.com', name: 'UniRide' },
      llamar,
    ).enviar('x@y.com', correo);
    const [url, op] = llamar.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(op.headers['api-key']).toBe('clave');
    expect(JSON.parse(op.body)).toMatchObject({
      to: [{ email: 'x@y.com' }],
      subject: 'Código',
      textContent: 'Tu código es 123456',
    });
  });

  it('lanza sin filtrar la respuesta si Brevo rechaza', async () => {
    const llamar = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    await expect(
      new EnviadorBrevo(
        'clave',
        { email: 'a@b.com', name: 'U' },
        llamar,
      ).enviar('x@y.com', correo),
    ).rejects.toThrow('Brevo respondió 401');
  });

  it('crearEnviador falla sin la clave', () => {
    const antes = { ...process.env };
    process.env.CORREO_MODO = 'brevo';
    delete process.env.BREVO_API_KEY;
    expect(() => crearEnviador()).toThrow('BREVO_API_KEY');
    process.env = antes;
  });
});
