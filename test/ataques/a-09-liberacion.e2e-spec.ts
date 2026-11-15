import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasPresencia, traza } from '../presencia/ayudas-presencia.js';
import { rutasRegistradas } from './catalogo-rutas.js';

/** HU-24 · A-09: el pago se libera solo para reservas verificadas, una sola vez y sin perderse (CA-3, CA-4, CA-6). */
describe('A-09 · liberar sin viaje verificado o pagar dos veces (e2e)', () => {
  let e: Entorno;
  const h = ayudasPresencia(() => e);
  const r = h.r;
  let org: string;

  beforeAll(async () => {
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno();
    org = (await r.v.organizacion('Liberacion A09')).id;
  });
  beforeEach(() => r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  const liberaciones = async (reservaId: string) =>
    (await r.movimientosDeReserva(reservaId)).filter(
      (m) => m.tipo === 'liberacion_viaje',
    );
  const cobrado = (direccion: string) => r.cadena().leerSaldo(direccion);

  /** Lo que haría un error de código o alguien con acceso a la cola: encolar el pago de una reserva sin verificar. */
  const forzarLiberacion = async (reservaId: string, billeteraId: string) => {
    const { rows } = await e.bd.query(
      `INSERT INTO movimientos_billetera (billetera_id, tipo, monto, reserva_id, clave_idempotencia, metadatos)
       VALUES ($1, 'liberacion_viaje', 10.50, $2, $3, $4) RETURNING id`,
      [
        billeteraId,
        reservaId,
        `liberacion:${reservaId}`,
        { hashPrueba: `0x${'ab'.repeat(32)}` },
      ],
    );
    await e.bd.query(
      `INSERT INTO trabajos_onchain (movimiento_id, operacion) VALUES ($1, 'liberar_reserva')`,
      [rows[0].id],
    );
  };

  it('CA-3: no existe ninguna ruta para pedir una liberación', () => {
    const rutas = rutasRegistradas(e.app).map((x) => x.clave);
    expect(rutas.filter((x) => /liber|pag(o|ar)/i.test(x))).toEqual([]);
  });

  // Sin estado de cancelación hasta HU-20: `pendiente` y `fallida` (bloqueo rechazado) son las reservas que nunca viajaron.
  it('CA-3: pendiente, confirmada, abordada, fallida o con la verificación fallida no encolan pago; forzado, el worker lo rechaza', async () => {
    const v = await h.enViaje(org, 3);
    const [abordada, fallida, confirmada] = v.s.pasajeros;
    // Otro viaje: el del escenario no tiene cinco cupos.
    const otro = await h.enViaje(org, 2);
    const [pendiente, bloqueoFallido] = otro.s.pasajeros;
    // Con 3 puntos no alcanza la traza: verificación fallida (HU-23).
    await h.recorrer(v, 1, traza(3, { desplazamientoM: 20 }), traza(3));
    await h
      .bajar(fallida, fallida.reservaId, await h.codigoBajada(v.s, v.conductor))
      .expect(200);
    for (const [p, estado] of [
      [confirmada, 'confirmada'],
      [pendiente, 'pendiente'],
      [bloqueoFallido, 'fallida'],
    ] as const)
      await e.bd.query(`UPDATE reservas SET estado = $2 WHERE id = $1`, [
        p.reservaId,
        estado,
      ]);
    expect(await h.estadoReserva(fallida.reservaId)).toBe(
      'verificacion_fallida',
    );

    const todas = [abordada, fallida, confirmada, pendiente, bloqueoFallido];
    for (const p of todas) expect(await liberaciones(p.reservaId)).toEqual([]);

    for (const p of [abordada, fallida, confirmada])
      await forzarLiberacion(p.reservaId, v.s.conductor.billetera);
    for (const p of [pendiente, bloqueoFallido])
      await forzarLiberacion(p.reservaId, otro.s.conductor.billetera);
    await r.procesar();

    for (const p of todas) {
      expect(await liberaciones(p.reservaId)).toMatchObject([
        { estado: 'fallido', hash_tx: null, trabajo: 'terminado' },
      ]);
      expect((await r.auditorias(p.reservaId)).map((a) => a.accion)).toContain(
        'pago.rechazado',
      );
    }
    expect(r.cadena().liberaciones).toBe(0);
    expect(await cobrado(v.s.conductor.direccion)).toBe(0n);
    expect(await cobrado(otro.s.conductor.direccion)).toBe(0n);
  });

  it('CA-4: respuesta perdida: el reintento recupera el hash y el conductor cobra una vez', async () => {
    const v = await h.verificado(org);
    const p = v.s.pasajeros[0];
    r.cadena().perderRespuestaDeLiberacion = true;
    await r.procesar();
    expect(await liberaciones(p.reservaId)).toMatchObject([
      { estado: 'pendiente', intentos: 1 },
    ]);

    await r.vencerEspera(p.reservaId);
    await r.procesar();
    const [hecho] = await liberaciones(p.reservaId);
    expect(hecho).toMatchObject({ estado: 'confirmado', trabajo: 'terminado' });
    expect(r.cadena().liberaciones).toBe(1);
    expect(await cobrado(v.s.conductor.direccion)).toBe(105n * 10n ** 17n);
  });

  it('CA-4: dos workers a la vez: un solo movimiento y un solo pago', async () => {
    const v = await h.verificado(org);
    const p = v.s.pasajeros[0];
    await Promise.all([r.procesar(), r.procesar()]);
    await r.procesar();

    expect(await liberaciones(p.reservaId)).toMatchObject([
      { estado: 'confirmado' },
    ]);
    expect(r.cadena().liberaciones).toBe(1);
    expect(await cobrado(v.s.conductor.direccion)).toBe(105n * 10n ** 17n);
  });

  it('CA-6: con la red caída queda pendiente, alerta a los 5 intentos sin la URL del nodo y se paga al volver', async () => {
    const v = await h.verificado(org);
    const p = v.s.pasajeros[0];
    r.cadena().fallar = true;
    for (let i = 0; i < 5; i++) {
      await r.procesar();
      await r.vencerEspera(p.reservaId);
    }
    expect(await liberaciones(p.reservaId)).toMatchObject([
      { estado: 'pendiente', intentos: 5, ultimo_error: 'SERVER_ERROR' },
    ]);
    expect(
      (await r.reserva(p.token, p.reservaId).expect(200)).body.pago.estado,
    ).toBe('pendiente');
    const alerta = (await r.auditorias(p.reservaId)).filter(
      (a) => a.accion === 'pago.liberacion.atascada',
    );
    expect(alerta).toHaveLength(1);
    expect(JSON.stringify(alerta)).not.toContain('nodo.test');

    r.cadena().fallar = false;
    await r.procesar();
    expect(await h.estadoReserva(p.reservaId)).toBe('pagada');
  });
});
