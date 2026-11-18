import { hashPruebaPresencia, type DatosPruebaPresencia } from './prueba.js';

const datos: DatosPruebaPresencia = {
  reservaId: '6f1c2a3e-0000-4000-8000-000000000001',
  hashAbordaje: 'a'.repeat(64),
  hashBajada: 'b'.repeat(64),
  evaluacion: {
    resultado: 'verificada',
    motivo: null,
    puntosPasajero: 20,
    pares: 20,
    coincidentes: 19,
    coincidenciaPct: 95,
    velocidadMaximaKmh: 42.3,
  },
};

describe('hashPruebaPresencia (HU-24 CA-2)', () => {
  it('es un bytes32 para el contrato', () => {
    expect(hashPruebaPresencia(datos)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('no depende del orden de las llaves: jsonb las reordena al guardar', () => {
    const reordenada = Object.fromEntries(
      Object.entries(datos.evaluacion).reverse(),
    );
    expect(hashPruebaPresencia({ ...datos, evaluacion: reordenada })).toBe(
      hashPruebaPresencia(datos),
    );
  });

  it('cualquier cambio en las pruebas o la evaluación cambia el hash (RN-4)', () => {
    const base = hashPruebaPresencia(datos);
    for (const cambio of [
      { hashAbordaje: 'c'.repeat(64) },
      { hashBajada: 'c'.repeat(64) },
      { reservaId: '6f1c2a3e-0000-4000-8000-000000000002' },
      { evaluacion: { ...datos.evaluacion, coincidenciaPct: 95.1 } },
    ])
      expect(hashPruebaPresencia({ ...datos, ...cambio })).not.toBe(base);
  });
});
