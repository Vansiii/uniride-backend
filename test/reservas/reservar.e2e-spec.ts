import { randomUUID } from 'node:crypto';
import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { RUTA_MOVIMIENTOS } from '../billetera/ayudas-billetera.js';
import {
  cuerpoViaje,
  enMs,
  HORA_MS,
  type Conductor,
} from '../viajes/ayudas-viajes.js';
import { ayudasReservas, rutaReservar } from './ayudas-reservas.js';

/** HU-19: reservar un asiento y dejar el pasaje en garantía, con la cadena simulada y el worker de la cola. */
describe('HU-19 · reservar con escrow (e2e)', () => {
  let e: Entorno;
  const r = ayudasReservas(() => e);
  let org: string;

  beforeAll(async () => {
    e = await prepararEntorno();
    org = (await r.v.organizacion('Reservas')).id;
  });
  beforeEach(() => r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  /** Un viaje de 10,50 URC con 3 asientos y un pasajero con 50. */
  const escenario = async (saldo = '50.00', extra: object = {}) => {
    const c = await r.conductor(org);
    const viajeId = await r.publicar(c, extra);
    const p = await r.pasajero(org, saldo);
    return { c, viajeId, p };
  };

  describe('CA-1 · reservar y pagar', () => {
    it('crea la reserva pendiente con el asiento retenido, sin esperar a la cadena', async () => {
      const { viajeId, p } = await escenario();
      const res = await r.reservar(p, viajeId).expect(201);
      expect(res.body).toEqual({
        reservaId: expect.any(String),
        estado: 'pendiente',
        monto: '10.50',
        viajeId,
      });
      expect((await r.viaje(viajeId)).cupos_disponibles).toBe(2);
      expect(r.cadena().intentosDeBloqueo).toBe(0);
      const [mov] = await r.movimientosDeReserva(res.body.reservaId);
      expect(mov).toMatchObject({
        tipo: 'bloqueo_reserva',
        estado: 'pendiente',
        monto: '10.50',
        trabajo: 'pendiente',
      });
      expect((await r.auditorias(res.body.reservaId))[0]).toMatchObject({
        accion: 'reserva.creada',
        resultado: 'ok',
        actor_id: p.id,
      });
    });

    it('al procesar la cola el pasaje queda en garantía: reserva confirmada, viaje reservado y saldo movido', async () => {
      const { viajeId, p } = await escenario();
      const { reservaId } = (await r.reservar(p, viajeId).expect(201)).body;
      expect(await r.procesar()).toBe(1);

      const [fila] = await r.filasReserva(viajeId);
      expect(fila).toMatchObject({ id: reservaId, estado: 'confirmada' });
      expect((await r.viaje(viajeId)).estado).toBe('reservado');
      const [mov] = await r.movimientosDeReserva(reservaId);
      expect(mov).toMatchObject({
        estado: 'confirmado',
        trabajo: 'terminado',
      });
      expect(mov.hash_tx).toMatch(/^0x[0-9a-f]{64}$/);

      const saldo = (await r.saldo(p).expect(200)).body;
      expect(saldo).toMatchObject({
        saldoTotal: '50.00',
        saldoDisponible: '39.50',
        saldoBloqueadoEscrow: '10.50',
      });
      const historial = (
        await r.b.movimientos(p.token, { tipo: 'bloqueo_reserva' }).expect(200)
      ).body;
      expect(historial.items[0]).toMatchObject({
        tipo: 'bloqueo_reserva',
        monto: '10.50',
        estado: 'confirmado',
        hashTx: mov.hash_tx,
      });
      const auditoria = (await r.auditorias(reservaId)).map((a) => a.accion);
      expect(auditoria).toEqual(['reserva.creada', 'reserva.confirmada']);
    });

    it('mientras está pendiente el movimiento se ve Pendiente en el historial', async () => {
      const { viajeId, p } = await escenario();
      await r.reservar(p, viajeId).expect(201);
      const { body } = await e
        .api()
        .get(RUTA_MOVIMIENTOS)
        .set(r.b.conToken(p.token))
        .query({ tipo: 'bloqueo_reserva' })
        .expect(200);
      expect(body.items[0]).toMatchObject({
        estado: 'pendiente',
        hashTx: null,
      });
    });

    it('un reintento tras confirmar devuelve la reserva confirmada con la misma clave', async () => {
      const { viajeId, p } = await escenario();
      const clave = randomUUID();
      const { body } = await r.reservar(p, viajeId, clave).expect(201);
      await r.procesar();
      const repetida = await r.reservar(p, viajeId, clave).expect(200);
      expect(repetida.body).toMatchObject({
        reservaId: body.reservaId,
        estado: 'confirmada',
      });
    });
  });

  describe('CA-2 y RN-4 · saldo', () => {
    it('con saldo menor al precio responde SALDO_INSUFICIENTE con el faltante y no toca el asiento', async () => {
      const { viajeId, p } = await escenario('5.00');
      const res = await r.reservar(p, viajeId).expect(409);
      expect(res.body).toMatchObject({
        codigo: 'SALDO_INSUFICIENTE',
        faltante: '5.50',
      });
      expect(await r.huella(p.id)).toEqual({ reservas: 0, bloqueos: 0 });
      expect((await r.viaje(viajeId)).cupos_disponibles).toBe(3);
    });

    it('sin nada de saldo el faltante es el precio completo', async () => {
      const { viajeId, p } = await escenario('0.00');
      const res = await r.reservar(p, viajeId).expect(409);
      expect(res.body.faltante).toBe('10.50');
    });

    it('un bloqueo todavía pendiente ya resta del saldo disponible (RN-4)', async () => {
      const { c, viajeId, p } = await escenario('15.00');
      const otro = await r.publicar(c, { fechaHoraSalida: enMs(8 * HORA_MS) });
      await r.reservar(p, viajeId).expect(201);
      // El primer bloqueo sigue en la cola: el libro aún no lo restó, pero no se puede gastar dos veces.
      const res = await r.reservar(p, otro).expect(409);
      expect(res.body).toMatchObject({
        codigo: 'SALDO_INSUFICIENTE',
        faltante: '6.00',
      });
    });

    it('tras recargar, la misma reserva sale bien', async () => {
      const { viajeId, p } = await escenario('5.00');
      await r.reservar(p, viajeId).expect(409);
      await r.fondear(p, '10.00');
      await r.reservar(p, viajeId).expect(201);
    });
  });

  describe('reglas del viaje', () => {
    it('CA-9: el conductor no reserva su propio viaje', async () => {
      const { c, viajeId } = await escenario();
      await r.fondear(c, '50.00');
      const res = await r.reservar(c, viajeId).expect(409);
      expect(res.body.codigo).toBe('VIAJE_PROPIO');
      expect(await r.huella(c.id)).toEqual({ reservas: 0, bloqueos: 0 });
    });

    it('CA-10: una segunda reserva en el mismo viaje se rechaza', async () => {
      const { viajeId, p } = await escenario();
      await r.reservar(p, viajeId).expect(201);
      const res = await r.reservar(p, viajeId).expect(409);
      expect(res.body.codigo).toBe('YA_RESERVADO');
      expect(await r.huella(p.id)).toEqual({ reservas: 1, bloqueos: 1 });
      expect((await r.viaje(viajeId)).cupos_disponibles).toBe(2);
    });

    it.each([
      ['cancelado', `UPDATE viajes SET estado = 'cancelado' WHERE id = $1`],
      ['en curso', `UPDATE viajes SET estado = 'en_curso' WHERE id = $1`],
      ['pagado', `UPDATE viajes SET estado = 'pagado' WHERE id = $1`],
      [
        'con la salida ya pasada',
        `UPDATE viajes SET fecha_hora_salida = now() - interval '1 minute' WHERE id = $1`,
      ],
      [
        'con un precio que no es múltiplo de 0,02 (RN-11)',
        `UPDATE viajes SET precio_por_asiento = 10.51 WHERE id = $1`,
      ],
      [
        'de un conductor suspendido (RN-13)',
        `UPDATE usuarios SET suspendida_en = now() WHERE id = (SELECT conductor_id FROM viajes WHERE id = $1)`,
      ],
    ])('CA-11: un viaje %s ya no admite reservas', async (_, sql) => {
      const { viajeId, p } = await escenario();
      await e.bd.query(sql, [viajeId]);
      const res = await r.reservar(p, viajeId).expect(409);
      expect(res.body.codigo).toBe('VIAJE_NO_DISPONIBLE');
      expect(await r.huella(p.id)).toEqual({ reservas: 0, bloqueos: 0 });
      expect((await r.viaje(viajeId)).cupos_disponibles).toBe(3);
    });

    it('un viaje sin asientos libres responde SIN_ASIENTOS', async () => {
      const { viajeId, p } = await escenario();
      await e.bd.query(
        `UPDATE viajes SET cupos_disponibles = 0 WHERE id = $1`,
        [viajeId],
      );
      const res = await r.reservar(p, viajeId).expect(409);
      expect(res.body.codigo).toBe('SIN_ASIENTOS');
      expect(await r.huella(p.id)).toEqual({ reservas: 0, bloqueos: 0 });
    });

    it('un conductor sin billetera no puede cobrar: CONDUCTOR_SIN_BILLETERA', async () => {
      const { viajeId, p, c } = await escenario();
      await e.bd.query(`DELETE FROM billeteras WHERE usuario_id = $1`, [c.id]);
      const res = await r.reservar(p, viajeId).expect(409);
      expect(res.body.codigo).toBe('CONDUCTOR_SIN_BILLETERA');
    });

    it('RN-5: sin billetera, identidad verificada o con la cuenta suspendida no se reserva', async () => {
      const { viajeId } = await escenario();
      const sinBilletera = await r.v.conductor(org, { vehiculo: false });
      expect(
        (await r.reservar(sinBilletera, viajeId).expect(404)).body.codigo,
      ).toBe('BILLETERA_NO_ENCONTRADA');
      const sinIdentidad = await r.v.conductor(org, {
        vehiculo: false,
        identidad: 'no_verificada',
      });
      expect(
        (await r.reservar(sinIdentidad, viajeId).expect(403)).body.codigo,
      ).toBe('IDENTIDAD_NO_VERIFICADA');
      const suspendida = await r.pasajero(org);
      await e.bd.query(
        `UPDATE usuarios SET suspendida_en = now() WHERE id = $1`,
        [suspendida.id],
      );
      expect(
        (await r.reservar(suspendida, viajeId).expect(403)).body.codigo,
      ).toBe('CUENTA_SUSPENDIDA');
      const pendiente = await r.v.conductor(org, {
        vehiculo: false,
        membresia: 'pendiente',
      });
      await r.reservar(pendiente, viajeId).expect(403);
    });

    it('una clave de idempotencia que no es un UUID se rechaza', async () => {
      const { viajeId, p } = await escenario();
      await r.reservar(p, viajeId, 'no-es-uuid').expect(400);
      expect(await r.huella(p.id)).toEqual({ reservas: 0, bloqueos: 0 });
    });

    it('la misma clave en otro viaje o con otra persona es un conflicto, no la reserva ajena', async () => {
      const { c, viajeId, p } = await escenario();
      const otroViaje = await r.publicar(c, {
        fechaHoraSalida: enMs(8 * HORA_MS),
      });
      const clave = randomUUID();
      await r.reservar(p, viajeId, clave).expect(201);
      const alOtroViaje = await r.reservar(p, otroViaje, clave).expect(409);
      expect(alOtroViaje.body.codigo).toBe('CLAVE_IDEMPOTENCIA_EN_CONFLICTO');
      const q = await r.pasajero(org);
      const deOtro = await r.reservar(q, viajeId, clave).expect(409);
      expect(deOtro.body.codigo).toBe('CLAVE_IDEMPOTENCIA_EN_CONFLICTO');
      expect(await r.huella(q.id)).toEqual({ reservas: 0, bloqueos: 0 });
    });
  });

  describe('CA-12 · la red blockchain', () => {
    it('con el nodo caído la reserva queda pendiente con el asiento retenido y se reintenta sola', async () => {
      const { viajeId, p } = await escenario();
      r.cadena().fallar = true;
      const { reservaId } = (await r.reservar(p, viajeId).expect(201)).body;
      expect(await r.procesar()).toBe(0);

      expect((await r.filasReserva(viajeId))[0].estado).toBe('pendiente');
      expect((await r.viaje(viajeId)).cupos_disponibles).toBe(2);
      const [mov] = await r.movimientosDeReserva(reservaId);
      expect(mov).toMatchObject({
        estado: 'pendiente',
        trabajo: 'pendiente',
        intentos: 1,
      });
      expect(
        (await r.reserva(p.token, reservaId).expect(200)).body.estado,
      ).toBe('pendiente');

      r.cadena().fallar = false;
      await r.vencerEspera(reservaId);
      expect(await r.procesar()).toBe(1);
      expect((await r.filasReserva(viajeId))[0].estado).toBe('confirmada');
      expect(r.cadena().saldos.get(p.direccion)).toBe(3950n * 10n ** 16n);
    });

    it('si el nodo bloqueó pero la respuesta se perdió, el reintento recupera el hash sin bloquear dos veces', async () => {
      const { viajeId, p } = await escenario();
      r.cadena().perderRespuestaDeBloqueo = true;
      const { reservaId } = (await r.reservar(p, viajeId).expect(201)).body;
      expect(await r.procesar()).toBe(0);
      await r.vencerEspera(reservaId);
      expect(await r.procesar()).toBe(1);

      expect(r.cadena().intentosDeBloqueo).toBe(1);
      expect((await r.filasReserva(viajeId))[0].estado).toBe('confirmada');
      const [mov] = await r.movimientosDeReserva(reservaId);
      expect(mov.hash_tx).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r.cadena().saldos.get(p.direccion)).toBe(3950n * 10n ** 16n);
    });

    it('si el bloqueo es imposible la reserva no se completa, el asiento se libera y no se descuenta nada', async () => {
      const { viajeId, p } = await escenario('0.00');
      // El libro dice 50 URC pero la cadena no los tiene: el contrato revertiría por saldo insuficiente.
      await r.b.asiento(p.billetera, { monto: '50.00' });
      const { reservaId } = (await r.reservar(p, viajeId).expect(201)).body;
      expect((await r.viaje(viajeId)).cupos_disponibles).toBe(2);
      expect(await r.procesar()).toBe(1);

      const [fila] = await r.filasReserva(viajeId);
      expect(fila).toMatchObject({
        estado: 'fallida',
        motivo: 'ERC20InsufficientBalance',
      });
      const viaje = await r.viaje(viajeId);
      expect(viaje).toMatchObject({
        estado: 'publicado',
        cupos_disponibles: 3,
      });
      const [mov] = await r.movimientosDeReserva(reservaId);
      expect(mov).toMatchObject({ estado: 'fallido', trabajo: 'terminado' });
      expect(mov.hash_tx).toBeNull();
      expect(
        (await r.reserva(p.token, reservaId).expect(200)).body.estado,
      ).toBe('fallida');
      expect((await r.auditorias(reservaId)).map((a) => a.accion)).toEqual([
        'reserva.creada',
        'reserva.fallida',
      ]);
      // El pasajero no pierde nada y puede volver a intentar (la fallida no cuenta como reserva activa).
      expect((await r.saldo(p).expect(200)).body.saldoBloqueadoEscrow).toBe(
        '0.00',
      );
      await r.reservar(p, viajeId).expect(201);
    });

    it('un trabajo repetido no cambia nada: la cola no deja dos reservas bloqueadas', async () => {
      const { viajeId, p } = await escenario();
      await r.reservar(p, viajeId).expect(201);
      expect(await r.procesar()).toBe(1);
      expect(await r.procesar()).toBe(0);
      expect(r.cadena().intentosDeBloqueo).toBe(1);
    });
  });

  describe('CA-13 · el viaje reservado en la búsqueda', () => {
    const consulta = (salida: string) => ({
      origenLat: cuerpoViaje().origenLat,
      origenLng: cuerpoViaje().origenLng,
      horaSalida: salida,
    });
    const ids = (res: { body: { id: string }[] }) => res.body.map((x) => x.id);

    it('pasa a reservado y sigue apareciendo mientras tenga asientos libres', async () => {
      const salida = enMs(3 * HORA_MS);
      const { viajeId, p } = await escenario('50.00', {
        fechaHoraSalida: salida,
      });
      await r.reservar(p, viajeId).expect(201);
      await r.procesar();
      expect((await r.viaje(viajeId)).estado).toBe('reservado');
      const otro = await r.pasajero(org);
      expect(
        ids(await r.v.buscar(otro.token, consulta(salida)).expect(200)),
      ).toContain(viajeId);
    });

    it('al llenarse deja de aparecer', async () => {
      const salida = enMs(3 * HORA_MS);
      const { viajeId, p } = await escenario('50.00', {
        fechaHoraSalida: salida,
        cuposTotales: 1,
      });
      await r.reservar(p, viajeId).expect(201);
      await r.procesar();
      const otro = await r.pasajero(org);
      expect(
        ids(await r.v.buscar(otro.token, consulta(salida)).expect(200)),
      ).not.toContain(viajeId);
    });
  });

  describe('CA-14 · mis viajes y pasajeros', () => {
    it('el pasajero ve su reserva con estado, monto y datos del viaje; el conductor, su lista de pasajeros', async () => {
      const { c, viajeId, p } = await escenario();
      const { reservaId } = (await r.reservar(p, viajeId).expect(201)).body;
      await r.procesar();

      const mias = (await r.mias(p.token).expect(200)).body.reservas;
      expect(mias).toHaveLength(1);
      expect(mias[0]).toMatchObject({
        reservaId,
        estado: 'confirmada',
        monto: '10.50',
        viaje: {
          id: viajeId,
          origenNombre: 'Plaza 24 de Septiembre',
          destinoNombre: 'UAGRM, Módulos',
          estado: 'reservado',
          conductor: 'Prueba',
        },
      });

      const detalle = (await r.reserva(p.token, reservaId).expect(200)).body;
      expect(detalle).toMatchObject({ reservaId, estado: 'confirmada' });
      expect(detalle.hashTx).toMatch(/^0x[0-9a-f]{64}$/);

      const lista = (await r.pasajeros(c.token, viajeId).expect(200)).body;
      // Nombre de pila y estado: ni correo, ni documento, ni id de la persona (RN-9).
      expect(lista).toEqual([
        { reservaId, nombre: 'Prueba', estado: 'confirmada' },
      ]);
    });

    it('el conductor ve la reserva de su viaje, pero no la transacción del libro del pasajero', async () => {
      const { c, viajeId, p } = await escenario();
      const { reservaId } = (await r.reservar(p, viajeId).expect(201)).body;
      await r.procesar();
      const vista = (await r.reserva(c.token, reservaId).expect(200)).body;
      expect(vista).toMatchObject({ reservaId, estado: 'confirmada' });
      expect(vista.hashTx).toBeNull();
    });

    it('«mias» pone las activas primero y muestra la que no se completó', async () => {
      const { c, viajeId, p } = await escenario('0.00');
      await r.b.asiento(p.billetera, { monto: '50.00' });
      const fallida = (await r.reservar(p, viajeId).expect(201)).body.reservaId;
      await r.procesar();
      const otro = await r.publicar(c, { fechaHoraSalida: enMs(8 * HORA_MS) });
      await r.fondear(p, '50.00');
      const activa = (await r.reservar(p, otro).expect(201)).body.reservaId;
      const mias = (await r.mias(p.token).expect(200)).body.reservas;
      expect(mias.map((x: { reservaId: string }) => x.reservaId)).toEqual([
        activa,
        fallida,
      ]);
    });

    it('una reserva que no se completó no aparece entre los pasajeros del conductor', async () => {
      const { c, viajeId, p } = await escenario('0.00');
      await r.b.asiento(p.billetera, { monto: '50.00' });
      await r.reservar(p, viajeId).expect(201);
      await r.procesar();
      expect((await r.pasajeros(c.token, viajeId).expect(200)).body).toEqual(
        [],
      );
    });

    it('solo el conductor del viaje ve a los pasajeros: otro miembro recibe 404', async () => {
      const { viajeId, p } = await escenario();
      await r.reservar(p, viajeId).expect(201);
      const otro: Conductor = await r.v.conductor(org);
      expect(
        (await r.pasajeros(otro.token, viajeId).expect(404)).body.codigo,
      ).toBe('VIAJE_NO_ENCONTRADO');
      await r.pasajeros(p.token, viajeId).expect(404);
    });

    it('un tercero no ve la reserva de otros: 404', async () => {
      const { viajeId, p } = await escenario();
      const { reservaId } = (await r.reservar(p, viajeId).expect(201)).body;
      const ajeno = await r.pasajero(org);
      await r.reserva(ajeno.token, reservaId).expect(404);
      await r.reserva(p.token, randomUUID()).expect(404);
      await r.reserva(p.token, 'no-es-uuid').expect(400);
    });
  });

  it('la ruta de reservar vive bajo el viaje y exige UUID', async () => {
    const { p } = await escenario();
    await r.reservar(p, 'no-es-uuid').expect(400);
    expect(rutaReservar('x')).toBe('/api/v1/viajes/x/reservas');
  });
});
