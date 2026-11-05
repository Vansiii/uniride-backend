import { Logger } from '@nestjs/common';
import {
  playintegrity,
  type playintegrity_v1,
} from '@googleapis/playintegrity';
import { GoogleAuth } from 'google-auth-library';
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
 * `PlayIntegrityReal` en todo entorno y `PlayIntegritySimulado` solo con `MODO_EMULADOR_DEV=true` fuera de producción.
 */
export abstract class PlayIntegrityService {
  /** `desafio` es el nonce que la app pidió a Play Integrity; lanza 503 si el servicio externo falla. */
  abstract verificar(
    tokenIntegridad: string,
    desafio: string,
  ): Promise<ResultadoIntegridad>;
}

const servicioNoDisponible = () =>
  new ErrorNegocio(
    503,
    'SERVICIO_NO_DISPONIBLE',
    'dispositivo.vinculacion.servicio_no_disponible',
  );

type Payload = playintegrity_v1.Schema$TokenPayloadExternal;
type Decodificador = (token: string) => Promise<Payload>;

/** Los tokens de Play Integrity se piden justo antes de usarlos; pasado esto se consideran vencidos. */
const VIDA_MAXIMA_TOKEN_MS = 10 * 60 * 1000;

function decodificarConGoogle(paquete: string): Decodificador {
  const api = playintegrity('v1');
  // Credenciales de la cuenta de servicio: GOOGLE_APPLICATION_CREDENTIALS (nunca en el código).
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/playintegrity'],
  });
  return async (token) => {
    const { data } = await api.v1.decodeIntegrityToken({
      packageName: paquete,
      requestBody: { integrityToken: token },
      auth,
    });
    return data.tokenPayloadExternal ?? {};
  };
}

/** Google responde 4xx cuando el token está mal formado o no lo emitió Play: es un rechazo, no una caída. */
function esRechazoDeGoogle(error: unknown): boolean {
  const { status, response } = error as {
    status?: number;
    response?: { status?: number };
  };
  const codigo = status ?? response?.status;
  return codigo === 400;
}

export class PlayIntegrityReal extends PlayIntegrityService {
  private readonly registro = new Logger(PlayIntegrityReal.name);

  constructor(
    private readonly paquete: string,
    private readonly decodificar: Decodificador = decodificarConGoogle(paquete),
  ) {
    super();
  }

  async verificar(
    tokenIntegridad: string,
    desafio: string,
  ): Promise<ResultadoIntegridad> {
    // Sin paquete configurado no se puede atestar: falla cerrado, nunca aprueba.
    if (!this.paquete) {
      this.registro.error('PLAY_INTEGRITY_PAQUETE no está configurado');
      throw servicioNoDisponible();
    }
    let p: Payload;
    try {
      p = await this.decodificar(tokenIntegridad);
    } catch (error) {
      if (esRechazoDeGoogle(error)) return rechazo('token_invalido');
      this.registro.error(
        `Play Integrity no disponible: ${error instanceof Error ? error.message : 'error'}`,
      );
      throw servicioNoDisponible();
    }
    const veredictos = p.deviceIntegrity?.deviceRecognitionVerdict ?? [];
    const marca = Number(p.requestDetails?.timestampMillis);
    const motivo =
      p.requestDetails?.requestPackageName !== this.paquete ||
      p.appIntegrity?.packageName !== this.paquete
        ? 'paquete'
        : p.appIntegrity?.appRecognitionVerdict !== 'PLAY_RECOGNIZED'
          ? 'app_no_reconocida'
          : !veredictos.includes('MEETS_DEVICE_INTEGRITY')
            ? 'dispositivo_no_integro'
            : p.requestDetails?.nonce !== desafio
              ? 'nonce'
              : !Number.isFinite(marca) ||
                  Math.abs(Date.now() - marca) > VIDA_MAXIMA_TOKEN_MS
                ? 'token_vencido'
                : undefined;
    return motivo
      ? rechazo(motivo)
      : { integro: true, veredicto: 'MEETS_DEVICE_INTEGRITY' };
  }
}

const rechazo = (motivo: string): ResultadoIntegridad => ({
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

/**
 * Elige la implementación al arrancar. `MODO_EMULADOR_DEV` es el único bypass (AGENTS.md §6):
 * desactivado por defecto y, con `NODE_ENV=production`, el arranque falla.
 */
export function crearPlayIntegrity(
  env: NodeJS.ProcessEnv = process.env,
): PlayIntegrityService {
  const emulador =
    (env.MODO_EMULADOR_DEV ?? '').trim().toLowerCase() === 'true';
  if (emulador) {
    if (env.NODE_ENV === 'production')
      throw new Error(
        'MODO_EMULADOR_DEV=true está prohibido en producción: la atestación de integridad no puede simularse.',
      );
    return new PlayIntegritySimulado();
  }
  return new PlayIntegrityReal(env.PLAY_INTEGRITY_PAQUETE ?? '');
}
