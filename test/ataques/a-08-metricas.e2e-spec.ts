import {
  DOMINIO,
  miembroCon,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';

/** HU-32 CA-8 · A-08: solo el administrador lee el resumen; nadie escribe. */
describe('A-08 · resumen sin el rol (e2e)', () => {
  let e: Entorno;
  let org: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let miembro: string;
  const con = (t: string) => ({ Authorization: `Bearer ${t}` });
  const RUTA = '/api/v1/organizacion/resumen';

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    const superToken = await e.iniciar(`super${DOMINIO}`);
    org = await organizacionConAdmin(e, superToken, 'Atq Resumen 08');
    miembro = await miembroCon(
      e,
      org.id,
      `miembro.resumen${DOMINIO}`,
      'aprobada',
    );
  });
  afterAll(() => e.cerrar());

  it('A-08: sin sesión → 401; miembro común y super admin sin membresía → 403', async () => {
    await e.api().get(RUTA).expect(401);
    const res = await e.api().get(RUTA).set(con(miembro)).expect(403);
    expect(res.body.codigo).toBe('NO_AUTORIZADO');
    const token = await e.iniciar(`super${DOMINIO}`);
    await e.api().get(RUTA).set(con(token)).expect(403);
  });

  it('A-08: ninguna acción de escritura sobre el resumen', async () => {
    for (const metodo of ['post', 'put', 'patch', 'delete'] as const)
      await e.api()[metodo](RUTA).set(con(org.token)).send({}).expect(404);
  });
});
