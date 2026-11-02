/** RN-2: placas bolivianas actuales, 3 o 4 dígitos seguidos de 3 letras. La misma expresión que el CHECK de la migración 005. */
const PLACA = /^[0-9]{3,4}[A-Z]{3}$/;

/** CA-3: mayúsculas, sin espacios ni guiones (`"1234-abc"` → `"1234ABC"`); la unicidad se compara con esta forma. */
export const normalizarPlaca = (placa: string) =>
  placa.toUpperCase().replace(/[\s-]/g, '');

export const esPlacaValida = (placa: string) => PLACA.test(placa);
