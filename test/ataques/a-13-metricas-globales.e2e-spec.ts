import {
  DOMINIO,
  miembroCon,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';

/** HU-33 CA-6 y CA-7 · A-13 y A-08: solo el super administrador lee las métricas globales; nadie escribe. */
describe('A-13 · A-08 · métricas globales sin el rol (e2e)', () => {
  let e: Entorno;
  let org: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let miembro: string;
  const con = (t: string) => ({ Authorization: `Bearer ${t}` });
  const RUTA = '/api/v1/plataforma/metricas';

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    const superToken = await e.iniciar(`super${DOMINIO}`);
    org = await organizacionConAdmin(e, superToken, 'Atq Globales');
    miembro = await miembroCon(
      e,
      org.id,
      `miembro.globales${DOMINIO}`,
      'aprobada',
    );
  });
  afterAll(() => e.cerrar());

  it('A-08: sin sesión → 401', async () => {
    await e.api().get(RUTA).expect(401);
  });

  it('A-13: el administrador de una organización y un miembro común → 403', async () => {
    for (const token of [org.token, miembro]) {
      const r = await e.api().get(RUTA).set(con(token)).expect(403);
      expect(r.body.codigo).toBe('NO_AUTORIZADO');
    }
  });

  it('A-08: ninguna acción de escritura, ni siquiera para el super administrador', async () => {
    const token = await e.iniciar(`super${DOMINIO}`);
    for (const metodo of ['post', 'put', 'patch', 'delete'] as const)
      await e.api()[metodo](RUTA).set(con(token)).send({}).expect(404);
  });
});
