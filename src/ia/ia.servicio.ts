import { Injectable } from '@nestjs/common';
import { GroqServicio } from './groq.servicio.js';
import { IaLocalServicio } from './ia-local.servicio.js';

export type ProveedorIa = 'local' | 'groq';

export interface RespuestaIa {
  json: string;
  proveedor: ProveedorIa;
  modelo: string;
}

/** PB-10 RN-3: tras una falla de la IA local, se salta durante este tiempo. */
export const SALTO_LOCAL_MS = 60_000;

/** PB-10 RN-2: IA propia → Groq → `null`. */
@Injectable()
export class IaServicio {
  private localCaidaHasta = 0;

  constructor(
    private readonly local: IaLocalServicio,
    private readonly groq: GroqServicio,
  ) {}

  async completarJson(
    sistema: string,
    usuario: string,
    ahora: number = Date.now(),
  ): Promise<RespuestaIa | null> {
    if (this.local.configurada && ahora >= this.localCaidaHasta) {
      const json = await this.local.completarJson(sistema, usuario);
      if (json) return { json, proveedor: 'local', modelo: this.local.modelo };
      this.localCaidaHasta = ahora + SALTO_LOCAL_MS;
    }
    const json = await this.groq.completarJson(sistema, usuario);
    return json ? { json, proveedor: 'groq', modelo: this.groq.modelo } : null;
  }
}
