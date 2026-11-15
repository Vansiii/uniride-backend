import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasPresencia } from '../presencia/ayudas-presencia.js';

/**
 * HU-22 CA-7 · A-03: emulador, root o app modificada, con la integridad simulada en modo no íntegro.
 * La atestación real solo se declara verificada en un teléfono físico (`AGENTS.md` §6).
 */
describe('A-03 · integridad en el abordaje (e2e)', () => {
  let e: Entorno;
  const h = ayudasPresencia(() => e);
  let org: string;

  beforeAll(async () => {
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno();
    org = (await h.r.v.organizacion('Atq A03')).id;
  });
  beforeEach(() => h.r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  it.each(['simulado:root', 'simulado:emulador'])(
    'pasajero con %s: «Este teléfono no puede verificar viajes», sin detalle, y nada cambia',
    async (token) => {
      const s = await h.escenario(org);
      const p = s.pasajeros[0];
      const nonce = await h.codigo(s, await h.llaveConductor(s));
      const res = await h
        .abordar(p, p.reservaId, nonce, { tokenIntegridad: token })
        .expect(422);
      expect(res.body).toEqual({
        codigo: 'DISPOSITIVO_NO_INTEGRO',
        mensaje: 'Este teléfono no puede verificar viajes.',
      });
      expect(await h.estadoReserva(p.reservaId)).toBe('confirmada');
      expect(await h.estadoViaje(s.viajeId)).toBe('reservado');
      expect(await h.pruebas(p.reservaId)).toEqual([
        expect.objectContaining({
          resultado: 'rechazada',
          veredicto_integridad: 'NO_INTEGRO',
        }),
      ]);
    },
  );

  it('Play Integrity caído: 503 temporal, la reserva intacta, y con un código nuevo se puede reintentar', async () => {
    const s = await h.escenario(org);
    const p = s.pasajeros[0];
    const l = await h.llaveConductor(s);
    const res = await h
      .abordar(p, p.reservaId, await h.codigo(s, l), {
        tokenIntegridad: 'simulado:caido',
      })
      .expect(503);
    expect(res.body.codigo).toBe('SERVICIO_NO_DISPONIBLE');
    expect(await h.estadoReserva(p.reservaId)).toBe('confirmada');
    await h.abordar(p, p.reservaId, await h.codigo(s, l)).expect(200);
  });

  it('conductor desde un teléfono no íntegro: no registra la llave de trayecto', async () => {
    const s = await h.escenario(org);
    const { peticion } = h.registrarLlave(s.conductor, s.viajeId, {
      tokenIntegridad: 'simulado:root',
    });
    const res = await peticion.expect(422);
    expect(res.body.codigo).toBe('DISPOSITIVO_NO_INTEGRO');
    const { rows } = await e.bd.query(
      `SELECT count(*)::int AS n FROM llaves_trayecto WHERE viaje_id = $1`,
      [s.viajeId],
    );
    expect(rows[0].n).toBe(0);
  });
});
