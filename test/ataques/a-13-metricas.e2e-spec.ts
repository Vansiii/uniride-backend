import {
  DOMINIO,
  miembroCon,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';

/** HU-32 CA-7 · A-13: el administrador de A nunca ve cifras de B; la organización sale del token. */
describe('A-13 · resumen por organización (e2e)', () => {
  let e: Entorno;
  let a: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let b: Awaited<ReturnType<typeof organizacionConAdmin>>;
  const con = (t: string) => ({ Authorization: `Bearer ${t}` });
  const RUTA = '/api/v1/organizacion/resumen';

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    const superToken = await e.iniciar(`super${DOMINIO}`);
    a = await organizacionConAdmin(e, superToken, 'Atq Resumen A');
    b = await organizacionConAdmin(e, superToken, 'Atq Resumen B');
    for (let i = 0; i < 3; i++)
      await miembroCon(e, b.id, `extra${i}.resumen${DOMINIO}`, 'aprobada');
  });
  afterAll(() => e.cerrar());

  it('A-13: el admin de A cuenta solo lo suyo aunque pida a B por parámetro o cabecera', async () => {
    const base = (await e.api().get(RUTA).set(con(a.token)).expect(200)).body;
    expect(base.miembrosActivos).toBe(1);
    for (const q of [`organizacionId=${b.id}`, `organizacion=${b.id}`])
      await e.api().get(`${RUTA}?${q}`).set(con(a.token)).expect(400);
    const r = await e
      .api()
      .get(RUTA)
      .set({ ...con(a.token), 'X-Organizacion': b.id })
      .expect(200);
    expect(r.body.miembrosActivos).toBe(1);
    const deB = (await e.api().get(RUTA).set(con(b.token)).expect(200)).body;
    expect(deB.miembrosActivos).toBe(4);
  });
});
