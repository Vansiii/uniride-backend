import { createHmac } from 'node:crypto';

/** Mayúsculas y solo letras y números: `1234567-1a`, `1234567 1A` y `12345671A` son el mismo carnet. */
export const normalizarDocumento = (numero: string): string =>
  numero
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');

export const secretoIdentidad = (): string => {
  const secreto = process.env.IDENTIDAD_SECRETO;
  if (!secreto) throw new Error('IDENTIDAD_SECRETO no está configurado');
  return secreto;
};

/** HMAC-SHA256 con clave del servidor (A-02): permite la unicidad global sin guardar el número de carnet. */
export const hashDocumento = (numero: string): string =>
  createHmac('sha256', secretoIdentidad())
    .update(normalizarDocumento(numero))
    .digest('hex');
