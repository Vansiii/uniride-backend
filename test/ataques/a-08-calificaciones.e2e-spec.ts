import pg from 'pg';
import {
  DOMINIO,
  miembroCon,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import { ayudasCalificaciones } from '../calificaciones/ayudas-calificaciones.js';

/** HU-21 CA-9 · A-08: sin sesión o sin ser parte no se califica; una calificación no se edita ni se borra. */
describe('A-08 · calificaciones sin la app ni el rol (e2e)', () => {
  let e: Entorno;
  const a = ayudasCalificaciones(() => e);
  let org: Awaited<ReturnType<typeof organizacionConAdmin>>;

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    org = await organizacionConAdmin(
      e,
      await e.iniciar(`super${DOMINIO}`),
      'Atq Calif 08',
    );
  });
  beforeEach(() => a.f.r.preparar());
  afterAll(() => e.cerrar());

  it('A-08: sin sesión → 401', async () => {
    const c = await a.f.persona(org.id);
    const p = await a.f.persona(org.id);
    const r = await a.reserva(org.id, c, p);
    await e
      .api()
      .post(`/api/v1/reservas/${r}/calificaciones`)
      .send({ estrellas: 5 })
      .expect(401);
    await e.api().get(`/api/v1/reservas/${r}/calificaciones`).expect(401);
    expect(await a.filas(r)).toHaveLength(0);
  });

  it('A-08: un miembro de la misma organización que no es parte → 403 y sin fila; el admin tampoco', async () => {
    const c = await a.f.persona(org.id);
    const p = await a.f.persona(org.id);
    const ajeno = await miembroCon(
      e,
      org.id,
      `ajeno.calif${DOMINIO}`,
      'aprobada',
    );
    const r = await a.reserva(org.id, c, p);
    for (const token of [ajeno, org.token])
      await a.calificar(token, r).expect(403);
    expect(await a.filas(r)).toHaveLength(0);
  });

  it('A-08: el destinatario lo decide el servidor; uno falsificado se rechaza', async () => {
    const c = await a.f.persona(org.id);
    const p = await a.f.persona(org.id);
    const tercero = await a.f.persona(org.id);
    const r = await a.reserva(org.id, c, p);
    await a
      .calificar(p.token, r, { estrellas: 5, destinatarioId: tercero.id })
      .expect(403);
    await a
      .calificar(c.token, r, { estrellas: 5, destinatarioId: tercero.id })
      .expect(403);
    expect(await a.filas(r)).toHaveLength(0);
    // Con el destinatario correcto, el conductor sí califica al pasajero.
    await a
      .calificar(c.token, r, { estrellas: 5, destinatarioId: p.id })
      .expect(201);
    expect((await a.filas(r))[0].destinatario_id).toBe(p.id);
  });

  it('A-08: no hay rutas para editar ni borrar; y el rol de la API no puede hacerlo en la base', async () => {
    const c = await a.f.persona(org.id);
    const p = await a.f.persona(org.id);
    const r = await a.reserva(org.id, c, p);
    await a.calificar(p.token, r, { estrellas: 3 }).expect(201);
    const ruta = `/api/v1/reservas/${r}/calificaciones`;
    for (const metodo of ['put', 'patch', 'delete'] as const)
      await e
        .api()
        [metodo](ruta)
        .set({ Authorization: `Bearer ${p.token}` })
        .send({ estrellas: 5 })
        .expect(404);
    const api = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await api.connect();
    try {
      await api.query('BEGIN');
      await api.query(`SELECT set_config('app.super_admin', 'true', true)`);
      await expect(
        api.query(`UPDATE calificaciones SET estrellas = 5`),
      ).rejects.toThrow(/permission denied/);
      await api.query('ROLLBACK');
      await api.query('BEGIN');
      await api.query(`SELECT set_config('app.super_admin', 'true', true)`);
      await expect(api.query(`DELETE FROM calificaciones`)).rejects.toThrow(
        /permission denied/,
      );
      await api.query('ROLLBACK');
    } finally {
      await api.end();
    }
    expect((await a.filas(r))[0].estrellas).toBe(3);
  });
});
