import { Transform } from 'class-transformer';

/** Quita los espacios de los extremos antes de validar. */
export const recortar = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** Al menos 8 caracteres, con una letra y un número (HU-01, HU-05 RN-5); 72 es el límite de bcrypt. */
export const esContrasenaSegura = (contrasena: string) =>
  /^(?=.*[A-Za-z])(?=.*\d).{8,72}$/.test(contrasena);
