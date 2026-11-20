import { Injectable, Logger } from '@nestjs/common';

/**
 * PB-10: IA propia (Ollama en Kaggle) alcanzada por el túnel SSH inverso. Habla la API compatible con OpenAI.
 * Sin `IA_LOCAL_URL` no se usa. Devuelve `null` ante cualquier falla para que `IaServicio` pase al respaldo.
 */
@Injectable()
export class IaLocalServicio {
  private readonly logger = new Logger(IaLocalServicio.name);
  private readonly url = process.env.IA_LOCAL_URL?.replace(/\/+$/, '');
  readonly modelo = process.env.IA_LOCAL_MODELO || 'qwen2.5:14b';
  private readonly tiempoLimiteMs =
    Number(process.env.IA_LOCAL_TIEMPO_MS) || 30_000;

  get configurada(): boolean {
    return Boolean(this.url);
  }

  async completarJson(
    sistema: string,
    usuario: string,
  ): Promise<string | null> {
    if (!this.url) return null;
    try {
      const respuesta = await fetch(`${this.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.modelo,
          messages: [
            { role: 'system', content: sistema },
            { role: 'user', content: usuario },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
          max_tokens: 500,
        }),
        signal: AbortSignal.timeout(this.tiempoLimiteMs),
      });
      if (!respuesta.ok) {
        this.logger.warn(`IA local respondió ${respuesta.status}`);
        return null;
      }
      const cuerpo = (await respuesta.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return cuerpo.choices?.[0]?.message?.content || null;
    } catch (error) {
      this.logger.warn(`IA local no disponible: ${(error as Error).name}`);
      return null;
    }
  }
}
