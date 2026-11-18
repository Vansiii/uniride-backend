import {
  distanciaM,
  motivoPosicionInvalida,
  ventanaAbordaje,
  type Posicion,
} from './geo.js';

describe('distanciaM (Haversine)', () => {
  it('el mismo punto: 0 m', () => {
    expect(
      distanciaM({ lat: -17.78, lng: -63.18 }, { lat: -17.78, lng: -63.18 }),
    ).toBe(0);
  });

  it('0,00045° de latitud son ~50 m, sea cual sea la longitud', () => {
    const d = distanciaM(
      { lat: -17.78, lng: -63.18 },
      { lat: -17.78045, lng: -63.18 },
    );
    expect(d).toBeGreaterThan(49.5);
    expect(d).toBeLessThan(50.5);
  });

  it('en Santa Cruz, 0,001° de longitud son ~106 m (cos de la latitud)', () => {
    const d = distanciaM(
      { lat: -17.78, lng: -63.18 },
      { lat: -17.78, lng: -63.181 },
    );
    expect(d).toBeGreaterThan(105);
    expect(d).toBeLessThan(107);
  });
});

describe('ventanaAbordaje (RN-3)', () => {
  it('desde 30 min antes hasta 15 min después de la salida', () => {
    const salida = new Date('2026-11-14T08:00:00Z');
    expect(ventanaAbordaje(salida)).toEqual({
      desde: new Date('2026-11-14T07:30:00Z'),
      hasta: new Date('2026-11-14T08:15:00Z'),
    });
  });
});

describe('motivoPosicionInvalida (RN-4)', () => {
  const ahora = 1_800_000_000_000;
  const buena: Posicion = {
    lat: 0,
    lng: 0,
    precisionM: 50,
    tomadaEn: ahora - 30_000,
    simulada: false,
  };

  it('precisión de 50 m y 30 s de antigüedad: sirve (límites incluidos)', () => {
    expect(motivoPosicionInvalida(buena, ahora)).toBeNull();
  });

  it.each([
    ['simulada', { simulada: true }, 'ubicacion_simulada'],
    [
      'simulada aunque la señal sea mala',
      { simulada: true, precisionM: 500 },
      'ubicacion_simulada',
    ],
    ['precisión de 51 m', { precisionM: 51 }, 'senal_gps'],
    ['tomada hace 31 s', { tomadaEn: ahora - 31_000 }, 'senal_gps'],
    ['con el reloj 31 s adelantado', { tomadaEn: ahora + 31_000 }, 'senal_gps'],
  ])('%s: se rechaza', (_, cambio, motivo) => {
    expect(motivoPosicionInvalida({ ...buena, ...cambio }, ahora)).toBe(motivo);
  });
});
