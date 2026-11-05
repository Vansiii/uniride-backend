import { randomUUID } from 'node:crypto';
import type { MotorFacial, ResultadoLiveness } from './motor-facial.js';

/**
 * Motor determinista para desarrollo local y emulador (`REKOGNITION_SIMULADO=true`; nunca en producción).
 * No mira píxeles, solo estas convenciones; el estado vive en memoria y se pierde al reiniciar:
 * - Imagen: el rostro es el texto `ROSTRO:<id>` dentro de sus bytes; sin marca, el rostro genérico `generico`
 *   (cualquier foto sirve). `SIN_ROSTRO` o `BORROSA` en los bytes la vuelven ilegible (sin rostro detectable).
 * - Sesión: `sim-<uuid>` (la que entrega `crearSesionLiveness`) es una prueba de vida válida con el rostro
 *   genérico; `sim-<uuid>~<id>` la liga al rostro `<id>`; `~spoof` simula una foto o pantalla (falla);
 *   cualquier otro valor es una sesión desconocida (falla).
 * - Similitud: 98 si ambos rostros tienen el mismo id, 20 si no.
 */
export class MotorFacialSimulado implements MotorFacial {
  /** Visible para las pruebas. */
  readonly indexados = new Map<string, { usuarioId: string; rostro: string }>();

  async crearSesionLiveness(): Promise<string> {
    return `sim-${randomUUID()}`;
  }

  async obtenerResultadoLiveness(sesionId: string): Promise<ResultadoLiveness> {
    const coincide = /^sim-[0-9a-f-]{36}(?:~([A-Za-z0-9_-]{1,40}))?$/.exec(
      sesionId,
    );
    const rostro = coincide?.[1] ?? GENERICO;
    if (!coincide || rostro === 'spoof')
      return { exitosa: false, confianza: 5 };
    return {
      exitosa: true,
      confianza: 99,
      imagenReferencia: Buffer.from(`ROSTRO:${rostro}`),
    };
  }

  async compararRostros(
    referencia: Buffer,
    carnet: Buffer,
  ): Promise<number | null> {
    const delCarnet = rostroDe(carnet);
    if (delCarnet === null) return null;
    return delCarnet === rostroDe(referencia) ? 98 : 20;
  }

  async buscarRostroDuplicado(
    imagen: Buffer,
    usuarioId: string,
  ): Promise<boolean> {
    const rostro = rostroDe(imagen);
    return [...this.indexados.values()].some(
      (i) => i.rostro === rostro && i.usuarioId !== usuarioId,
    );
  }

  async indexarRostro(imagen: Buffer, usuarioId: string): Promise<string> {
    const rostro = rostroDe(imagen);
    if (rostro === null) throw new Error('Imagen sin rostro');
    const faceId = `sim-face-${randomUUID()}`;
    this.indexados.set(faceId, { usuarioId, rostro });
    return faceId;
  }

  async desindexarRostro(faceId: string): Promise<void> {
    this.indexados.delete(faceId);
  }
}

const GENERICO = 'generico';

function rostroDe(imagen: Buffer): string | null {
  const texto = imagen.toString('latin1');
  if (texto.includes('SIN_ROSTRO') || texto.includes('BORROSA')) return null;
  return /ROSTRO:([A-Za-z0-9_-]{1,40})/.exec(texto)?.[1] ?? GENERICO;
}
