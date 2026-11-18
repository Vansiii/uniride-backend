import { evaluarTrayecto, type PuntoTraza } from './trayecto.js';

const RADIO_TIERRA_M = 6_371_008.8;
const INICIO = Date.UTC(2026, 10, 14, 12, 0, 0);
const BASE = { lat: -17.783327, lng: -63.182129 };
/** Grados de latitud que miden `m` metros sobre un meridiano (exacto con Haversine). */
const grados = (m: number) => ((m / RADIO_TIERRA_M) * 180) / Math.PI;

/** `n` puntos cada `pasoS` segundos hacia el norte a `kmh`, empezando `desdeS` segundos después de INICIO. */
function traza(
  n: number,
  { kmh = 30, pasoS = 15, desdeS = 0, desplazamientoM = 0 } = {},
): PuntoTraza[] {
  const metrosPorPaso = (kmh * 1000 * pasoS) / 3600;
  return Array.from({ length: n }, (_, i) => ({
    lat: BASE.lat + grados(i * metrosPorPaso + desplazamientoM),
    lng: BASE.lng,
    tomadaEn: INICIO + (desdeS + i * pasoS) * 1000,
    simulada: false,
  }));
}

describe('evaluarTrayecto (HU-23 RN-2 a RN-6)', () => {
  it('CA-4: viajaron juntos → verificada, con el registro de CA-15', () => {
    const conductor = traza(20);
    const pasajero = traza(20, { desdeS: 2, desplazamientoM: 20 });
    expect(evaluarTrayecto(pasajero, conductor)).toEqual({
      resultado: 'verificada',
      motivo: null,
      puntosPasajero: 20,
      pares: 20,
      coincidentes: 20,
      coincidenciaPct: 100,
      velocidadMaximaKmh: 30,
    });
  });

  it('el orden en que llegan los puntos no importa', () => {
    const conductor = traza(10).reverse();
    const pasajero = traza(10, { desplazamientoM: 10 }).reverse();
    expect(evaluarTrayecto(pasajero, conductor).resultado).toBe('verificada');
  });

  describe('CA-5 / A-07: salto imposible (RN-4)', () => {
    it('150 km/h entre dos puntos seguidos todavía vale', () => {
      const r = evaluarTrayecto(traza(6, { kmh: 150 }), traza(6, { kmh: 150 }));
      expect(r.motivo).toBeNull();
      expect(r.velocidadMaximaKmh).toBe(150);
    });

    it('151 km/h en la traza del pasajero → salto_imposible', () => {
      const r = evaluarTrayecto(traza(6, { kmh: 151 }), traza(6, { kmh: 151 }));
      expect(r).toMatchObject({
        resultado: 'verificacion_fallida',
        motivo: 'salto_imposible',
        velocidadMaximaKmh: 151,
      });
    });

    it('un solo salto en la traza del conductor basta', () => {
      const conductor = traza(8);
      conductor[4] = { ...conductor[4], lat: conductor[4].lat + grados(5000) };
      expect(evaluarTrayecto(traza(8), conductor).motivo).toBe(
        'salto_imposible',
      );
    });
  });

  describe('CA-6 / A-07: trayectos separados (RN-3)', () => {
    /** 20 puntos del pasajero; `lejos` de ellos a 101 m del conductor y el resto a 99 m. */
    const conLejos = (lejos: number) => {
      const conductor = traza(20);
      const pasajero = traza(20, { desplazamientoM: 99 }).map((p, i) =>
        i < lejos ? { ...p, lat: conductor[i].lat + grados(101) } : p,
      );
      return evaluarTrayecto(pasajero, conductor);
    };

    it('80 % de los pares a ≤ 100 m (16 de 20) → verificada', () => {
      expect(conLejos(4)).toMatchObject({
        resultado: 'verificada',
        coincidentes: 16,
        coincidenciaPct: 80,
      });
    });

    it('menos del 80 % (15 de 20) → trayectos_separados', () => {
      expect(conLejos(5)).toMatchObject({
        motivo: 'trayectos_separados',
        coincidenciaPct: 75,
      });
    });

    it('79,5 % (31 de 39) → trayectos_separados; 80 % exacto con 15 puntos (12) → verificada', () => {
      const conductor = traza(39);
      const lejos = (n: number, total: number) =>
        evaluarTrayecto(
          traza(total).map((p, i) =>
            i < n ? { ...p, lat: p.lat + grados(500) } : p,
          ),
          conductor.slice(0, total),
        );
      // Un salto de 500 m en 15 s son 120 km/h: no es salto imposible.
      expect(lejos(8, 39)).toMatchObject({
        motivo: 'trayectos_separados',
        coincidenciaPct: 79.5,
      });
      expect(lejos(3, 15)).toMatchObject({ resultado: 'verificada' });
    });

    it('un punto del pasajero sin pareja cuenta como no coincidente', () => {
      const conductor = traza(10);
      const pasajero = [
        ...traza(10),
        ...traza(3, { desdeS: 600 }), // diez minutos después: el conductor ya no envió nada
      ];
      expect(evaluarTrayecto(pasajero, conductor)).toMatchObject({
        motivo: 'trayectos_separados',
        pares: 10,
        puntosPasajero: 13,
      });
    });
  });

  describe('RN-2: un par es a lo sumo 15 s de diferencia', () => {
    it('15 s → par; 16 s → sin pareja', () => {
      const conductor = traza(5, { pasoS: 60 });
      const a15 = traza(5, { pasoS: 60, desdeS: 15 });
      const a16 = traza(5, { pasoS: 60, desdeS: 16 });
      expect(evaluarTrayecto(a15, conductor).pares).toBe(5);
      expect(evaluarTrayecto(a16, conductor)).toMatchObject({
        pares: 0,
        motivo: 'datos_insuficientes',
      });
    });

    it('elige el punto del conductor más cercano en el tiempo', () => {
      const conductor = [
        { ...BASE, tomadaEn: INICIO, simulada: false },
        {
          ...BASE,
          lat: BASE.lat + grados(90),
          tomadaEn: INICIO + 10_000,
          simulada: false,
        },
      ];
      // 8 s: el segundo (a 2 s) está a 90 m; el primero (a 8 s) estaría a 180 m.
      const pasajero = [
        {
          ...BASE,
          lat: BASE.lat + grados(180),
          tomadaEn: INICIO + 8_000,
          simulada: false,
        },
      ];
      expect(evaluarTrayecto(pasajero, conductor).coincidentes).toBe(1);
    });
  });

  describe('CA-10: mínimo de datos (RN-5)', () => {
    it('4 pares → se evalúa', () => {
      expect(evaluarTrayecto(traza(4), traza(4)).resultado).toBe('verificada');
    });

    it('3 pares → datos_insuficientes', () => {
      expect(evaluarTrayecto(traza(3), traza(3))).toMatchObject({
        resultado: 'verificacion_fallida',
        motivo: 'datos_insuficientes',
        pares: 3,
      });
    });

    it('sin puntos → datos_insuficientes y 0 %', () => {
      expect(evaluarTrayecto([], [])).toMatchObject({
        motivo: 'datos_insuficientes',
        coincidenciaPct: 0,
      });
    });
  });

  describe('CA-7 / A-07: ubicación simulada (RN-6)', () => {
    it('un solo punto simulado del pasajero invalida', () => {
      const pasajero = traza(10);
      pasajero[5] = { ...pasajero[5], simulada: true };
      expect(evaluarTrayecto(pasajero, traza(10)).motivo).toBe(
        'ubicacion_simulada',
      );
    });

    it('uno del conductor también, y tiene prioridad sobre el salto', () => {
      const conductor = traza(10, { kmh: 300 });
      conductor[9] = { ...conductor[9], simulada: true };
      expect(evaluarTrayecto(traza(10, { kmh: 300 }), conductor).motivo).toBe(
        'ubicacion_simulada',
      );
    });
  });
});
