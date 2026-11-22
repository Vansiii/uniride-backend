import { describe, expect, it } from 'vitest';
import {
  numerosDe,
  textoPerfil,
  validarAnalisis,
  type Perfil,
} from './analisis-riesgo.js';

const valido = {
  riesgo: 'alto',
  puntaje: 87,
  motivos: ['6 reservas en 7 días con 420 m de distancia promedio'],
  recomendacion: 'Revisar ambas cuentas.',
};
const json = (o: unknown) => JSON.stringify(o);

describe('validarAnalisis (PB-10 RN-5, CA-4)', () => {
  it('acepta una respuesta en formato', () => {
    expect(validarAnalisis(json(valido))).toEqual(valido);
  });

  it.each([
    ['texto suelto', 'El riesgo es alto'],
    ['riesgo desconocido', json({ ...valido, riesgo: 'critico' })],
    ['puntaje > 100', json({ ...valido, puntaje: 101 })],
    ['puntaje negativo', json({ ...valido, puntaje: -1 })],
    ['puntaje decimal', json({ ...valido, puntaje: 50.5 })],
    ['puntaje texto', json({ ...valido, puntaje: '87' })],
    ['sin motivos', json({ ...valido, motivos: [] })],
    ['4 motivos', json({ ...valido, motivos: ['a', 'b', 'c', 'd'] })],
    ['motivo largo', json({ ...valido, motivos: ['x'.repeat(161)] })],
    [
      'recomendación larga',
      json({ ...valido, recomendacion: 'x'.repeat(201) }),
    ],
    ['sin recomendación', json({ ...valido, recomendacion: '' })],
    ['arreglo', json([valido])],
    ['null', 'null'],
  ])('descarta %s', (_caso, entrada) => {
    expect(validarAnalisis(entrada)).toBeNull();
  });
});

describe('textoPerfil (PB-10 CA-8)', () => {
  const perfil: Perfil = {
    patron: 'sin_desplazamiento',
    distanciaM: 420,
    minutos: 2.1,
    alertasPrevias: 2,
    par: {
      reservas7d: 6,
      reservas30d: 14,
      distanciaPromedioM: 420,
      duracionPromedioMin: 2.1,
    },
    personas: [0, 1].map(() => ({
      antiguedadDias: 4,
      fallidas7d: 0,
      calificacionPromedio: 5,
      calificaciones: 6,
      calificacionesDelPar: 6,
      recargas30d: 0,
      cobros30d: 12,
      pagos30d: 0,
    })),
  };

  it('nombra a las personas solo como A y B', () => {
    const texto = JSON.parse(textoPerfil(perfil));
    expect(Object.keys(texto)).toEqual(
      expect.arrayContaining(['A', 'B', 'par', 'patron']),
    );
  });

  it('no contiene uuids, correos ni coordenadas', () => {
    const texto = textoPerfil(perfil);
    expect(texto).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(texto).not.toMatch(/@/);
    expect(texto).not.toMatch(/lat|lng|longitud|latitud/i);
  });
});

describe('PB-11: análisis con el modelo propio (CA-5, CA-6, CA-15)', () => {
  const perfil: Perfil = {
    patron: 'anillo_colusion',
    anillo: { personas: 4, viajesInternos: 18, proporcion: 0.95 },
    alertasPrevias: 0,
    par: null,
    modelo: {
      puntaje: 91,
      riesgo: 'alto',
      factores: [
        { cifra: 'viajes7d', valor: 8, percentil: 99 },
        { cifra: 'distanciaPromedioM', valor: 300, percentil: 2 },
      ],
      percentiles: {
        viajes7d: 99,
        viajes30d: 97,
        distanciaPromedioM: 2,
        duracionPromedioMin: 3,
        fraccionConductor: 90,
        fraccionPasajero: 95,
        fraccionCalificacionesDelPar: 88,
        antiguedadMinimaDias: 10,
        cobrosSinRecarga: 96,
        fallidas7d: 50,
      },
    },
    personas: [0, 1, 2, 3].map(() => ({
      antiguedadDias: 9,
      fallidas7d: 0,
      calificacionPromedio: 5,
      calificaciones: 4,
      calificacionesDelPar: 0,
      recargas30d: 0,
      cobros30d: 5,
      pagos30d: 5,
    })),
  };
  const texto = textoPerfil(perfil);
  const modelo = {
    puntaje: 91,
    riesgo: 'alto' as const,
    numeros: numerosDe(texto),
  };

  it('el puntaje y el riesgo salen del modelo aunque la IA diga otra cosa', () => {
    const r = validarAnalisis(
      json({
        riesgo: 'bajo',
        puntaje: 5,
        motivos: ['8 viajes en 7 días: percentil 99 de la organización'],
        recomendacion: 'Revisar el grupo.',
      }),
      modelo,
    );
    expect(r).toMatchObject({ riesgo: 'alto', puntaje: 91 });
  });

  it('acepta la respuesta sin riesgo ni puntaje', () => {
    expect(
      validarAnalisis(
        json({
          motivos: ['Distancia promedio de 300 m (percentil 2)'],
          recomendacion: 'Revisar.',
        }),
        modelo,
      ),
    ).not.toBeNull();
  });

  it.each([
    ['sin números', 'El grupo viaja mucho entre sí'],
    ['con un número inventado', 'Hicieron 4321 viajes'],
  ])('descarta un motivo %s', (_c, motivo) => {
    expect(
      validarAnalisis(json({ motivos: [motivo], recomendacion: 'x' }), modelo),
    ).toBeNull();
  });

  it('el perfil de anillo nombra A, B, C, D y no lleva ids ni coordenadas', () => {
    const o = JSON.parse(texto);
    expect(Object.keys(o)).toEqual(
      expect.arrayContaining(['A', 'B', 'C', 'D', 'anillo', 'modelo']),
    );
    expect(texto).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(texto).not.toMatch(/lat|lng|longitud|latitud/i);
  });
});
