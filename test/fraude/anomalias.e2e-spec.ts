import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { A, ayudasFraude, DIA_MS, HORA_MS, LEJOS } from './ayudas-fraude.js';

/** HU-25: el tic evalúa P-1, P-2 y P-3, y deja alertas y bloqueos sin tocar el pago. */
describe('HU-25 · detección de anomalías (e2e)', () => {
  let e: Entorno;
  const f = ayudasFraude(() => e);
  let org: string;
  // Salidas en el pasado reciente: la reserva ya se cobró.
  const hace = (ms: number) => new Date(Date.now() - ms);

  beforeAll(async () => {
    e = await prepararEntorno();
    org = (await f.r.v.organizacion('Fraude Anom')).id;
  });
  beforeEach(() => f.r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  describe('P-1 viajes repetidos', () => {
    it('CA-1: la tercera reserva pagada del par en 24 h deja alerta y bloquea al par 7 días', async () => {
      const c = await f.persona(org);
      const p = await f.persona(org);
      for (const h of [20, 12, 4])
        await f.viajeNormal(org, c, p, hace(h * HORA_MS));

      const resumen = await f.tic();
      expect(resumen).toEqual({ evaluadas: 3, fallidas: 0 });

      const filas = await f.bloqueos(c.id);
      expect(filas).toHaveLength(1);
      expect(filas[0]).toMatchObject({
        tipo: 'par',
        patron: 'viajes_repetidos',
      });
      const dias =
        (new Date(filas[0].vence_en).getTime() - Date.now()) / DIA_MS;
      expect(dias).toBeGreaterThan(6.9);
      expect(dias).toBeLessThanOrEqual(7);
      expect(await f.alertas([c.id])).toHaveLength(1);
    });

    it('CA-2: ida y vuelta (2 en 24 h) no deja alerta ni bloqueo', async () => {
      const c = await f.persona(org);
      const p = await f.persona(org);
      for (const h of [20, 8])
        await f.viajeNormal(org, c, p, hace(h * HORA_MS));

      await f.tic();
      expect(await f.bloqueos(c.id)).toEqual([]);
      expect(await f.alertas([c.id])).toEqual([]);
    });
  });

  describe('P-2 viaje sin desplazamiento', () => {
    it('CA-3: menos de 1 km deja alerta; la segunda del par en 7 días bloquea', async () => {
      const c = await f.persona(org);
      const p = await f.persona(org);
      const quieto = { abordaje: A, bajada: { ...A, lat: A.lat + 0.001 } };
      const una = await f.reservaEn(org, c, p, hace(3 * DIA_MS), quieto);
      await f.tic();
      expect(await f.alertas([c.id])).toHaveLength(1);
      expect(await f.bloqueos(c.id)).toEqual([]);
      expect(await f.sinEvaluar(una.reservaId)).toBe(false);

      await f.reservaEn(org, c, p, hace(1 * DIA_MS), quieto);
      await f.tic();
      expect(await f.alertas([c.id])).toHaveLength(2);
      expect(await f.bloqueos(c.id)).toMatchObject([
        { tipo: 'par', patron: 'sin_desplazamiento' },
      ]);
    });

    it('CA-3: menos de 3 minutos entre abordaje y bajada también es alerta', async () => {
      const c = await f.persona(org);
      const p = await f.persona(org);
      await f.reservaEn(org, c, p, hace(2 * HORA_MS), {
        abordaje: { ...A, en: 0 },
        bajada: { ...LEJOS, en: 120_000 },
      });
      await f.tic();
      const [alerta] = await f.alertas([c.id]);
      expect(alerta.detalle).toMatchObject({
        patron: 'sin_desplazamiento',
        minutos: 2,
      });
    });

    it('un viaje normal no deja alerta, y sin posiciones P-2 no se evalúa', async () => {
      const c = await f.persona(org);
      const p = await f.persona(org);
      await f.viajeNormal(org, c, p, hace(2 * HORA_MS));
      await f.reservaEn(org, c, p, hace(5 * DIA_MS), {});
      await f.tic();
      expect(await f.alertas([c.id])).toEqual([]);
    });
  });

  describe('P-3 verificaciones fallidas repetidas', () => {
    it('CA-4: la tercera en 7 días deja alerta y bloquea la cuenta 72 h; con 2 no', async () => {
      const p = await f.persona(org);
      for (const h of [30, 20]) {
        const c = await f.persona(org);
        await f.viajeNormal(
          org,
          c,
          p,
          hace(h * HORA_MS),
          'verificacion_fallida',
        );
      }
      await f.tic();
      expect(await f.bloqueos(p.id)).toEqual([]);

      const c3 = await f.persona(org);
      await f.viajeNormal(
        org,
        c3,
        p,
        hace(2 * HORA_MS),
        'verificacion_fallida',
      );
      await f.tic();
      const filas = await f.bloqueos(p.id);
      expect(filas).toMatchObject([
        { tipo: 'cuenta', patron: 'verificaciones_fallidas' },
      ]);
      const horas =
        (new Date(filas[0].vence_en).getTime() - Date.now()) / HORA_MS;
      expect(horas).toBeGreaterThan(71.9);
      expect(horas).toBeLessThanOrEqual(72);
      // Solo él: cada conductor tiene una sola fallida.
      expect(await f.bloqueos(c3.id)).toEqual([]);
    });
  });

  describe('vigencia, extensión y repetición', () => {
    it('CA-8: un bloqueo con fin pasado ya no bloquea y no hace falta intervención', async () => {
      const c = await f.persona(org);
      const p = await f.persona(org);
      for (const h of [20, 12, 4])
        await f.viajeNormal(org, c, p, hace(h * HORA_MS));
      await f.tic();
      await e.bd.query(
        `UPDATE bloqueos_preventivos SET vence_en = now() - interval '1 minute' WHERE usuario_id = $1 OR usuario_par_id = $1`,
        [c.id],
      );
      const viajeId = await f.r.publicar(c);
      await f.r.reservar(p, viajeId).expect(201);
    });

    it('CA-9: un patrón que se repite agrega un bloqueo de fin mayor, no los acumula', async () => {
      const c = await f.persona(org);
      const p = await f.persona(org);
      for (const h of [20, 12, 4])
        await f.viajeNormal(org, c, p, hace(h * HORA_MS));
      await f.tic();
      const antes = await f.bloqueos(c.id);
      const finAntes = Math.max(...antes.map((b) => +new Date(b.vence_en)));
      await f.viajeNormal(org, c, p, hace(1 * HORA_MS));
      await f.tic(new Date(Date.now() + HORA_MS));
      const despues = await f.bloqueos(c.id);
      const finDespues = Math.max(...despues.map((b) => +new Date(b.vence_en)));
      expect(finDespues).toBeGreaterThan(finAntes);
      // Una fila por reserva que disparó el patrón: no se duplican.
      expect(new Set(despues.map((b) => b.reserva_id)).size).toBe(
        despues.length,
      );
    });

    it('CA-10: evaluar otra vez no duplica alertas ni bloqueos, ni con dos tics a la vez', async () => {
      const c = await f.persona(org);
      const p = await f.persona(org);
      for (const h of [20, 12, 4])
        await f.viajeNormal(org, c, p, hace(h * HORA_MS));
      const [x, y] = await Promise.all([f.tic(), f.tic()]);
      expect(x.evaluadas + y.evaluadas).toBe(3);
      const filas = await f.bloqueos(c.id);
      const alertas = (await f.alertas([c.id])).length;
      await f.tic();
      expect(await f.bloqueos(c.id)).toHaveLength(filas.length);
      expect(await f.alertas([c.id])).toHaveLength(alertas);
    });
  });

  describe('fallas y privacidad', () => {
    it('CA-11: si la evaluación falla, el estado de la reserva no cambia y se reintenta', async () => {
      const c = await f.persona(org);
      const p = await f.persona(org);
      const { reservaId } = await f.viajeNormal(org, c, p, hace(HORA_MS));
      const original = e.app.get(
        (await import('../../src/auditoria/auditoria.service.js'))
          .AuditoriaService,
      );
      const real = original.registrar.bind(original);
      // Una sola falla en `fraude.alerta`; las demás auditorías pasan.
      let fallar = true;
      original.registrar = (async (ev, tx) => {
        if (fallar && ev.accion === 'fraude.alerta') throw new Error('boom');
        return real(ev, tx);
      }) as typeof original.registrar;
      // Para que haya alerta hace falta un patrón: un viaje sin desplazamiento.
      await e.bd.query(
        `UPDATE pruebas_presencia SET pasajero_lat = $2, pasajero_lng = $3 WHERE reserva_id = $1`,
        [reservaId, A.lat, A.lng],
      );
      try {
        const resumen = await f.tic();
        expect(resumen.fallidas).toBe(1);
        expect(await f.sinEvaluar(reservaId)).toBe(true);
        const { rows } = await e.bd.query(
          `SELECT estado FROM reservas WHERE id = $1`,
          [reservaId],
        );
        expect(rows[0].estado).toBe('pagada');
        expect(
          (
            await e.bd.query(
              `SELECT 1 FROM registros_auditoria WHERE accion = 'fraude.evaluacion' AND entidad_id = $1 AND resultado = 'fallo'`,
              [reservaId],
            )
          ).rowCount,
        ).toBe(1);
        fallar = false;
        expect((await f.tic()).evaluadas).toBe(1);
        expect(await f.sinEvaluar(reservaId)).toBe(false);
      } finally {
        original.registrar = real as typeof original.registrar;
      }
    });

    it('CA-14: alertas y bloqueos llevan cifras y organización, nunca coordenadas', async () => {
      const c = await f.persona(org);
      const p = await f.persona(org);
      await f.reservaEn(org, c, p, hace(3 * HORA_MS), {
        abordaje: A,
        bajada: { ...A, lat: A.lat + 0.002 },
      });
      await f.tic();
      const [alerta] = await f.alertas([c.id]);
      expect(alerta.organizacion_id).toBe(org);
      expect(Object.keys(alerta.detalle).sort()).toEqual(
        [
          'distanciaM',
          'minutos',
          'patron',
          'personas',
          'reservaId',
          'reservas',
        ].sort(),
      );
      const texto = JSON.stringify(alerta.detalle);
      expect(texto).not.toContain(String(A.lat));
      expect(alerta.detalle.distanciaM).toBeLessThan(1000);
    });
  });
});
