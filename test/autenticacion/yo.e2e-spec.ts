import {
  alta,
  DOMINIO,
  miembroCon,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';

describe('HU-06 CA-7 · GET /yo con las membresías del usuario (e2e)', () => {
  let e: Entorno;
  let superToken: string;
  let a: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let b: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let c: Awaited<ReturnType<typeof organizacionConAdmin>>;
  const yo = async (token: string) =>
    (
      await e
        .api()
        .get('/api/v1/yo')
        .set({ Authorization: `Bearer ${token}` })
        .expect(200)
    ).body;
  const sumar = async (
    correo: string,
    organizacionId: string,
    estado: string,
    rol = 'miembro',
  ) =>
    e.bd.query(
      `INSERT INTO membresias (organizacion_id, usuario_id, rol, estado)
       SELECT $1, id, $3, $4 FROM usuarios WHERE correo = $2`,
      [organizacionId, correo, rol, estado],
    );

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    superToken = await e.iniciar(`super${DOMINIO}`);
    a = await organizacionConAdmin(e, superToken, 'Yo A');
    b = await organizacionConAdmin(e, superToken, 'Yo B');
    c = await organizacionConAdmin(e, superToken, 'Yo C');
  }, 60_000); // tres altas con invitación: bajo carga pasa de los 10 s por defecto
  afterAll(() => e.cerrar());

  it('sin membresías (super admin): lista vacía', async () => {
    expect((await yo(superToken)).membresias).toEqual([]);
  });

  it('el admin de una organización ve su rol (la web muestra Afiliación solo a admins)', async () => {
    expect((await yo(a.token)).membresias).toEqual([
      {
        organizacionId: a.id,
        organizacion: 'HU01 Yo A',
        rol: 'admin_organizacion',
        estado: 'aprobada',
      },
    ]);
  });

  it('pendiente y rechazada: ve el estado de cada solicitud, en todas sus organizaciones', async () => {
    const correo = `varias${DOMINIO}`;
    const token = await miembroCon(e, a.id, correo, 'pendiente');
    await sumar(correo, b.id, 'rechazada');
    await sumar(correo, c.id, 'aprobada', 'admin_organizacion');
    const cuerpo = await yo(token);
    expect(cuerpo.membresias).toEqual([
      {
        organizacionId: a.id,
        organizacion: 'HU01 Yo A',
        rol: 'miembro',
        estado: 'pendiente',
      },
      {
        organizacionId: b.id,
        organizacion: 'HU01 Yo B',
        rol: 'miembro',
        estado: 'rechazada',
      },
      {
        organizacionId: c.id,
        organizacion: 'HU01 Yo C',
        rol: 'admin_organizacion',
        estado: 'aprobada',
      },
    ]);
  });

  it('A-13: solo sus propias membresías y solo los cuatro campos', async () => {
    const token = await miembroCon(e, b.id, `solo${DOMINIO}`, 'aprobada');
    const { membresias } = await yo(token);
    // B tiene otros miembros (su admin, "varias"): no aparecen.
    expect(membresias).toHaveLength(1);
    expect(Object.keys(membresias[0]).sort()).toEqual([
      'estado',
      'organizacion',
      'organizacionId',
      'rol',
    ]);
    const texto = JSON.stringify(membresias);
    expect(texto).not.toContain(b.adminId);
    expect(texto).not.toContain('HU01 Yo A');
    expect(texto).not.toContain(alta('Yo B').adminCorreo);
  });
});
