import { randomUUID } from 'node:crypto';
import {
  DOMINIO,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';

/** HU-26 CA-6 · A-13: el administrador de A nunca ve alertas ni bloqueos de B. */
describe('A-13 · alertas de fraude por organización (e2e)', () => {
  let e: Entorno;
  let a: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let b: Awaited<ReturnType<typeof organizacionConAdmin>>;
  const con = (t: string) => ({ Authorization: `Bearer ${t}` });
  const RUTA = '/api/v1/organizacion/alertas-fraude';
  const BLOQUEOS = '/api/v1/organizacion/bloqueos-vigentes';
  const MARCA = 'ALERTA-SOLO-DE-B';

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    const superToken = await e.iniciar(`super${DOMINIO}`);
    a = await organizacionConAdmin(e, superToken, 'Atq Alertas A');
    b = await organizacionConAdmin(e, superToken, 'Atq Alertas B');
    const detalle = {
      patron: 'viajes_repetidos',
      tipo: 'par',
      personas: [b.adminId, randomUUID()],
      reservaId: randomUUID(),
      reservas: [],
      cantidad: 3,
      marca: MARCA,
      hasta: new Date(Date.now() + 86_400_000).toISOString(),
    };
    for (const accion of ['fraude.alerta', 'fraude.bloqueo'])
      await e.bd.query(
        `INSERT INTO registros_auditoria (organizacion_id, accion, entidad, resultado, detalle)
         VALUES ($1, $2, 'reserva', 'ok', $3)`,
        [b.id, accion, JSON.stringify(detalle)],
      );
  });
  afterAll(() => e.cerrar());

  it('A-13: el admin de A no ve nada de B, y el de B sí ve lo suyo (la siembra funciona)', async () => {
    for (const ruta of [RUTA, BLOQUEOS]) {
      const deA = await e.api().get(ruta).set(con(a.token)).expect(200);
      expect(JSON.stringify(deA.body)).not.toContain(b.adminId);
      expect(Object.values(deA.body)[0]).toEqual([]);
      const deB = await e.api().get(ruta).set(con(b.token)).expect(200);
      expect((Object.values(deB.body)[0] as unknown[]).length).toBe(1);
    }
  });

  it('A-13: pedir la organización de B por parámetro se rechaza; la organización sale del token', async () => {
    for (const q of [
      `organizacionId=${b.id}`,
      `organizacion=${b.id}`,
      `org=${b.id}`,
    ])
      await e.api().get(`${RUTA}?${q}`).set(con(a.token)).expect(400);
    const r = await e
      .api()
      .get(RUTA)
      .set({ ...con(a.token), 'X-Organizacion': b.id })
      .expect(200);
    expect(r.body.alertas).toEqual([]);
  });

  it('A-13: sin escribir ni borrar: las filas de B siguen intactas tras las consultas de A', async () => {
    await e.api().get(RUTA).set(con(a.token)).expect(200);
    const { rows } = await e.bd.query(
      `SELECT count(*)::int AS n FROM registros_auditoria WHERE organizacion_id = $1 AND accion LIKE 'fraude.%' AND accion NOT LIKE '%consultadas'`,
      [b.id],
    );
    expect(rows[0].n).toBe(2);
  });
});
