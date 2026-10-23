import { t } from '../i18n/t.js';

export interface CorreoRenderizado {
  asunto: string;
  texto: string;
}

const rellenar = (clave: string, datos: Record<string, unknown>) =>
  t(clave).replace(/\{(\w+)\}/g, (_, k) => String(datos[k] ?? ''));

/** Plantillas de correo (RN-10: es-BO). Cada plantilla = claves `<plantilla>.asunto` y `.cuerpo`. */
export function renderizar(
  plantilla: string,
  datos: Record<string, unknown>,
): CorreoRenderizado {
  return {
    asunto: rellenar(`notificaciones.${plantilla}.asunto`, datos),
    texto: rellenar(`notificaciones.${plantilla}.cuerpo`, datos),
  };
}
