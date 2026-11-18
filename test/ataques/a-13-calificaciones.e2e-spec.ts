import {
  DOMINIO,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import { ayudasCalificaciones } from '../calificaciones/ayudas-calificaciones.js';

/** HU-21 CA-8 · A-13: nadie califica una reserva de otra organización ni en la que no participó; nada se escribe. */
describe('A-13 · calificaciones por organización (e2e)', () => {
  let e: Entorno;
  const a = ayudasCalificaciones(() => e);
  let orgA: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let orgB: Awaited<ReturnType<typeof organizacionConAdmin>>;

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    const superToken = await e.iniciar(`super${DOMINIO}`);
    orgA = await organizacionConAdmin(e, superToken, 'Atq Calif A');
    orgB = await organizacionConAdmin(e, superToken, 'Atq Calif B');
  });
  beforeEach(() => a.f.r.preparar());
  afterAll(() => e.cerrar());

  it('A-13: una persona de A no califica una reserva de B (ni la lee); no se escribe nada', async () => {
    const cB = await a.f.persona(orgB.id);
    const pB = await a.f.persona(orgB.id);
    const intruso = await a.f.persona(orgA.id);
    const reservaB = await a.reserva(orgB.id, cB, pB);
    for (const token of [intruso.token, orgA.token]) {
      const r = await a.calificar(token, reservaB).expect(403);
      expect(r.body.codigo).toBe('NO_PARTICIPANTE');
      await a.estado(token, reservaB).expect(403);
    }
    expect(await a.filas(reservaB)).toHaveLength(0);
  });

  it('A-13: ni siquiera un participante de B califica estando en el contexto de A', async () => {
    const cB = await a.f.persona(orgB.id);
    const pB = await a.f.persona(orgB.id);
    const reservaB = await a.reserva(orgB.id, cB, pB);
    // El token de un participante de B pide la reserva de B: funciona en su organización…
    await a.calificar(pB.token, reservaB).expect(201);
    // …y la calificación quedó solo en la organización de la reserva.
    const { rows } = await e.bd.query(
      `SELECT organizacion_id FROM calificaciones WHERE reserva_id = $1`,
      [reservaB],
    );
    expect(rows).toEqual([{ organizacion_id: orgB.id }]);
  });

  it('A-13: el promedio público solo devuelve agregados, nunca autor ni comentario', async () => {
    const c = await a.f.persona(orgA.id);
    const p = await a.f.persona(orgA.id);
    const r = await a.reserva(orgA.id, c, p);
    await a
      .calificar(p.token, r, { estrellas: 4, comentario: 'secreto' })
      .expect(201);
    const res = await e.bd.query(`SELECT * FROM promedio_calificacion($1)`, [
      c.id,
    ]);
    expect(Object.keys(res.rows[0]).sort()).toEqual(['cantidad', 'promedio']);
    expect(JSON.stringify(res.rows)).not.toContain('secreto');
  });
});
