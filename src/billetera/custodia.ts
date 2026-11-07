import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITMO = 'aes-256-gcm';
const BYTES_IV = 12;

/** Clave de custodia (A-12). Sus errores nunca incluyen el valor recibido. */
export function claveCustodia(): Buffer {
  const hex = process.env.WALLET_ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex))
    throw new Error(
      'WALLET_ENCRYPTION_KEY debe tener 32 bytes en hexadecimal (64 caracteres)',
    );
  return Buffer.from(hex, 'hex');
}

/**
 * `<iv>.<etiqueta>.<texto cifrado>` en Base64. La dirección va como dato autenticado: un
 * `llave_custodia_ref` copiado a la fila de otra billetera no se puede descifrar.
 */
export function cifrarLlave(llavePrivada: string, direccion: string): string {
  const iv = randomBytes(BYTES_IV);
  const cifrador = createCipheriv(ALGORITMO, claveCustodia(), iv);
  cifrador.setAAD(Buffer.from(direccion));
  const texto = Buffer.concat([
    cifrador.update(llavePrivada, 'utf8'),
    cifrador.final(),
  ]);
  return [iv, cifrador.getAuthTag(), texto]
    .map((parte) => parte.toString('base64'))
    .join('.');
}

export function descifrarLlave(referencia: string, direccion: string): string {
  const [iv, etiqueta, texto] = referencia
    .split('.')
    .map((parte) => Buffer.from(parte, 'base64'));
  const descifrador = createDecipheriv(ALGORITMO, claveCustodia(), iv);
  descifrador.setAAD(Buffer.from(direccion));
  descifrador.setAuthTag(etiqueta);
  return Buffer.concat([
    descifrador.update(texto),
    descifrador.final(),
  ]).toString('utf8');
}
