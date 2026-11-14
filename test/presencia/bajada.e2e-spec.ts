import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasPresencia, posicion, traza } from './ayudas-presencia.js';

/** HU-23: bajada con el encuentro de HU-22 y evaluación del trayecto (CA-3, CA-4, CA-10, CA-11, CA-13, CA-15). */
describe('HU-23 · bajada y verificación del viaje (e2e)', () => {
  let e: Entorno;
  const h = ayudasPresencia(() => e);
  let org: string;

  beforeAll(async () => {
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno();
    org = (await h.r.v.organizacion('Bajada')).id;
  });
  beforeEach(() => h.r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  type Viaje = Awaited<ReturnType<typeof h.enViaje>>;
  /** Las dos trazas por la API, como las envían las apps (20 puntos, 5 min, a 20 m). */
  const recorrer = async (
    v: Viaje,
    i = 0,
    pasajero = traza(20, { desplazamientoM: 20 }),
    conductor = traza(20),
  ) => {
    const p = v.s.pasajeros[i];
    await h
      .posiciones(
        v.s.conductor.token,
        h.rutaConductor(v.s.viajeId),
        v.conductor,
        conductor,
      )
      .expect(202);
    await h
      .posiciones(
        p.token,
        h.rutaPasajero(p.reservaId),
        v.pasajeros[i],
        pasajero,
      )
      .expect(202);
  };
  const evaluacion = async (reservaId: string) =>
    (
      await e.bd.query(
        `SELECT estado, evaluacion FROM reservas WHERE id = $1`,
        [reservaId],
      )
    ).rows[0];
  const auditoria = async (accion: string, reservaId: string) =>
    (
      await e.bd.query(
        `SELECT resultado, detalle FROM registros_auditoria WHERE accion = $1 AND entidad_id = $2`,
        [accion, reservaId],
      )
    ).rows;

  it('CA-4, CA-13, CA-15: viajaron juntos → reserva verificada, viaje verificado y la evaluación registrada, en < 3 s', async () => {
    const v = await h.enViaje(org);
    const p = v.s.pasajeros[0];
    await recorrer(v);
    const trabajos = (
      await e.bd.query(`SELECT count(*)::int AS n FROM trabajos_onchain`)
    ).rows[0].n;

    const inicio = performance.now();
    const { body } = await h
      .bajar(p, p.reservaId, await h.codigoBajada(v.s, v.conductor))
      .expect(200);
    expect(performance.now() - inicio).toBeLessThan(3_000);

    expect(body).toEqual({
      estado: 'verificada',
      motivo: null,
      yaVerificado: false,
    });
    expect(await h.estadoViaje(v.s.viajeId)).toBe('verificado');
    const r = await evaluacion(p.reservaId);
    expect(r.estado).toBe('verificada');
    expect(r.evaluacion).toEqual({
      resultado: 'verificada',
      motivo: null,
      puntosPasajero: 20,
      pares: 20,
      coincidentes: 20,
      coincidenciaPct: 100,
      velocidadMaximaKmh: 30,
    });
    const [ok] = await auditoria('reserva.bajada', p.reservaId);
    expect(ok.resultado).toBe('ok');
    expect(ok.detalle).toMatchObject({
      coincidenciaPct: 100,
      velocidadMaximaKmh: 30,
      resultado: 'verificada',
    });
    // RN-8: sin coordenadas en la auditoría.
    expect(JSON.stringify(ok.detalle)).not.toMatch(/lat|lng/);
    const pruebas = await h.pruebas(p.reservaId);
    expect(pruebas.map((x) => x.resultado)).toEqual(['aceptada', 'aceptada']);
    expect(pruebas[1].hash_prueba).toMatch(/^[0-9a-f]{64}$/);
    expect(pruebas[1].hash_prueba).not.toBe(pruebas[0].hash_prueba);
    // El pago lo libera HU-24: aquí no se encola nada.
    expect(
      (await e.bd.query(`SELECT count(*)::int AS n FROM trabajos_onchain`))
        .rows[0].n,
    ).toBe(trabajos);
  });

  it('CA-3: la bajada repetida responde su resultado sin otra prueba ni otra evaluación', async () => {
    const v = await h.enViaje(org);
    const p = v.s.pasajeros[0];
    await recorrer(v);
    const nonce = await h.codigoBajada(v.s, v.conductor);
    await h.bajar(p, p.reservaId, nonce).expect(200);
    // Se perdió la respuesta y la app reintenta con el mismo código (el viaje ya está verificado: no hay otro).
    const { body } = await h.bajar(p, p.reservaId, nonce).expect(200);
    expect(body).toEqual({
      estado: 'verificada',
      motivo: null,
      yaVerificado: true,
    });
    expect(await h.pruebas(p.reservaId)).toHaveLength(2);
    expect(await auditoria('reserva.bajada', p.reservaId)).toHaveLength(1);
  });

  it('CA-3: sin abordar, la bajada responde RESERVA_NO_ABORDADA y no cambia nada', async () => {
    const v = await h.enViaje(org, 2);
    // El segundo pasajero no abordó: se deshace en la base para tener una reserva confirmada en un viaje en curso.
    const p = v.s.pasajeros[1];
    await e.bd.query(
      `UPDATE reservas SET estado = 'confirmada' WHERE id = $1`,
      [p.reservaId],
    );
    const res = await h
      .bajar(p, p.reservaId, await h.codigoBajada(v.s, v.conductor))
      .expect(409);
    expect(res.body).toMatchObject({
      codigo: 'RESERVA_NO_ABORDADA',
      mensaje: 'Esta reserva no está en viaje: primero confirma el abordaje.',
    });
    expect(await h.estadoReserva(p.reservaId)).toBe('confirmada');
  });

  it('CA-3: el código de bajada solo con el viaje en curso, y sin ventana horaria (RN-7)', async () => {
    const s = await h.escenario(org);
    const l = await h.llaveConductor(s);
    const antes = await h
      .desafio(s.conductor.token, s.viajeId, l, {
        tipo: 'bajada',
        posicion: posicion(),
      })
      .expect(409);
    expect(antes.body.codigo).toBe('VIAJE_NO_EN_CURSO');

    const v = await h.enViaje(org);
    // Dos horas después de la salida: el abordaje estaría fuera de ventana, la bajada no.
    await h.moverSalida(v.s.viajeId, -2 * 60 * 60_000);
    await h.codigoBajada(v.s, v.conductor);
  });

  it('CA-10, CA-11: con menos de 4 pares queda verificación fallida, con alerta y el pago en garantía', async () => {
    const v = await h.enViaje(org);
    const p = v.s.pasajeros[0];
    await recorrer(v, 0, traza(3, { desplazamientoM: 20 }), traza(3));
    const { body } = await h
      .bajar(p, p.reservaId, await h.codigoBajada(v.s, v.conductor))
      .expect(200);
    expect(body).toEqual({
      estado: 'verificacion_fallida',
      motivo: 'datos_insuficientes',
      yaVerificado: false,
    });
    expect((await evaluacion(p.reservaId)).evaluacion).toMatchObject({
      pares: 3,
    });
    const [alerta] = await auditoria(
      'presencia.verificacion_fallida',
      p.reservaId,
    );
    expect(alerta).toMatchObject({
      resultado: 'fallo',
      detalle: expect.objectContaining({ motivo: 'datos_insuficientes' }),
    });
    // D-24: el viaje no pasa a verificado con una fallida.
    expect(await h.estadoViaje(v.s.viajeId)).toBe('en_curso');
  });

  it('CA-13, RN-9: con dos pasajeros, el viaje se verifica con la última bajada, y cada uno tiene su evaluación', async () => {
    const v = await h.enViaje(org, 2);
    const [p1, p2] = v.s.pasajeros;
    await recorrer(v, 0);
    await h
      .posiciones(
        p2.token,
        h.rutaPasajero(p2.reservaId),
        v.pasajeros[1],
        traza(20, { desplazamientoM: 30 }),
      )
      .expect(202);

    await h
      .bajar(p1, p1.reservaId, await h.codigoBajada(v.s, v.conductor))
      .expect(200);
    expect(await h.estadoViaje(v.s.viajeId)).toBe('en_curso');
    const { body } = await h
      .bajar(p2, p2.reservaId, await h.codigoBajada(v.s, v.conductor))
      .expect(200);
    expect(body.estado).toBe('verificada');
    expect(await h.estadoViaje(v.s.viajeId)).toBe('verificado');
  });

  it('RN-9: la fallida de un pasajero no impide que el otro se verifique', async () => {
    const v = await h.enViaje(org, 2);
    const [p1, p2] = v.s.pasajeros;
    await recorrer(v, 0);
    await h
      .bajar(p2, p2.reservaId, await h.codigoBajada(v.s, v.conductor))
      .expect(200);
    const { body } = await h
      .bajar(p1, p1.reservaId, await h.codigoBajada(v.s, v.conductor))
      .expect(200);
    expect(body.estado).toBe('verificada');
    expect(await h.estadoReserva(p2.reservaId)).toBe('verificacion_fallida');
  });

  it('dos bajadas simultáneas del mismo pasajero: una sola evaluación', async () => {
    const v = await h.enViaje(org);
    const p = v.s.pasajeros[0];
    await recorrer(v);
    const [c1, c2] = [
      await h.codigoBajada(v.s, v.conductor),
      await h.codigoBajada(v.s, v.conductor),
    ];
    const respuestas = await Promise.all([
      h.bajar(p, p.reservaId, c1),
      h.bajar(p, p.reservaId, c2),
    ]);
    expect(respuestas.map((r) => r.status)).toEqual([200, 200]);
    expect(respuestas.map((r) => r.body.yaVerificado).sort()).toEqual([
      false,
      true,
    ]);
    expect(await auditoria('reserva.bajada', p.reservaId)).toHaveLength(1);
    expect(
      (await h.pruebas(p.reservaId)).filter((x) => x.resultado === 'aceptada'),
    ).toHaveLength(2);
  });
});
