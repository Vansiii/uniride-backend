import { Prisma } from '../generated/prisma/client.js';

export const MINUTOS_VENTANA_CANCELACION_PASAJERO = 30;
export const MS_VENTANA_CANCELACION_PASAJERO =
  MINUTOS_VENTANA_CANCELACION_PASAJERO * 60 * 1000;

export interface ResultadoPoliticaCancelacion {
  cancelable: boolean;
  porcentajePasajero: 100 | 50;
  porcentajePasajeroBps: number;
  montoPasajero: Prisma.Decimal;
  montoConductor: Prisma.Decimal;
  motivo?: string;
}

/**
 * RN-1 / RN-2: Cálculo puro de la política de cancelación para el pasajero.
 * Con más de 30 minutos estrictos entre la hora del servidor y la hora de salida → 100 % al pasajero.
 * Con 30 minutos exactos o menos (incluso pasada la salida sin abordar ni expirar) → 50 % al pasajero y 50 % al conductor (D-18).
 * Montos exactos con Prisma.Decimal (el precio es múltiplo de 0,02, RN-7).
 */
export function politicaCancelacion(
  monto: Prisma.Decimal | string | number,
  salida: Date,
  ahora: Date = new Date(),
): ResultadoPoliticaCancelacion {
  const montoDecimal =
    monto instanceof Prisma.Decimal ? monto : new Prisma.Decimal(monto);
  const msDiferencia = salida.getTime() - ahora.getTime();

  // RN-1: estrictamente mayor que 30 minutos
  const porcentajePasajero: 100 | 50 =
    msDiferencia > MS_VENTANA_CANCELACION_PASAJERO ? 100 : 50;
  const porcentajePasajeroBps = porcentajePasajero === 100 ? 10_000 : 5_000;

  if (porcentajePasajero === 100) {
    return {
      cancelable: true,
      porcentajePasajero: 100,
      porcentajePasajeroBps,
      montoPasajero: montoDecimal,
      montoConductor: new Prisma.Decimal(0),
      motivo: 'cancelada_pasajero',
    };
  }

  // 50/50 exacto
  const montoPasajero = montoDecimal.mul(50).div(100);
  const montoConductor = montoDecimal.sub(montoPasajero);

  return {
    cancelable: true,
    porcentajePasajero: 50,
    porcentajePasajeroBps,
    montoPasajero,
    montoConductor,
    motivo: 'cancelada_pasajero',
  };
}

/**
 * Para conductor, expiración y verificación fallida: siempre 100 % al pasajero.
 */
export function politicaCancelacionTotal(
  monto: Prisma.Decimal | string | number,
  motivo:
    | 'cancelada_conductor'
    | 'viaje_cancelado'
    | 'sin_abordaje'
    | 'verificacion_fallida',
): ResultadoPoliticaCancelacion {
  const montoDecimal =
    monto instanceof Prisma.Decimal ? monto : new Prisma.Decimal(monto);
  return {
    cancelable: true,
    porcentajePasajero: 100,
    porcentajePasajeroBps: 10_000,
    montoPasajero: montoDecimal,
    montoConductor: new Prisma.Decimal(0),
    motivo,
  };
}
