import { Logger } from '@nestjs/common';
import { ErrorNegocio } from './error-negocio.js';

export interface ResultadoIntegridad {
  integro: boolean;
  /** Veredicto que se guarda con el dispositivo. */
  veredicto: string;
  /** Solo para auditoría: nunca se devuelve al cliente (anti-oráculo). */
  motivo?: string;
}

/**
 * Atestación de integridad del dispositivo (A-03). Clase abstracta para usarla como token de DI:
 * `AtestacionKeystore` en todo entorno y `PlayIntegritySimulado` solo con `MODO_EMULADOR_DEV=true` fuera de producción.
 */
export abstract class PlayIntegrityService {
  /** `desafio` es el desafío con el que la app pidió la atestación; lanza 503 si el servicio externo falla. */
  abstract verificar(
    tokenIntegridad: string,
    desafio: string,
  ): Promise<ResultadoIntegridad>;
}

export const servicioNoDisponible = () =>
  new ErrorNegocio(
    503,
    'SERVICIO_NO_DISPONIBLE',
    'dispositivo.vinculacion.servicio_no_disponible',
  );

export const rechazo = (motivo: string): ResultadoIntegridad => ({
  integro: false,
  veredicto: 'NO_INTEGRO',
  motivo,
});

/**
 * Solo desarrollo con emulador. Convención determinista del token:
 * `simulado:integro` aprueba; `simulado:caido` simula la caída de Google (503);
 * cualquier otro valor (p. ej. `simulado:emulador`, `simulado:root`) se rechaza como no íntegro.
 */
export class PlayIntegritySimulado extends PlayIntegrityService {
  constructor() {
    super();
    new Logger(PlayIntegritySimulado.name).warn(
      'MODO_EMULADOR_DEV activo: la atestación de integridad es SIMULADA. Nunca en producción.',
    );
  }

  async verificar(tokenIntegridad: string): Promise<ResultadoIntegridad> {
    if (tokenIntegridad === 'simulado:integro')
      return { integro: true, veredicto: 'SIMULADO' };
    if (tokenIntegridad === 'simulado:caido') throw servicioNoDisponible();
    return rechazo('simulado');
  }
}
