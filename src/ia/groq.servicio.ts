import { Injectable, Logger } from '@nestjs/common';
import Groq from 'groq-sdk';

@Injectable()
export class GroqServicio {
  private readonly logger = new Logger(GroqServicio.name);
  private cliente: Groq | null = null;
  readonly modelo = process.env.GROQ_MODELO || 'qwen/qwen3.8-27b';
  private readonly tiempoLimiteMs = 2500;

  constructor() {
    const apiKey = process.env.GROQ_API_KEY;
    if (apiKey) {
      this.cliente = new Groq({ apiKey });
    } else {
      this.logger.warn(
        'GROQ_API_KEY no configurada. El asistente operará con fallback determinístico local.',
      );
    }
  }

  /**
   * Envía una consulta a Groq solicitando respuesta en formato JSON estricto.
   * Si excede 2,5 s o falla, retorna null para activar el fallback local.
   */
  async completarJson(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string | null> {
    if (!this.cliente) {
      return null;
    }

    const controlador = new AbortController();
    const temporizador = setTimeout(
      () => controlador.abort(),
      this.tiempoLimiteMs,
    );

    try {
      const respuesta = await this.cliente.chat.completions.create(
        {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          model: this.modelo,
          response_format: { type: 'json_object' },
          temperature: 0.2,
          max_completion_tokens: 500,
        },
        { signal: controlador.signal },
      );

      clearTimeout(temporizador);
      return respuesta.choices[0]?.message?.content || null;
    } catch (error: any) {
      clearTimeout(temporizador);
      if (error?.name === 'AbortError') {
        this.logger.warn(
          `Groq excedió el límite de ${this.tiempoLimiteMs} ms. Activando fallback local.`,
        );
      } else {
        this.logger.warn(
          `Error al consultar Groq: ${error?.message || error}. Activando fallback local.`,
        );
      }
      return null;
    }
  }
}
