import { createHash } from 'node:crypto';
import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import {
  A_60_M,
  ENCUENTRO,
  ayudasPresencia,
  posicion,
} from './ayudas-presencia.js';

/** HU-22: llave de trayecto del conductor, códigos rotativos y abordaje verificado (CA-1, CA-2, CA-11, CA-13, CA-14). */
describe('HU-22 · verificación de abordaje (e2e)', () => {
  let e: Entorno;
  const h = ayudasPresencia(() => e);
  let org: string;

  beforeAll(async () => {
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno();
    org = (await h.r.v.organizacion('Abordaje')).id;
  });
  beforeEach(() => h.r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  it('CA-1: con la llave de trayecto el conductor recibe un código de 30 s, sin huella, con sus pasajeros', async () => {
    const s = await h.escenario(org);
    const l = await h.llaveConductor(s);
    const antes = Date.now();
    const { body } = await h
      .desafio(s.conductor.token, s.viajeId, l)
      .expect(201);

    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.qrTexto).toBe(`uniride://encuentro/${body.nonce}`);
    expect(
      Buffer.from(body.qrImagenBase64, 'base64').subarray(1, 4).toString(),
    ).toBe('PNG');
    const vida = new Date(body.venceEn).getTime() - antes;
    expect(vida).toBeGreaterThan(29_000);
    expect(vida).toBeLessThanOrEqual(31_000);
    expect(body.pasajeros).toEqual([
      expect.objectContaining({
        reservaId: s.pasajeros[0].reservaId,
        estado: 'confirmada',
      }),
    ]);
    // Renovar: otro código distinto con la misma llave, sin otra firma biométrica.
    const otro = (await h.desafio(s.conductor.token, s.viajeId, l).expect(201))
      .body;
    expect(otro.nonce).not.toBe(body.nonce);
  });

  it('una llave nueva revoca la anterior: la vieja ya no emite códigos', async () => {
    const s = await h.escenario(org);
    const vieja = await h.llaveConductor(s);
    await h.llaveConductor(s);
    const res = await h
      .desafio(s.conductor.token, s.viajeId, vieja)
      .expect(401);
    expect(res.body.codigo).toBe('FIRMA_TRAYECTO_INVALIDA');
  });

  it('CA-11: fuera de la ventana no hay llave ni código, y se dice desde y hasta cuándo', async () => {
    const s = await h.escenario(org);
    const l = await h.llaveConductor(s);

    await h.moverSalida(s.viajeId, 31 * 60_000);
    const temprano = await h
      .registrarLlave(s.conductor, s.viajeId)
      .peticion.expect(409);
    expect(temprano.body).toMatchObject({ codigo: 'FUERA_DE_VENTANA' });
    const salida = new Date(temprano.body.desde).getTime() + 30 * 60_000;
    expect(new Date(temprano.body.hasta).getTime()).toBe(salida + 15 * 60_000);
    await h.desafio(s.conductor.token, s.viajeId, l).expect(409);

    await h.moverSalida(s.viajeId, -16 * 60_000);
    const tarde = await h.desafio(s.conductor.token, s.viajeId, l).expect(409);
    expect(tarde.body.codigo).toBe('FUERA_DE_VENTANA');
  });

  it('sin reservas confirmadas el conductor no registra llave', async () => {
    const conductor = await h.r.conductor(org);
    const viajeId = await h.r.publicar(conductor);
    await h.moverSalida(viajeId, 10 * 60_000);
    const res = await h.registrarLlave(conductor, viajeId).peticion.expect(409);
    expect(res.body.codigo).toBe('SIN_RESERVAS');
  });

  it('otro conductor no registra llave en un viaje ajeno: 404', async () => {
    const s = await h.escenario(org);
    const otro = await h.r.conductor(org);
    await h.registrarLlave(otro, s.viajeId).peticion.expect(404);
  });

  it('CA-2: a 10 m, con firma e integridad, la reserva queda abordada y el viaje en curso en menos de 3 s', async () => {
    const s = await h.escenario(org);
    const p = s.pasajeros[0];
    const nonce = await h.codigo(s, await h.llaveConductor(s));

    const inicio = performance.now();
    const { body } = await h.abordar(p, p.reservaId, nonce).expect(200);
    expect(performance.now() - inicio).toBeLessThan(3_000);

    expect(body).toEqual({ estado: 'abordada', yaVerificado: false });
    expect(await h.estadoReserva(p.reservaId)).toBe('abordada');
    expect(await h.estadoViaje(s.viajeId)).toBe('en_curso');
    const [prueba] = await h.pruebas(p.reservaId);
    expect(prueba).toMatchObject({
      resultado: 'aceptada',
      veredicto_integridad: 'SIMULADO',
      organizacion_id: org,
    });
    expect(prueba.distancia_m).toBeGreaterThan(9);
    expect(prueba.distancia_m).toBeLessThan(11);
    expect(prueba.hash_prueba).toMatch(/^[0-9a-f]{64}$/);
    // La llave de trayecto del pasajero queda para su reserva (HU-23 firma las posiciones con ella).
    const { rows } = await e.bd.query(
      `SELECT reserva_id, revocada_en FROM llaves_trayecto WHERE usuario_id = $1`,
      [p.id],
    );
    expect(rows).toEqual([{ reserva_id: p.reservaId, revocada_en: null }]);
  });

  it('hash_prueba es el SHA-256 de la prueba canónica (HU-24 lo recalcula)', async () => {
    const s = await h.escenario(org);
    const p = s.pasajeros[0];
    const nonce = await h.codigo(s, await h.llaveConductor(s));
    const tomadaEn = Date.now();
    const pos = {
      lat: -17.78342,
      lng: -63.182129,
      precisionM: 5,
      tomadaEn,
      simulada: false,
    };
    await h.abordar(p, p.reservaId, nonce, { posicion: pos }).expect(200);

    const { rows } = await e.bd.query(
      `SELECT d.conductor_lat, d.conductor_lng, d.conductor_tomada_en, p.distancia_m, p.hash_prueba
       FROM pruebas_presencia p JOIN desafios_handshake d ON d.id = p.desafio_id WHERE p.reserva_id = $1`,
      [p.reservaId],
    );
    const f = rows[0];
    const esperado = createHash('sha256')
      .update(
        JSON.stringify({
          reservaId: p.reservaId,
          tipo: 'abordaje',
          nonce,
          conductor: {
            lat: f.conductor_lat,
            lng: f.conductor_lng,
            tomadaEn: f.conductor_tomada_en.toISOString(),
          },
          pasajero: {
            lat: pos.lat,
            lng: pos.lng,
            tomadaEn: new Date(tomadaEn).toISOString(),
          },
          distanciaM: f.distancia_m,
          veredicto: 'SIMULADO',
        }),
      )
      .digest('hex');
    expect(f.hash_prueba).toBe(esperado);
  });

  it('RN-7: cada pasajero aborda con su propio código; el conductor los ve abordados', async () => {
    const s = await h.escenario(org, 2);
    const l = await h.llaveConductor(s);
    for (const p of s.pasajeros)
      await h.abordar(p, p.reservaId, await h.codigo(s, l)).expect(200);
    expect(await h.estadoViaje(s.viajeId)).toBe('en_curso');
    const { body } = await h
      .desafio(s.conductor.token, s.viajeId, l)
      .expect(201);
    expect(body.pasajeros.map((x: { estado: string }) => x.estado)).toEqual([
      'abordada',
      'abordada',
    ]);
  });

  it('CA-14: escanear de nuevo ya abordada responde «ya verificado» sin otra prueba', async () => {
    const s = await h.escenario(org);
    const p = s.pasajeros[0];
    const l = await h.llaveConductor(s);
    await h.abordar(p, p.reservaId, await h.codigo(s, l)).expect(200);
    const { body } = await h
      .abordar(p, p.reservaId, await h.codigo(s, l))
      .expect(200);
    expect(body).toEqual({ estado: 'abordada', yaVerificado: true });
    expect(await h.pruebas(p.reservaId)).toHaveLength(1);
  });

  it('CA-13: un intento rechazado queda registrado con reserva, distancia y motivo, y en auditoría', async () => {
    const s = await h.escenario(org);
    const p = s.pasajeros[0];
    const nonce = await h.codigo(s, await h.llaveConductor(s));
    await h
      .abordar(p, p.reservaId, nonce, {
        posicion: posicion({ lat: ENCUENTRO.lat + A_60_M }),
      })
      .expect(422);

    const [prueba] = await h.pruebas(p.reservaId);
    expect(prueba).toMatchObject({
      resultado: 'rechazada',
      motivo: 'distancia',
      hash_prueba: null,
    });
    expect(prueba.desafio_id).not.toBeNull();
    expect(prueba.distancia_m).toBeGreaterThan(55);
    const { rows } = await e.bd.query(
      `SELECT resultado, detalle FROM registros_auditoria WHERE accion = 'reserva.abordaje' AND entidad_id = $1`,
      [p.reservaId],
    );
    expect(rows).toEqual([
      { resultado: 'fallo', detalle: { motivo: 'distancia' } },
    ]);
    expect(await h.estadoReserva(p.reservaId)).toBe('confirmada');
  });
});
