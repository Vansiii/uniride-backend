import { randomUUID } from 'node:crypto';
import {
  DOMINIO,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import { A, ayudasFraude, HORA_MS } from './ayudas-fraude.js';

/** HU-26: el administrador lee las alertas y los bloqueos vigentes de su organización (solo lectura). */
describe('HU-26 · alertas de fraude (e2e)', () => {
  let e: Entorno;
  const f = ayudasFraude(() => e);
  let org: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let vacia: Awaited<ReturnType<typeof organizacionConAdmin>>;
  const hace = (ms: number) => new Date(Date.now() - ms);
  const con = (t: string) => ({ Authorization: `Bearer ${t}` });
  const RUTA = '/api/v1/organizacion/alertas-fraude';
  const BLOQUEOS = '/api/v1/organizacion/bloqueos-vigentes';

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    const superToken = await e.iniciar(`super${DOMINIO}`);
    org = await organizacionConAdmin(e, superToken, 'Alertas A');
    vacia = await organizacionConAdmin(e, superToken, 'Alertas Vacia');
  });
  beforeEach(() => f.r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  const sembrar = (creado: Date, patron = 'viajes_repetidos') =>
    e.bd.query(
      `INSERT INTO registros_auditoria (organizacion_id, accion, entidad, entidad_id, resultado, detalle, creado_en)
       VALUES ($1, 'fraude.alerta', 'reserva', $2, 'ok', $3, $4)`,
      [
        org.id,
        randomUUID(),
        JSON.stringify({
          patron,
          personas: [randomUUID()],
          reservaId: randomUUID(),
          reservas: [],
          cantidad: 3,
        }),
        creado,
      ],
    );

  it('CA-3: sin alertas, lista vacía', async () => {
    const r = await e.api().get(RUTA).set(con(vacia.token)).expect(200);
    expect(r.body).toEqual({ alertas: [] });
    const b = await e.api().get(BLOQUEOS).set(con(vacia.token)).expect(200);
    expect(b.body).toEqual({ bloqueos: [] });
  });

  it('CA-1, CA-2, CA-5, CA-9: ve alertas con nombre y rol, bloqueos vigentes y puede filtrar; sin coordenadas', async () => {
    const c = await f.persona(org.id);
    const p = await f.persona(org.id);
    for (const h of [20, 12, 4])
      await f.viajeNormal(org.id, c, p, hace(h * HORA_MS));
    // P-2: sin desplazamiento (mismo punto).
    await f.reservaEn(org.id, c, p, hace(2 * HORA_MS), {
      abordaje: A,
      bajada: A,
    });
    await f.tic();

    const todas = await e.api().get(RUTA).set(con(org.token)).expect(200);
    const patrones = todas.body.alertas.map(
      (x: { patron: string }) => x.patron,
    );
    expect(patrones).toContain('viajes_repetidos');
    expect(patrones).toContain('sin_desplazamiento');
    const rep = todas.body.alertas.find(
      (x: { patron: string }) => x.patron === 'viajes_repetidos',
    );
    expect(rep.personas.map((x: { rol: string }) => x.rol).sort()).toEqual([
      'conductor',
      'pasajero',
    ]);
    expect(
      rep.personas.every((x: { nombre: string }) => x.nombre.length > 0),
    ).toBe(true);
    expect(rep.bloqueoHasta).toBeDefined();
    // CA-9: ni coordenadas ni correos.
    const texto = JSON.stringify(todas.body);
    expect(texto).not.toMatch(/"lat"|"lng"|latitud|longitud|correo|@/);

    const filtrada = await e
      .api()
      .get(`${RUTA}?patron=sin_desplazamiento`)
      .set(con(org.token))
      .expect(200);
    expect(
      new Set(filtrada.body.alertas.map((x: { patron: string }) => x.patron)),
    ).toEqual(new Set(['sin_desplazamiento']));

    const b = await e.api().get(BLOQUEOS).set(con(org.token)).expect(200);
    expect(b.body.bloqueos.length).toBeGreaterThan(0);
    expect(b.body.bloqueos[0]).toMatchObject({ tipo: 'par' });
    expect(new Date(b.body.bloqueos[0].hasta).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('CA-2: un bloqueo vencido no aparece', async () => {
    await e.bd.query(
      `INSERT INTO registros_auditoria (organizacion_id, accion, entidad, resultado, detalle)
       VALUES ($1, 'fraude.bloqueo', 'reserva', 'ok', $2)`,
      [
        vacia.id,
        JSON.stringify({
          patron: 'viajes_repetidos',
          tipo: 'par',
          personas: [randomUUID(), randomUUID()],
          reservaId: randomUUID(),
          hasta: hace(HORA_MS).toISOString(),
        }),
      ],
    );
    const b = await e.api().get(BLOQUEOS).set(con(vacia.token)).expect(200);
    expect(b.body.bloqueos).toEqual([]);
  });

  it('CA-4: con 25 alertas devuelve 20 y un cursor; la segunda página trae las 5 restantes sin repetir', async () => {
    for (let i = 0; i < 25; i++)
      await sembrar(hace((i + 1) * 60_000), 'verificaciones_fallidas');
    const filtro = '&patron=verificaciones_fallidas';
    const uno = await e
      .api()
      .get(`${RUTA}?limite=20${filtro}`)
      .set(con(org.token))
      .expect(200);
    expect(uno.body.alertas).toHaveLength(20);
    expect(uno.body.siguiente).toBeDefined();
    const dos = await e
      .api()
      .get(
        `${RUTA}?limite=20&antes=${encodeURIComponent(uno.body.siguiente)}${filtro}`,
      )
      .set(con(org.token))
      .expect(200);
    expect(dos.body.alertas).toHaveLength(5);
    expect(dos.body.siguiente).toBeUndefined();
    const ids = [...uno.body.alertas, ...dos.body.alertas].map(
      (x: { id: string }) => x.id,
    );
    expect(new Set(ids).size).toBe(25);
  });

  it('CA-4: el límite máximo es 100 y los parámetros inválidos se rechazan', async () => {
    await e.api().get(`${RUTA}?limite=101`).set(con(org.token)).expect(400);
    await e.api().get(`${RUTA}?limite=0`).set(con(org.token)).expect(400);
    await e.api().get(`${RUTA}?patron=otro`).set(con(org.token)).expect(400);
    await e.api().get(`${RUTA}?antes=ayer`).set(con(org.token)).expect(400);
  });

  it('CA-10: cada consulta queda en la auditoría con autor y fecha', async () => {
    await e.api().get(RUTA).set(con(org.token)).expect(200);
    await e.api().get(BLOQUEOS).set(con(org.token)).expect(200);
    const { rows } = await e.bd.query(
      `SELECT accion, actor_id FROM registros_auditoria
       WHERE organizacion_id = $1 AND accion LIKE 'fraude.%.consultadas'`,
      [org.id],
    );
    expect(new Set(rows.map((r) => r.accion))).toEqual(
      new Set(['fraude.alertas.consultadas', 'fraude.bloqueos.consultadas']),
    );
    expect(rows.every((r) => r.actor_id === org.adminId)).toBe(true);
  });
});
