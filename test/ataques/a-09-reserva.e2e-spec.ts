import { randomUUID } from 'node:crypto';
import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { enMs, HORA_MS } from '../viajes/ayudas-viajes.js';
import { ayudasReservas } from '../reservas/ayudas-reservas.js';

/** HU-19 CA-3, CA-4 y CA-5 · A-09: ni dos pasajeros en el último asiento, ni cobrar dos veces, ni gastar el mismo saldo dos veces. */
describe('A-09 · reservas simultáneas y repetidas (e2e)', () => {
  let e: Entorno;
  const r = ayudasReservas(() => e);
  let org: string;

  beforeAll(async () => {
    e = await prepararEntorno();
    org = (await r.v.organizacion('Reservas A09')).id;
  });
  beforeEach(() => r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  const estados = (rs: { status: number }[]) => rs.map((x) => x.status).sort();

  describe('CA-3 · el último asiento', () => {
    it('dos pasajeros a la vez: uno obtiene la reserva y el otro «Ya no quedan asientos», sin bloqueo para él', async () => {
      const c = await r.conductor(org);
      const viajeId = await r.publicar(c, { cuposTotales: 1 });
      const [a, b] = await Promise.all([r.pasajero(org), r.pasajero(org)]);
      const rs = await Promise.all([
        r.reservar(a, viajeId),
        r.reservar(b, viajeId),
      ]);

      expect(estados(rs)).toEqual([201, 409]);
      const perdedor = rs.find((x) => x.status === 409);
      expect(perdedor?.body.codigo).toBe('SIN_ASIENTOS');
      expect((await r.filasReserva(viajeId)).length).toBe(1);
      expect((await r.viaje(viajeId)).cupos_disponibles).toBe(0);
      const huellas = await Promise.all([r.huella(a.id), r.huella(b.id)]);
      expect(huellas.map((h) => h.reservas).sort()).toEqual([0, 1]);
      expect(huellas.map((h) => h.bloqueos).sort()).toEqual([0, 1]);
    });

    it('seis pasajeros por dos asientos: exactamente dos reservas', async () => {
      const c = await r.conductor(org);
      const viajeId = await r.publicar(c, { cuposTotales: 2 });
      const ps = await Promise.all(
        Array.from({ length: 6 }, () => r.pasajero(org)),
      );
      const rs = await Promise.all(ps.map((p) => r.reservar(p, viajeId)));
      expect(estados(rs)).toEqual([201, 201, 409, 409, 409, 409]);
      expect((await r.filasReserva(viajeId)).length).toBe(2);
      expect((await r.viaje(viajeId)).cupos_disponibles).toBe(0);
    });
  });

  describe('CA-4 · la misma petición repetida', () => {
    it('con la misma clave y firmas nuevas: una sola reserva, un solo bloqueo y un solo trabajo', async () => {
      const c = await r.conductor(org);
      const viajeId = await r.publicar(c);
      const p = await r.pasajero(org);
      const clave = randomUUID();
      const primera = await r.reservar(p, viajeId, clave).expect(201);
      const segunda = await r.reservar(p, viajeId, clave).expect(200);
      expect(segunda.body).toEqual(primera.body);

      expect(await r.huella(p.id)).toEqual({ reservas: 1, bloqueos: 1 });
      expect((await r.viaje(viajeId)).cupos_disponibles).toBe(2);
      const movs = await r.movimientosDeReserva(primera.body.reservaId);
      expect(movs).toHaveLength(1);
      const { rows } = await e.bd.query(
        `SELECT count(*)::int AS n FROM trabajos_onchain WHERE movimiento_id IN
           (SELECT id FROM movimientos_billetera WHERE reserva_id = $1)`,
        [primera.body.reservaId],
      );
      expect(rows[0].n).toBe(1);
    });

    it('seis peticiones iguales a la vez (doble toque, red lenta): una sola reserva', async () => {
      const c = await r.conductor(org);
      const viajeId = await r.publicar(c);
      const p = await r.pasajero(org);
      const clave = randomUUID();
      const rs = await Promise.all(
        Array.from({ length: 6 }, () => r.reservar(p, viajeId, clave)),
      );
      expect(estados(rs)).toEqual([200, 200, 200, 200, 200, 201]);
      expect(new Set(rs.map((x) => x.body.reservaId)).size).toBe(1);
      expect(await r.huella(p.id)).toEqual({ reservas: 1, bloqueos: 1 });
      expect((await r.viaje(viajeId)).cupos_disponibles).toBe(2);
    });

    it('con claves distintas, a la vez, tampoco se duplica: una reserva y las demás YA_RESERVADO', async () => {
      const c = await r.conductor(org);
      const viajeId = await r.publicar(c);
      const p = await r.pasajero(org);
      const rs = await Promise.all(
        Array.from({ length: 4 }, () => r.reservar(p, viajeId)),
      );
      expect(estados(rs)).toEqual([201, 409, 409, 409]);
      expect(
        rs
          .filter((x) => x.status === 409)
          .every((x) => x.body.codigo === 'YA_RESERVADO'),
      ).toBe(true);
      expect(await r.huella(p.id)).toEqual({ reservas: 1, bloqueos: 1 });
    });

    it('dos workers a la vez sobre el mismo trabajo bloquean una sola vez', async () => {
      const c = await r.conductor(org);
      const viajeId = await r.publicar(c);
      const p = await r.pasajero(org);
      await r.reservar(p, viajeId).expect(201);
      const terminados = await Promise.all([r.procesar(), r.procesar()]);
      expect(terminados.reduce((a, b) => a + b, 0)).toBe(1);
      expect(r.cadena().intentosDeBloqueo).toBe(1);
      expect(r.cadena().saldos.get(p.direccion)).toBe(3950n * 10n ** 16n);
    });
  });

  describe('CA-5 · el mismo saldo en dos viajes a la vez', () => {
    it('con 15 URC y dos viajes de 10,50: solo se acepta uno, y ninguno queda a medias', async () => {
      const c = await r.conductor(org);
      const uno = await r.publicar(c);
      const dos = await r.publicar(c, { fechaHoraSalida: enMs(8 * HORA_MS) });
      const p = await r.pasajero(org, '15.00');
      const rs = await Promise.all([r.reservar(p, uno), r.reservar(p, dos)]);

      expect(estados(rs)).toEqual([201, 409]);
      expect(rs.find((x) => x.status === 409)?.body.codigo).toBe(
        'SALDO_INSUFICIENTE',
      );
      expect(await r.huella(p.id)).toEqual({ reservas: 1, bloqueos: 1 });
      const cupos = [
        (await r.viaje(uno)).cupos_disponibles,
        (await r.viaje(dos)).cupos_disponibles,
      ];
      expect(cupos.sort()).toEqual([2, 3]);
      await r.procesar();
      expect(r.cadena().intentosDeBloqueo).toBe(1);
    });

    it('con saldo para ambos se aceptan los dos', async () => {
      const c = await r.conductor(org);
      const uno = await r.publicar(c);
      const dos = await r.publicar(c, { fechaHoraSalida: enMs(8 * HORA_MS) });
      const p = await r.pasajero(org, '25.00');
      const rs = await Promise.all([r.reservar(p, uno), r.reservar(p, dos)]);
      expect(estados(rs)).toEqual([201, 201]);
      expect(await r.procesar()).toBe(2);
      expect(r.cadena().saldos.get(p.direccion)).toBe(400n * 10n ** 16n);
    });

    it('con exactamente el precio de saldo se reserva; con un centavo menos, no', async () => {
      const c = await r.conductor(org);
      const viajeId = await r.publicar(c);
      const justo = await r.pasajero(org, '10.50');
      await r.reservar(justo, viajeId).expect(201);
      const corto = await r.pasajero(org, '10.49');
      const res = await r.reservar(corto, viajeId).expect(409);
      expect(res.body).toMatchObject({
        codigo: 'SALDO_INSUFICIENTE',
        faltante: '0.01',
      });
    });
  });
});
