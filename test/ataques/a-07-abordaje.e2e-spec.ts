import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasPresencia, posicion } from '../presencia/ayudas-presencia.js';

/** HU-22 CA-6, CA-12 · A-07: ubicación simulada, imprecisa o vieja, del pasajero o del conductor. */
describe('A-07 · GPS falso o débil en el abordaje (e2e)', () => {
  let e: Entorno;
  const h = ayudasPresencia(() => e);
  let org: string;

  beforeAll(async () => {
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno();
    org = (await h.r.v.organizacion('Atq A07')).id;
  });
  beforeEach(() => h.r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  it.each([
    [
      'simulada (CA-6)',
      { simulada: true },
      'UBICACION_SIMULADA',
      'No pudimos confirmar tu ubicación.',
    ],
    [
      'con precisión de 80 m (CA-12)',
      { precisionM: 80 },
      'SENAL_GPS',
      undefined,
    ],
    [
      'tomada hace 40 s (CA-12)',
      { tomadaEn: Date.now() - 40_000 },
      'SENAL_GPS',
      undefined,
    ],
  ])(
    'posición del pasajero %s: se rechaza y la reserva sigue confirmada',
    async (_, cambio, codigo, mensaje) => {
      const s = await h.escenario(org);
      const p = s.pasajeros[0];
      const nonce = await h.codigo(s, await h.llaveConductor(s));
      const res = await h
        .abordar(p, p.reservaId, nonce, { posicion: posicion(cambio) })
        .expect(422);
      expect(res.body.codigo).toBe(codigo);
      if (mensaje) expect(res.body.mensaje).toBe(mensaje);
      expect(await h.estadoReserva(p.reservaId)).toBe('confirmada');
    },
  );

  it.each([
    ['simulada', { simulada: true }, 'UBICACION_SIMULADA'],
    ['con precisión de 80 m', { precisionM: 80 }, 'SENAL_GPS'],
    ['tomada hace 40 s', { tomadaEn: Date.now() - 40_000 }, 'SENAL_GPS'],
  ])(
    'posición del conductor %s: no se emite el código',
    async (_, cambio, codigo) => {
      const s = await h.escenario(org);
      const l = await h.llaveConductor(s);
      const res = await h
        .desafio(s.conductor.token, s.viajeId, l, {
          tipo: 'abordaje',
          posicion: posicion(cambio),
        })
        .expect(422);
      expect(res.body.codigo).toBe(codigo);
      const { rows } = await e.bd.query(
        `SELECT count(*)::int AS n FROM desafios_handshake WHERE viaje_id = $1`,
        [s.viajeId],
      );
      expect(rows[0].n).toBe(0);
    },
  );
});
