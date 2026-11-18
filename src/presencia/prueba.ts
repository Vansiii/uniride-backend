import { keccak256, toUtf8Bytes } from 'ethers';

export interface DatosPruebaPresencia {
  reservaId: string;
  /** `hash_prueba` de las pruebas aceptadas de abordaje y bajada (HU-22, HU-23). */
  hashAbordaje: string;
  hashBajada: string;
  /** `reservas.evaluacion` tal como se guardó. */
  evaluacion: Record<string, unknown>;
}

/**
 * HU-24 RN-4, CA-2: el `bytes32` que `liberar` guarda en el escrow. Las llaves van ordenadas porque `jsonb` las
 * reordena al guardar `evaluacion`: así el hash calculado en la bajada es el mismo que se recalcula desde la BD.
 */
export function hashPruebaPresencia(datos: DatosPruebaPresencia): string {
  return keccak256(toUtf8Bytes(jsonOrdenado(datos)));
}

function jsonOrdenado(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(jsonOrdenado).join(',')}]`;
  if (valor && typeof valor === 'object')
    return `{${Object.keys(valor)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${jsonOrdenado((valor as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  return JSON.stringify(valor);
}
