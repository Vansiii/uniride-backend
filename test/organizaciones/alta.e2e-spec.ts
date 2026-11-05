import {
  alta,
  DOMINIO,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';

describe('HU-01 · Alta de organización (e2e)', () => {
  let e: Entorno;
  let token: string;
  const crear = (cuerpo: object, t = token) =>
    e
      .api()
      .post('/api/v1/admin/organizaciones')
      .set('Authorization', `Bearer ${t}`)
      .send(cuerpo);

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    token = await e.iniciar(`super${DOMINIO}`);
  });
  afterAll(() => e.cerrar());

  it('CA-1 crea la organización activa con su invitación en cola y auditoría', async () => {
    const cuerpo = alta('Uno');
    const r = await crear(cuerpo).expect(201);
    expect(r.body).toMatchObject({
      nombre: cuerpo.nombre,
      estado: 'activa',
      precioMaximoUrc: 20,
    });
    const { rows } = await e.bd.query(
      `SELECT plantilla, estado FROM correos_salientes WHERE destinatario = $1`,
      [cuerpo.adminCorreo],
    );
    expect(rows).toEqual([
      { plantilla: 'invitacion_admin', estado: 'pendiente' },
    ]);
    const aud = await e.bd.query(
      `SELECT resultado FROM registros_auditoria WHERE accion = 'organizacion.alta' AND organizacion_id = $1`,
      [r.body.id],
    );
    expect(aud.rows).toEqual([{ resultado: 'ok' }]);
  });

  it('CA-2 un nombre repetido con otras mayúsculas o espacios se rechaza sin crear nada', async () => {
    await crear(alta('Dup')).expect(201);
    const r = await crear(
      alta('Dup', { nombre: '  hu01 DUP ', adminCorreo: `otro${DOMINIO}` }),
    ).expect(409);
    expect(r.body.codigo).toBe('ORGANIZACION_NOMBRE_DUPLICADO');
    const { rows } = await e.bd.query(
      `SELECT 1 FROM correos_salientes WHERE destinatario = $1`,
      [`otro${DOMINIO}`],
    );
    expect(rows).toHaveLength(0);
  });

  it('dos altas simultáneas con el mismo nombre: solo una gana', async () => {
    const [a, b] = await Promise.all([
      crear(alta('Carrera', { adminCorreo: `c1${DOMINIO}` })),
      crear(alta('Carrera', { adminCorreo: `c2${DOMINIO}` })),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it.each([
    ['nombre vacío', { nombre: '   ' }],
    ['tipo inválido', { tipo: 'colegio' }],
    ['precio cero', { precioMaximoUrc: 0 }],
    ['precio negativo', { precioMaximoUrc: -5 }],
    ['precio ausente', { precioMaximoUrc: undefined }],
    ['correo inválido', { adminCorreo: 'no-es-correo' }],
    ['nombre del admin vacío', { adminNombre: '' }],
  ])('CA-3 rechaza %s', async (_, cambio) => {
    const r = await crear(alta('Invalida', cambio)).expect(400);
    expect(r.body.codigo).toBe('VALIDACION_FALLIDA');
    const { rows } = await e.bd.query(
      `SELECT 1 FROM organizaciones WHERE nombre = 'HU01 Invalida'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('CA-8 el listado muestra los datos y el estado de la invitación', async () => {
    const cuerpo = alta('Lista', { tipo: 'empresa', precioMaximoUrc: 15.5 });
    await crear(cuerpo).expect(201);
    const listar = () =>
      e
        .api()
        .get('/api/v1/admin/organizaciones')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    const fila = (await listar()).body.find(
      (o: { nombre: string }) => o.nombre === cuerpo.nombre,
    );
    expect(fila).toMatchObject({
      tipo: 'empresa',
      estado: 'activa',
      precioMaximoUrc: 15.5,
      admin: { nombre: 'Ana Admin', correo: cuerpo.adminCorreo },
      estadoInvitacion: 'pendiente',
    });
    expect(fila.creadoEn).toBeTruthy();
    // Tras el envío pasa a "enviada".
    await e.correos.procesarPendientes();
    const despues = (await listar()).body.find(
      (o: { id: string }) => o.id === fila.id,
    );
    expect(despues.estadoInvitacion).toBe('enviada');
  });
});
