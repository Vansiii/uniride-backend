import {
  DOMINIO,
  miembroCon,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';

/** HU-26 CA-7 y CA-8 · A-08: solo el administrador lee; nadie escribe ni levanta bloqueos por la API. */
describe('A-08 · alertas de fraude sin la app ni el rol (e2e)', () => {
  let e: Entorno;
  let org: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let miembro: string;
  const con = (t: string) => ({ Authorization: `Bearer ${t}` });
  const RUTAS = [
    '/api/v1/organizacion/alertas-fraude',
    '/api/v1/organizacion/bloqueos-vigentes',
  ];

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    const superToken = await e.iniciar(`super${DOMINIO}`);
    org = await organizacionConAdmin(e, superToken, 'Atq Alertas 08');
    miembro = await miembroCon(
      e,
      org.id,
      `miembro.alertas${DOMINIO}`,
      'aprobada',
    );
  });
  afterAll(() => e.cerrar());

  it('A-08: sin sesión → 401', async () => {
    for (const r of RUTAS) await e.api().get(r).expect(401);
  });

  it('A-08: un miembro común (conductor o pasajero) → 403', async () => {
    for (const r of RUTAS) {
      const res = await e.api().get(r).set(con(miembro)).expect(403);
      expect(res.body.codigo).toBe('NO_AUTORIZADO');
    }
  });

  it('A-08: el super administrador, sin membresía en la organización, tampoco la ve', async () => {
    const token = await e.iniciar(`super${DOMINIO}`);
    for (const r of RUTAS) await e.api().get(r).set(con(token)).expect(403);
  });

  it('A-08: no existe ninguna acción para crear, editar, levantar o borrar (ni siquiera para el admin)', async () => {
    const rutas = [...RUTAS, '/api/v1/organizacion/bloqueos-vigentes/1'];
    for (const ruta of rutas)
      for (const metodo of ['post', 'put', 'patch', 'delete'] as const)
        await e.api()[metodo](ruta).set(con(org.token)).send({}).expect(404);
  });
});
