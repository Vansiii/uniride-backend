import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasFraude, HORA_MS } from '../fraude/ayudas-fraude.js';

/** HU-25 CA-1, CA-3, CA-5 · A-10: simular viajes entre los mismos dos cuentas termina en un bloqueo del par. */
describe('A-10 · colusión para simular viajes (e2e)', () => {
  let e: Entorno;
  const f = ayudasFraude(() => e);
  let org: string;
  const hace = (ms: number) => new Date(Date.now() - ms);

  beforeAll(async () => {
    e = await prepararEntorno();
    org = (await f.r.v.organizacion('Fraude A10')).id;
  });
  beforeEach(() => f.r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  it('A-10: tres viajes pagados del par en 24 h bloquean la reserva entre ellos, en los dos roles, sin decir el motivo', async () => {
    const a = await f.persona(org);
    const b = await f.persona(org);
    for (const h of [20, 12, 4])
      await f.viajeNormal(org, a, b, hace(h * HORA_MS));
    await f.tic();

    // a conductor, b pasajero.
    const deA = await f.r.publicar(a);
    const rechazo = await f.r.reservar(b, deA).expect(409);
    expect(rechazo.body.codigo).toBe('PAR_BLOQUEADO');
    expect(rechazo.body.mensaje).toBe(
      'No puedes reservar este viaje por ahora.',
    );
    // Y al revés: b conductor, a pasajero.
    const deB = await f.r.publicar(b);
    await f.r.reservar(a, deB).expect(409);

    // Sin dinero ni asiento movidos.
    expect(await f.r.huella(b.id)).toEqual({ reservas: 3, bloqueos: 0 });
    expect((await f.r.viaje(deA)).cupos_disponibles).toBe(3);
    // Con otra persona sí se puede reservar: el bloqueo es solo del par.
    const c = await f.persona(org);
    await f.r.reservar(c, deA).expect(201);
  });

  it('A-10: dos viajes «sin moverse» del par en 7 días bloquean al par', async () => {
    const a = await f.persona(org);
    const b = await f.persona(org);
    const quieto = {
      abordaje: { lat: -17.78, lng: -63.18 },
      bajada: { lat: -17.7801, lng: -63.18 },
    };
    await f.reservaEn(org, a, b, hace(4 * 24 * HORA_MS), quieto);
    await f.reservaEn(org, a, b, hace(1 * 24 * HORA_MS), quieto);
    await f.tic();
    const viajeId = await f.r.publicar(a);
    await f.r.reservar(b, viajeId).expect(409);
  });

  it('A-10: los viajes no crean saldo, así que la colusión no genera ganancia aunque el bloqueo tarde', async () => {
    const a = await f.persona(org);
    const b = await f.persona(org);
    const antes = (await f.r.saldo(a).expect(200)).body.saldoTotal;
    for (const h of [20, 12, 4])
      await f.viajeNormal(org, a, b, hace(h * HORA_MS));
    await f.tic();
    expect((await f.r.saldo(a).expect(200)).body.saldoTotal).toBe(antes);
  });
});
