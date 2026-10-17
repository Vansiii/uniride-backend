import textos from './es-BO.json' with { type: 'json' };

/** Devuelve el texto es-BO de la clave; si no existe, la propia clave. */
export function t(clave: string): string {
  return (textos as Record<string, string>)[clave] ?? clave;
}
