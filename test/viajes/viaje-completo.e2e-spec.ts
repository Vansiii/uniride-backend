import { id } from 'ethers';
import { hashPruebaPresencia } from '../../src/presencia/prueba.js';
import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasPresencia } from '../presencia/ayudas-presencia.js';

/** HU-24: reserva → abordaje → bajada → pago, sin que nadie pida la liberación (CA-1, CA-2, CA-8, CA-10). */
describe('HU-24 · viaje completo hasta el pago (e2e)', () => {
  let e: Entorno;
  const h = ayudasPresencia(() => e);
  const r = h.r;
  let org: string;

  beforeAll(async () => {
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno();
    org = (await r.v.organizacion('Viaje completo')).id;
  });
  beforeEach(() => r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  const pago = async (token: string, reservaId: string) =>
    (await r.reserva(token, reservaId).expect(200)).body.pago;

  it('CA-1, CA-10: la bajada verificada deja el pago pendiente y la cola lo libera: reserva pagada, viaje pagado', async () => {
    const v = await h.verificado(org);
    const p = v.s.pasajeros[0];
    const c = v.s.conductor;

    // Antes de la red: «Recibirás 10.50 URC» para el conductor; el pasajero ve lo mismo.
    const pendiente = {
      estado: 'pendiente',
      monto: '10.50',
      hashTx: null,
      exploradorUrl: null,
    };
    expect(await pago(c.token, p.reservaId)).toEqual(pendiente);
    expect(await pago(p.token, p.reservaId)).toEqual(pendiente);
    expect(await h.estadoViaje(v.s.viajeId)).toBe('verificado');

    await r.procesar();

    const hecho = await pago(c.token, p.reservaId);
    expect(hecho).toMatchObject({ estado: 'confirmado', monto: '10.50' });
    expect(hecho.hashTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await pago(p.token, p.reservaId)).toEqual(hecho);
    expect(await h.estadoReserva(p.reservaId)).toBe('pagada');
    expect(await h.estadoViaje(v.s.viajeId)).toBe('pagado');

    // Al pasajero se le descuenta de «En garantía»; el conductor cobra el 100 % (RN-1).
    const saldoP = (await r.saldo(p).expect(200)).body;
    const saldoC = (await r.saldo(c).expect(200)).body;
    expect(saldoP).toMatchObject({
      saldoTotal: '39.50',
      saldoBloqueadoEscrow: '0.00',
    });
    expect(saldoC).toMatchObject({
      saldoTotal: '10.50',
      saldoDisponible: '10.50',
    });

    // RN-6: auditoría con reserva, conductor, monto y hash.
    const liberado = (await r.auditorias(p.reservaId)).find(
      (a) => a.accion === 'pago.liberado',
    );
    expect(liberado).toMatchObject({
      resultado: 'ok',
      actor_id: c.id,
      detalle: { conductorId: c.id, monto: '10.50', hashTx: hecho.hashTx },
    });
  });

  it('CA-2: la red guarda el hash de la prueba y coincide con el que se recalcula desde la BD', async () => {
    const v = await h.verificado(org);
    const p = v.s.pasajeros[0];
    await r.procesar();

    const [abordaje, bajada] = await h.pruebas(p.reservaId);
    const { rows } = await e.bd.query(
      `SELECT evaluacion FROM reservas WHERE id = $1`,
      [p.reservaId],
    );
    const recalculado = hashPruebaPresencia({
      reservaId: p.reservaId,
      hashAbordaje: abordaje.hash_prueba,
      hashBajada: bajada.hash_prueba,
      evaluacion: rows[0].evaluacion,
    });
    const escrow = await r.cadena().estadoReservaEscrow(id(p.reservaId));
    expect(escrow).toMatchObject({
      estado: 'liberada',
      hashPrueba: recalculado,
    });
  });

  it('CA-8: después del pago la conciliación no registra diferencias para el pasajero ni el conductor', async () => {
    const v = await h.verificado(org);
    const p = v.s.pasajeros[0];
    await r.procesar();
    await r.saldo(p).expect(200);
    await r.saldo(v.s.conductor).expect(200);

    const { rows } = await e.bd.query(
      `SELECT count(*)::int AS n FROM registros_auditoria a JOIN billeteras b ON b.id::text = a.entidad_id
       WHERE a.accion = 'billetera.conciliacion' AND b.usuario_id IN ($1, $2)`,
      [p.id, v.s.conductor.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('CA-10: con dos pasajeros el viaje pasa a pagado solo cuando se paga la última reserva', async () => {
    const v = await h.verificado(org, 2);
    const [p1, p2] = v.s.pasajeros;
    // La liberación del segundo espera: el primero se paga solo.
    await e.bd.query(
      `UPDATE trabajos_onchain SET proximo_intento_en = now() + interval '1 hour'
       WHERE movimiento_id IN (SELECT id FROM movimientos_billetera WHERE reserva_id = $1)`,
      [p2.reservaId],
    );
    await r.procesar();
    expect(await h.estadoReserva(p1.reservaId)).toBe('pagada');
    expect(await h.estadoViaje(v.s.viajeId)).toBe('verificado');

    await r.vencerEspera(p2.reservaId);
    await r.procesar();
    expect(await h.estadoReserva(p2.reservaId)).toBe('pagada');
    expect(await h.estadoViaje(v.s.viajeId)).toBe('pagado');
  });
});
