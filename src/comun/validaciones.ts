import { Transform } from 'class-transformer';

/** Quita los espacios de los extremos y el carácter NUL, que PostgreSQL no guarda en un texto, antes de validar. */
export const recortar = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? value.replaceAll('\0', '').trim() : value,
  );

/** Al menos 8 caracteres, con una letra y un número (HU-01, HU-05 RN-5); 72 es el límite de bcrypt. */
export const esContrasenaSegura = (contrasena: string) =>
  /^(?=.*[A-Za-z])(?=.*\d).{8,72}$/.test(contrasena);
