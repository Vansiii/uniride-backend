import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import {
  ENCUENTRO,
  ayudasPresencia,
  posicion,
} from '../presencia/ayudas-presencia.js';

describe('A-08 · distancia del conductor sin sesión válida o sin membresía (e2e)', () => {
  let e: Entorno;
  const h = ayudasPresencia(() => e);
  let org: string;

  beforeAll(async () => {
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno();
    org = (await h.r.v.organizacion('A08 Distancia')).id;
  });
  beforeEach(() => h.r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  it('sin cabecera Authorization responde 401', async () => {
    const s = await h.escenario(org);
    const p = s.pasajeros[0];

    const res = await e
      .api()
      .get(`/api/v1/reservas/${p.reservaId}/conductor`)
      .set('X-Organizacion-Id', org)
      .expect(401);

    expect(res.body.codigo).toBe('NO_AUTENTICADO');
  });

  it('con token inválido responde 401', async () => {
    const s = await h.escenario(org);
    const p = s.pasajeros[0];

    const res = await e
      .api()
      .get(`/api/v1/reservas/${p.reservaId}/conductor`)
      .set('Authorization', 'Bearer token_invalido_totalmente')
      .set('X-Organizacion-Id', org)
      .expect(401);

    expect(res.body.codigo).toBe('NO_AUTENTICADO');
  });

  it('persona sin membresía aprobada en la organización responde 403', async () => {
    const s = await h.escenario(org);
    const p = s.pasajeros[0];

    // Su membresía deja de estar aprobada: el token sigue vigente, pero ya no pertenece a la organización.
    await e.bd.query(
      `UPDATE membresias SET estado = 'rechazada' WHERE usuario_id = $1`,
      [p.id],
    );

    const res = await e
      .api()
      .get(`/api/v1/reservas/${p.reservaId}/conductor`)
      .set(h.r.b.conToken(p.token))
      .expect(403);

    expect(res.body.codigo).toBe('NO_AUTORIZADO');
  });

  it('con sesión válida solo responde distancia redondeada y nunca coordenadas (RN-6)', async () => {
    const s = await h.escenario(org);
    const l = await h.llaveConductor(s);
    const p = s.pasajeros[0];

    await h
      .desafio(s.conductor.token, s.viajeId, l, {
        tipo: 'abordaje',
        posicion: posicion({ lat: ENCUENTRO.lat + 0.0018 }),
      })
      .expect(201);

    const { body } = await e
      .api()
      .get(`/api/v1/reservas/${p.reservaId}/conductor`)
      .set(h.r.b.conToken(p.token))
      .expect(200);

    expect(body.disponible).toBe(true);
    expect(body.distanciaM).toBeDefined();
    expect(body.lat).toBeUndefined();
    expect(body.lng).toBeUndefined();
    expect(body.conductorLat).toBeUndefined();
    expect(body.conductorLng).toBeUndefined();
    expect(body.tomadaEn).toBeUndefined();
  });
});
