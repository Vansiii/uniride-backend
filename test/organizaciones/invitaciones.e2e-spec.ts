import {
  alta,
  CONTRASENA,
  DOMINIO,
  prepararEntorno,
  tokenInvitacion,
  type Entorno,
} from '../ayudas-organizaciones.js';

describe('HU-01 · Invitaciones (e2e)', () => {
  let e: Entorno;
  let token: string;
  const crear = async (sufijo: string, extra: object = {}) => {
    const cuerpo = alta(sufijo, extra);
    const r = await e
      .api()
      .post('/api/v1/admin/organizaciones')
      .set('Authorization', `Bearer ${token}`)
      .send(cuerpo)
      .expect(201);
    return {
      id: r.body.id as string,
      correo: cuerpo.adminCorreo,
      token: await tokenInvitacion(e.bd, cuerpo.adminCorreo),
    };
  };
  const aceptar = (t: string, cuerpo: object) =>
    e.api().post(`/api/v1/invitaciones/${t}/aceptar`).send(cuerpo);
  const reenviar = (id: string) =>
    e
      .api()
      .post(`/api/v1/admin/organizaciones/${id}/invitacion`)
      .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    token = await e.iniciar(`super${DOMINIO}`);
  });
  afterAll(() => e.cerrar());

  it('CA-4 cuenta nueva: queda como admin de esa organización y con sesión iniciada', async () => {
    const o = await crear('Nueva');
    const info = await e
      .api()
      .get(`/api/v1/invitaciones/${o.token}`)
      .expect(200);
    expect(info.body).toMatchObject({
      organizacion: 'HU01 Nueva',
      correo: o.correo,
      cuentaExistente: false,
    });
    const r = await aceptar(o.token, {
      nombreCompleto: 'Ana Admin',
      contrasena: CONTRASENA,
      tipoCliente: 'movil',
    }).expect(200);
    expect(r.body.tokenAcceso).toBeTruthy();
    const { rows } = await e.bd.query(
      `SELECT m.rol, m.estado, m.organizacion_id, u.ultima_organizacion_id FROM membresias m JOIN usuarios u ON u.id = m.usuario_id WHERE u.correo = $1`,
      [o.correo],
    );
    expect(rows).toEqual([
      {
        rol: 'admin_organizacion',
        estado: 'aprobada',
        organizacion_id: o.id,
        ultima_organizacion_id: o.id,
      },
    ]);
  });

  it('RN-7 cuenta existente: suma el rol sin duplicar la cuenta y exige su contraseña', async () => {
    const correo = `existente${DOMINIO}`;
    await e.crearUsuario(correo);
    const o = await crear('Existente', { adminCorreo: correo });
    const info = await e.api().get(`/api/v1/invitaciones/${o.token}`);
    expect(info.body.cuentaExistente).toBe(true);
    await aceptar(o.token, { contrasena: 'incorrecta1' }).expect(401);
    await aceptar(o.token, { contrasena: CONTRASENA }).expect(200);
    const { rows } = await e.bd.query(
      `SELECT count(*)::int AS n FROM usuarios WHERE lower(correo) = $1`,
      [correo],
    );
    expect(rows[0].n).toBe(1);
  });

  it('una contraseña débil se rechaza y la invitación sigue vigente', async () => {
    const o = await crear('Debil');
    const r = await aceptar(o.token, {
      nombreCompleto: 'Ana',
      contrasena: 'corta',
    }).expect(400);
    expect(r.body.codigo).toBe('CONTRASENA_DEBIL');
    await aceptar(o.token, {
      nombreCompleto: 'Ana',
      contrasena: CONTRASENA,
    }).expect(200);
  });

  it('CA-5 una invitación usada no se acepta dos veces', async () => {
    const o = await crear('Usada');
    const cuerpo = { nombreCompleto: 'Ana', contrasena: CONTRASENA };
    await aceptar(o.token, cuerpo).expect(200);
    const r = await aceptar(o.token, cuerpo).expect(410);
    expect(r.body.codigo).toBe('INVITACION_VENCIDA');
    await e.api().get(`/api/v1/invitaciones/${o.token}`).expect(410);
  });

  it('CA-5 una invitación vencida (72 h) se rechaza', async () => {
    const o = await crear('Vencida');
    const { rows } = await e.bd.query(
      `SELECT extract(epoch FROM vence_en - creado_en)::int AS segundos FROM invitaciones WHERE organizacion_id = $1`,
      [o.id],
    );
    expect(rows[0].segundos).toBe(72 * 3600);
    await e.bd.query(
      `UPDATE invitaciones SET vence_en = now() - interval '1 minute' WHERE organizacion_id = $1`,
      [o.id],
    );
    await aceptar(o.token, {
      nombreCompleto: 'Ana',
      contrasena: CONTRASENA,
    }).expect(410);
    const lista = await e
      .api()
      .get('/api/v1/admin/organizaciones')
      .set('Authorization', `Bearer ${token}`);
    const fila = lista.body.find((x: { id: string }) => x.id === o.id);
    expect(fila.estadoInvitacion).toBe('vencida');
  });

  it('CA-5 reenviar invalida la anterior y la nueva sirve', async () => {
    const o = await crear('Reenvio');
    await reenviar(o.id).expect(201);
    await e.api().get(`/api/v1/invitaciones/${o.token}`).expect(410);
    const nuevo = await tokenInvitacion(e.bd, o.correo);
    expect(nuevo).not.toBe(o.token);
    await aceptar(nuevo, {
      nombreCompleto: 'Ana',
      contrasena: CONTRASENA,
    }).expect(200);
    await reenviar(o.id).expect(409);
  });

  it('reenviar a una organización inexistente da 404', async () => {
    await reenviar('00000000-0000-4000-8000-000000000000').expect(404);
  });

  it('el token no se guarda: en BD solo está su hash', async () => {
    const o = await crear('Hash');
    const { rows } = await e.bd.query(
      `SELECT hash_token FROM invitaciones WHERE organizacion_id = $1`,
      [o.id],
    );
    expect(rows[0].hash_token).not.toContain(o.token);
  });
});
