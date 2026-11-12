import { RequestMethod, type CanActivate, type Type } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import {
  ACCION_SENSIBLE,
  FirmaDispositivoGuard,
} from '../../src/comun/firma-dispositivo.guard.js';

/**
 * Catálogo de acciones sensibles (HU-29 RN-1): mueven dinero o verifican un viaje y piden la huella del dueño.
 * Las historias que construyen una de estas rutas quedan obligadas por esta prueba en cuanto la registran.
 */
export const CATALOGO: Record<string, string> = {
  'POST /api/v1/billetera': 'billetera.crear', // HU-12
  'POST /api/v1/billetera/recargas/:id/confirmar': 'recarga.confirmar', // HU-13
  'POST /api/v1/viajes': 'viaje.publicar', // HU-17
  'POST /api/v1/viajes/:id/reservas': 'reserva.crear', // HU-19
  'POST /api/v1/viajes/:id/llave-trayecto': 'trayecto.llave', // HU-22
  'POST /api/v1/reservas/:id/abordaje': 'reserva.abordaje', // HU-22
  'POST /api/v1/reservas/:id/bajada': 'reserva.bajada', // HU-23
  // Cancelar (HU-20) y retirar (HU-16) entran aquí al construirse.
};

export interface RutaRegistrada {
  /** `POST /api/v1/billetera/recargas/:id/confirmar` */
  clave: string;
  metodo: string;
  ruta: string;
  accionSensible?: string;
  conFirma: boolean;
}

const unir = (...partes: string[]) =>
  `/${partes.join('/')}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
const comoLista = (valor: unknown) =>
  (Array.isArray(valor) ? valor : [valor ?? '']) as string[];

/** Las rutas que la app expone de verdad, leídas de los metadatos de Nest: una ruta nueva entra sola al catálogo. */
export function rutasRegistradas(app: INestApplication): RutaRegistrada[] {
  const rutas: RutaRegistrada[] = [];
  for (const modulo of app.get(ModulesContainer).values())
    for (const { metatype } of modulo.controllers.values()) {
      if (!metatype) continue;
      const clase = metatype as Type<unknown>;
      const guardsClase: Type<CanActivate>[] =
        Reflect.getMetadata(GUARDS_METADATA, clase) ?? [];
      for (const nombre of Object.getOwnPropertyNames(clase.prototype)) {
        const manejador = (clase.prototype as Record<string, unknown>)[nombre];
        if (typeof manejador !== 'function') continue;
        const ruta = Reflect.getMetadata(PATH_METADATA, manejador);
        if (ruta === undefined) continue;
        const metodo = RequestMethod[
          Reflect.getMetadata(METHOD_METADATA, manejador) as RequestMethod
        ] as string;
        const guards: Type<CanActivate>[] = [
          ...guardsClase,
          ...(Reflect.getMetadata(GUARDS_METADATA, manejador) ?? []),
        ];
        for (const base of comoLista(Reflect.getMetadata(PATH_METADATA, clase)))
          for (const propia of comoLista(ruta)) {
            const completa = unir('api/v1', base, propia);
            rutas.push({
              clave: `${metodo} ${completa}`,
              metodo,
              ruta: completa,
              accionSensible: Reflect.getMetadata(ACCION_SENSIBLE, manejador),
              conFirma: guards.includes(FirmaDispositivoGuard),
            });
          }
      }
    }
  return rutas;
}
