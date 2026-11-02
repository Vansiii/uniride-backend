import pg from 'pg';
import {
  DOMINIO,
  miembroCon,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';

describe('HU-02 · Reglas de afiliación (e2e)', () => {
  let e: Entorno;
  let app: pg.Client; // rol de la API: RLS forzado, como en producción
  let superToken: string;
  let a: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let b: Awaited<ReturnType<typeof organizacionConAdmin>>;
  const conToken = (t: string) => ({ Authorization: `Bearer ${t}` });
  const ruta = (id: string) => `/api/v1/organizaciones/${id}/afiliacion`;
  const guardar = (
    org: { id: string; token: string },
    dominios: string[],
    modoAprobacion = 'manual',
  ) =>
    e
      .api()
      .put(ruta(org.id))
      .set(conToken(org.token))
      .send({ dominios, modoAprobacion });
  const duenaDe = async (dominio: string) =>
    (await app.query('SELECT organizacion_por_dominio($1) AS id', [dominio]))
      .rows[0].id;

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.bd.query(
      `DELETE FROM dominios_organizacion WHERE dominio LIKE '%hu02.test'`,
    );
    app = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    superToken = await e.iniciar(`super${DOMINIO}`);
    a = await organizacionConAdmin(e, superToken, 'Afil A');
    b = await organizacionConAdmin(e, superToken, 'Afil B');
  });
  afterAll(async () => {
    await app.end();
    await e.cerrar();
  });

  it('RN-5: una organización nueva no tiene dominios y aprueba manualmente', async () => {
    const r = await e.api().get(ruta(a.id)).set(conToken(a.token)).expect(200);
    expect(r.body).toEqual({ dominios: [], modoAprobacion: 'manual' });
  });

  it('CA-1: registra dominios normalizados y quedan asociados a A para el registro (HU-05)', async () => {
    const r = await guardar(
      a,
      [' @UAGRM.hu02.test ', 'est.uagrm.hu02.test', 'uagrm.hu02.test'],
      'automatica',
    ).expect(200);
    expect(r.body).toEqual({
      dominios: ['est.uagrm.hu02.test', 'uagrm.hu02.test'],
      modoAprobacion: 'automatica',
    });
    const leida = await e
      .api()
      .get(ruta(a.id))
      .set(conToken(a.token))
      .expect(200);
    expect(leida.body).toEqual(r.body);
    // RN-3: exacta y sin distinguir mayúsculas; un subdominio no registrado no coincide.
    expect(await duenaDe('UAGRM.hu02.test')).toBe(a.id);
    expect(await duenaDe('est.uagrm.hu02.test')).toBe(a.id);
    expect(await duenaDe('otro.uagrm.hu02.test')).toBeNull();
  });

  it('CA-2: un dominio de otra organización se rechaza sin revelar la dueña y sin cambiar nada', async () => {
    await guardar(b, ['b.hu02.test']).expect(200);
    const r = await guardar(
      b,
      ['b.hu02.test', 'UAGRM.hu02.test'],
      'automatica',
    ).expect(409);
    expect(r.body.codigo).toBe('DOMINIO_NO_DISPONIBLE');
    const texto = JSON.stringify(r.body);
    expect(texto).not.toContain(a.id);
    expect(texto).not.toContain('Afil A');
    // Transacción completa o nada: B conserva su lista y su modo.
    const leida = await e
      .api()
      .get(ruta(b.id))
      .set(conToken(b.token))
      .expect(200);
    expect(leida.body).toEqual({
      dominios: ['b.hu02.test'],
      modoAprobacion: 'manual',
    });
    expect(await duenaDe('uagrm.hu02.test')).toBe(a.id);
  });

  it('CA-2: si dos organizaciones registran el mismo dominio a la vez, solo una lo logra', async () => {
    const [ra, rb] = await Promise.all([
      guardar(a, [
        'uagrm.hu02.test',
        'est.uagrm.hu02.test',
        'carrera.hu02.test',
      ]),
      guardar(b, ['b.hu02.test', 'carrera.hu02.test']),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const perdedora = ra.status === 409 ? ra : rb;
    expect(perdedora.body.codigo).toBe('DOMINIO_NO_DISPONIBLE');
    const { rows } = await e.bd.query(
      `SELECT organizacion_id FROM dominios_organizacion WHERE dominio = 'carrera.hu02.test'`,
    );
    expect(rows).toHaveLength(1);
    expect(await duenaDe('carrera.hu02.test')).toBe(
      ra.status === 200 ? a.id : b.id,
    );
  });

  it('CA-3: dominios públicos o con formato inválido se rechazan', async () => {
    for (const d of [
      'gmail.com',
      'Hotmail.com',
      'outlook.com',
      'yahoo.com',
      'icloud.com',
      'uagrm',
      'ana@uagrm.hu02.test',
      'uagrm..hu02.test',
    ]) {
      const r = await guardar(a, ['uagrm.hu02.test', d]).expect(400);
      expect(r.body.codigo).toBe('DOMINIO_INVALIDO');
    }
    const { rows } = await e.bd.query(
      `SELECT 1 FROM dominios_organizacion WHERE dominio IN ('gmail.com', 'hotmail.com', 'uagrm')`,
    );
    expect(rows).toHaveLength(0);
  });

  it('dominio repetido en la misma organización: se ignora, sin duplicar', async () => {
    const r = await guardar(b, [
      'b.hu02.test',
      'B.HU02.TEST',
      '@b.hu02.test',
    ]).expect(200);
    expect(r.body.dominios).toEqual(['b.hu02.test']);
  });

  it('CA-6: no se puede quitar el último dominio', async () => {
    const r = await guardar(b, []).expect(400);
    expect(r.body.codigo).toBe('MINIMO_UN_DOMINIO');
    const leida = await e
      .api()
      .get(ruta(b.id))
      .set(conToken(b.token))
      .expect(200);
    expect(leida.body.dominios).toEqual(['b.hu02.test']);
  });

  it('RN-7: quitar un dominio impide registros nuevos pero no toca a los miembros aprobados', async () => {
    await guardar(b, ['b.hu02.test', 'viejo.hu02.test']).expect(200);
    await miembroCon(e, b.id, `viejo${DOMINIO}`, 'aprobada');
    await guardar(b, ['b.hu02.test']).expect(200);
    expect(await duenaDe('viejo.hu02.test')).toBeNull();
    const { rows } = await e.bd.query(
      `SELECT m.estado FROM membresias m JOIN usuarios u ON u.id = m.usuario_id WHERE u.correo = $1`,
      [`viejo${DOMINIO}`],
    );
    expect(rows).toEqual([{ estado: 'aprobada' }]);
    // El dominio liberado queda disponible para otra organización.
    await guardar(a, ['uagrm.hu02.test', 'viejo.hu02.test']).expect(200);
    expect(await duenaDe('viejo.hu02.test')).toBe(a.id);
  });

  it('RN-6: cambiar el modo no aprueba las solicitudes pendientes', async () => {
    await miembroCon(e, a.id, `pendiente${DOMINIO}`, 'pendiente');
    await guardar(a, ['uagrm.hu02.test'], 'automatica').expect(200);
    const { rows } = await e.bd.query(
      `SELECT m.estado FROM membresias m JOIN usuarios u ON u.id = m.usuario_id WHERE u.correo = $1`,
      [`pendiente${DOMINIO}`],
    );
    expect(rows).toEqual([{ estado: 'pendiente' }]);
  });

  it('CA-4 / CA-5: el modo de aprobación queda guardado para el registro (HU-05)', async () => {
    await guardar(a, ['uagrm.hu02.test'], 'manual').expect(200);
    let { rows } = await e.bd.query(
      `SELECT modo_aprobacion FROM organizaciones WHERE id = $1`,
      [a.id],
    );
    expect(rows[0].modo_aprobacion).toBe('manual');
    await guardar(a, ['uagrm.hu02.test'], 'automatica').expect(200);
    ({ rows } = await e.bd.query(
      `SELECT modo_aprobacion FROM organizaciones WHERE id = $1`,
      [a.id],
    ));
    expect(rows[0].modo_aprobacion).toBe('automatica');
    const r = await guardar(a, ['uagrm.hu02.test'], 'libre').expect(400);
    expect(r.body.codigo).toBe('VALIDACION_FALLIDA');
  });

  it('CA-8: cada cambio queda auditado con autor, fecha, valor anterior y nuevo', async () => {
    await guardar(b, ['b.hu02.test'], 'manual').expect(200);
    const antes = new Date();
    await guardar(b, ['b.hu02.test', 'nuevo.hu02.test'], 'automatica').expect(
      200,
    );
    const { rows } = await e.bd.query(
      `SELECT actor_id, organizacion_id, resultado, detalle, creado_en FROM registros_auditoria
       WHERE accion = 'organizacion.afiliacion' AND organizacion_id = $1 ORDER BY creado_en DESC LIMIT 1`,
      [b.id],
    );
    expect(rows[0]).toMatchObject({
      actor_id: b.adminId,
      organizacion_id: b.id,
      resultado: 'ok',
      detalle: {
        anterior: { dominios: ['b.hu02.test'], modoAprobacion: 'manual' },
        nuevo: {
          dominios: ['b.hu02.test', 'nuevo.hu02.test'],
          modoAprobacion: 'automatica',
        },
      },
    });
    expect(new Date(rows[0].creado_en).getTime()).toBeGreaterThanOrEqual(
      antes.getTime() - 1000,
    );
  });

  it('RN-1: solo un admin con membresía aprobada configura la afiliación', async () => {
    const miembro = await miembroCon(e, a.id, `miembro${DOMINIO}`, 'aprobada');
    const pendiente = await miembroCon(
      e,
      a.id,
      `adminpend${DOMINIO}`,
      'pendiente',
      'admin_organizacion',
    );
    const otro = await e.iniciar(`super${DOMINIO}`); // super admin: sin organización activa
    for (const t of [miembro, pendiente, otro]) {
      const leer = await e.api().get(ruta(a.id)).set(conToken(t)).expect(403);
      expect(leer.body.codigo).toBe('NO_AUTORIZADO');
      await e
        .api()
        .put(ruta(a.id))
        .set(conToken(t))
        .send({ dominios: ['intruso.hu02.test'], modoAprobacion: 'manual' })
        .expect(403);
    }
    await e.api().get(ruta(a.id)).expect(401);
    expect(await duenaDe('intruso.hu02.test')).toBeNull();
  });

  it('organizacion_por_dominio solo responde por organizaciones activas', async () => {
    await e.bd.query(
      `UPDATE organizaciones SET estado = 'suspendida' WHERE id = $1`,
      [b.id],
    );
    try {
      expect(await duenaDe('b.hu02.test')).toBeNull();
    } finally {
      await e.bd.query(
        `UPDATE organizaciones SET estado = 'activa' WHERE id = $1`,
        [b.id],
      );
    }
    expect(await duenaDe('b.hu02.test')).toBe(b.id);
  });
});
