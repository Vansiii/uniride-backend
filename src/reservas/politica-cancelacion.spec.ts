import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import {
  politicaCancelacion,
  politicaCancelacionTotal,
} from './politica-cancelacion.js';

describe('politicaCancelacion (RN-1, RN-2, RN-7)', () => {
  const BASE = new Date('2026-11-15T12:00:00.000Z');

  it('más de 30 min estrictos antes de la salida (30 min + 1 s) devuelve 100 % al pasajero', () => {
    const salida = new Date(BASE.getTime() + 30 * 60 * 1000 + 1000);
    const resultado = politicaCancelacion(
      new Prisma.Decimal('10.00'),
      salida,
      BASE,
    );

    expect(resultado.cancelable).toBe(true);
    expect(resultado.porcentajePasajero).toBe(100);
    expect(resultado.porcentajePasajeroBps).toBe(10_000);
    expect(resultado.montoPasajero.toFixed(2)).toBe('10.00');
    expect(resultado.montoConductor.toFixed(2)).toBe('0.00');
    expect(resultado.motivo).toBe('cancelada_pasajero');
  });

  it('exactamente 30 min antes de la salida devuelve 50 % al pasajero y 50 % al conductor (D-18)', () => {
    const salida = new Date(BASE.getTime() + 30 * 60 * 1000);
    const resultado = politicaCancelacion(
      new Prisma.Decimal('10.00'),
      salida,
      BASE,
    );

    expect(resultado.cancelable).toBe(true);
    expect(resultado.porcentajePasajero).toBe(50);
    expect(resultado.porcentajePasajeroBps).toBe(5_000);
    expect(resultado.montoPasajero.toFixed(2)).toBe('5.00');
    expect(resultado.montoConductor.toFixed(2)).toBe('5.00');
    expect(resultado.motivo).toBe('cancelada_pasajero');
  });

  it('menos de 30 min antes de la salida (29 min 59 s) devuelve 50 % al pasajero y 50 % al conductor', () => {
    const salida = new Date(BASE.getTime() + 29 * 60 * 1000 + 59 * 1000);
    const resultado = politicaCancelacion(
      new Prisma.Decimal('12.00'),
      salida,
      BASE,
    );

    expect(resultado.porcentajePasajero).toBe(50);
    expect(resultado.porcentajePasajeroBps).toBe(5_000);
    expect(resultado.montoPasajero.toFixed(2)).toBe('6.00');
    expect(resultado.montoConductor.toFixed(2)).toBe('6.00');
  });

  it('después de la hora de salida (sin abordar ni expirar) devuelve 50 % al pasajero y 50 % al conductor', () => {
    const salidaPasada = new Date(BASE.getTime() - 5 * 60 * 1000);
    const resultado = politicaCancelacion(
      new Prisma.Decimal('10.00'),
      salidaPasada,
      BASE,
    );

    expect(resultado.porcentajePasajero).toBe(50);
    expect(resultado.porcentajePasajeroBps).toBe(5_000);
    expect(resultado.montoPasajero.toFixed(2)).toBe('5.00');
    expect(resultado.montoConductor.toFixed(2)).toBe('5.00');
  });

  it('montos exactos con múltiplos de 0,02 URC (D-25, RN-7): divide centavos exactos', () => {
    const salida = new Date(BASE.getTime() + 10 * 60 * 1000);
    // Caso 12.02 URC -> 6.01 y 6.01
    const res1 = politicaCancelacion(new Prisma.Decimal('12.02'), salida, BASE);
    expect(res1.montoPasajero.toFixed(2)).toBe('6.01');
    expect(res1.montoConductor.toFixed(2)).toBe('6.01');
    expect(res1.montoPasajero.add(res1.montoConductor).toFixed(2)).toBe(
      '12.02',
    );

    // Caso mínimo: 0.02 URC -> 0.01 y 0.01
    const res2 = politicaCancelacion(new Prisma.Decimal('0.02'), salida, BASE);
    expect(res2.montoPasajero.toFixed(2)).toBe('0.01');
    expect(res2.montoConductor.toFixed(2)).toBe('0.01');
  });

  it('politicaCancelacionTotal: cancelada_conductor devuelve 100 % al pasajero', () => {
    const res = politicaCancelacionTotal(
      new Prisma.Decimal('15.50'),
      'cancelada_conductor',
    );
    expect(res.porcentajePasajero).toBe(100);
    expect(res.porcentajePasajeroBps).toBe(10_000);
    expect(res.montoPasajero.toFixed(2)).toBe('15.50');
    expect(res.montoConductor.toFixed(2)).toBe('0.00');
    expect(res.motivo).toBe('cancelada_conductor');
  });

  it('politicaCancelacionTotal: viaje_cancelado devuelve 100 % al pasajero', () => {
    const res = politicaCancelacionTotal(
      new Prisma.Decimal('20.00'),
      'viaje_cancelado',
    );
    expect(res.porcentajePasajero).toBe(100);
    expect(res.montoPasajero.toFixed(2)).toBe('20.00');
    expect(res.montoConductor.toFixed(2)).toBe('0.00');
    expect(res.motivo).toBe('viaje_cancelado');
  });

  it('politicaCancelacionTotal: sin_abordaje devuelve 100 % al pasajero', () => {
    const res = politicaCancelacionTotal(
      new Prisma.Decimal('8.00'),
      'sin_abordaje',
    );
    expect(res.porcentajePasajero).toBe(100);
    expect(res.montoPasajero.toFixed(2)).toBe('8.00');
    expect(res.montoConductor.toFixed(2)).toBe('0.00');
    expect(res.motivo).toBe('sin_abordaje');
  });

  it('politicaCancelacionTotal: verificacion_fallida devuelve 100 % al pasajero (RN-11, D-29)', () => {
    const res = politicaCancelacionTotal(
      new Prisma.Decimal('14.00'),
      'verificacion_fallida',
    );
    expect(res.porcentajePasajero).toBe(100);
    expect(res.montoPasajero.toFixed(2)).toBe('14.00');
    expect(res.montoConductor.toFixed(2)).toBe('0.00');
    expect(res.motivo).toBe('verificacion_fallida');
  });
});
