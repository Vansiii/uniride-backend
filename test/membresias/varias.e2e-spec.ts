import { JwtService } from '@nestjs/jwt';
import {
  buzon,
  CONTRASENA,
  DOMINIO,
  miembroCon,
  organizacionConDominio,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';

describe('HU-07 · Varias organizaciones (e2e)', () => {
  let e: Entorno;
  let correos: ReturnType<typeof buzon>;
  let a: Awaited<ReturnType<typeof organizacionConDominio>>; // automática
  let b: Awaited<ReturnType<typeof organizacionConDominio>>; // automática
  let c: Awaited<ReturnType<typeof organizacionConDominio>>; // manual
  let d: Awaited<ReturnType<typeof organizacionConDominio>>; // manual
  /** Persona con A activa: agrega B (automática) y C (manual); en D la rechazaron. */
  let persona: string;
  let personaId: string;
  let codigoB: string;
  const conToken = (t: string) => ({ Authorization: `Bearer ${t}` });
  const agregar = (token: string, correo: string, extra: object = {}) =>
    e
      .api()
      .post('/api/v1/membresias')
      .set(conToken(token))
      .send({ correo, ...extra });
  const confirmar = (token: string, correo: string, codigo: string) =>
    e
      .api()
      .post('/api/v1/membresias/confirmar')
      .set(conToken(token))
      .send({ correo, codigo });
  const activar = (token: string, organizacionId: string) =>
    e
      .api()
      .put('/api/v1/yo/organizacion-activa')
      .set(conToken(token))
      .send({ organizacionId });
  const reenviar = (correo: string) =>
    e
      .api()
      .post('/api/v1/autenticacion/reenviar-codigo')
      .send({ correo, proposito: 'agregar_organizacion' });
  const yo = async (token: string) =>
    (await e.api().get('/api/v1/yo').set(conToken(token)).expect(200)).body;
  const filas = async (correo: string) =>
    (
      await e.bd.query(
        `SELECT * FROM codigos_otp WHERE correo = $1 ORDER BY creado_en`,
        [correo],
      )
    ).rows;
  const membresiasDe = async (usuarioId: string) =>
    (
      await e.bd.query(
        `SELECT organizacion_id, estado, correo_institucional FROM membresias WHERE usuario_id = $1 ORDER BY creado_en`,
        [usuarioId],
      )
    ).rows;
  const activaEnBd = async (usuarioId: string) =>
    (
      await e.bd.query(
        `SELECT ultima_organizacion_id FROM usuarios WHERE id = $1`,
        [usuarioId],
      )
    ).rows[0].ultima_organizacion_id;
  const orgDelToken = async (token: string) =>
    (await e.app.get(JwtService).verifyAsync(token)).org;
  const pasarMinuto = (correo: string) =>
    e.bd.query(
      `UPDATE codigos_otp SET creado_en = creado_en - interval '2 minutes' WHERE correo = $1`,
      [correo],
    );
  const otroCodigo = (codigo: string) =>
    String((Number(codigo) + 1) % 1_000_000).padStart(6, '0');
  const idDe = async (correo: string) =>
    (await e.bd.query(`SELECT id FROM usuarios WHERE correo = $1`, [correo]))
      .rows[0].id as string;

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    const superToken = await e.iniciar(`super${DOMINIO}`);
    a = await organizacionConDominio(
      e,
      superToken,
      'Var A',
      'va.hu01.test',
      'automatica',
    );
    b = await organizacionConDominio(
      e,
      superToken,
      'Var B',
      'vb.hu01.test',
      'automatica',
    );
    c = await organizacionConDominio(
      e,
      superToken,
      'Var C',
      'vc.hu01.test',
      'manual',
    );
    d = await organizacionConDominio(
      e,
      superToken,
      'Var D',
      'vd.hu01.test',
      'manual',
    );
    persona = await miembroCon(e, a.id, 'persona@va.hu01.test', 'aprobada');
    personaId = await idDe('persona@va.hu01.test');
    await e.bd.query(
      `INSERT INTO membresias (organizacion_id, usuario_id, rol, estado, correo_institucional) VALUES ($1, $2, 'miembro', 'rechazada', 'persona@vd.hu01.test')`,
      [d.id, personaId],
    );
  }, 90_000); // cuatro altas con invitación y afiliación
  beforeEach(() => {
    correos = buzon(e);
  });
  afterAll(() => e.cerrar());

  it('CA-1: con un correo de B envía un código de 6 dígitos que vence en 10 minutos; todavía no hay membresía', async () => {
    const correo = 'persona@vb.hu01.test';
    const antes = Date.now();
    const r = await agregar(persona, ' Persona@VB.hu01.test ').expect(202);
    expect(Object.keys(r.body)).toEqual(['reenviarEn']);
    expect(new Date(r.body.reenviarEn).getTime()).toBeGreaterThanOrEqual(
      antes + 59_000,
    );
    expect(correos.enviados).toHaveLength(1);
    expect(correos.enviados[0].para).toBe(correo);
    expect(correos.enviados[0].texto).toContain('10 minutos');
    codigoB = correos.codigoPara(correo)!;
    expect(codigoB).toMatch(/^\d{6}$/);

    const [fila] = await filas(correo);
    expect(fila.proposito).toBe('agregar_organizacion');
    expect(fila.hash_codigo).toMatch(/^[0-9a-f]{64}$/);
    // La organización sale del dominio; el código queda atado a quien lo pidió.
    expect(fila.datos).toEqual({ usuarioId: personaId, organizacionId: b.id });
    const vigencia = new Date(fila.vence_en).getTime() - antes;
    expect(vigencia).toBeGreaterThan(9.9 * 60_000);
    expect(vigencia).toBeLessThan(10.1 * 60_000);
    // RN-1: pedirlo no basta.
    expect(await membresiasDe(personaId)).toHaveLength(2);
  });

  it('CA-2: código correcto en B (automática) → membresía aprobada, auditoría; la activa sigue siendo A', async () => {
    const correo = 'persona@vb.hu01.test';
    const r = await confirmar(persona, correo, codigoB).expect(200);
    expect(r.body).toEqual({
      membresia: {
        organizacionId: b.id,
        organizacion: 'HU01 Var B',
        rol: 'miembro',
        estado: 'aprobada',
      },
    });
    expect(await membresiasDe(personaId)).toContainEqual({
      organizacion_id: b.id,
      estado: 'aprobada',
      correo_institucional: correo,
    });
    const { rows: auditoria } = await e.bd.query(
      `SELECT organizacion_id, resultado, detalle FROM registros_auditoria WHERE accion = 'membresia.agregar' AND actor_id = $1`,
      [personaId],
    );
    expect(auditoria).toEqual([
      {
        organizacion_id: b.id,
        resultado: 'ok',
        detalle: { estadoMembresia: 'aprobada' },
      },
    ]);
    expect(await activaEnBd(personaId)).toBe(a.id);
    // Un solo uso.
    const [fila] = await filas(correo);
    expect(fila.usado_en).not.toBeNull();
    expect(fila.datos).toEqual({});
    expect(
      (await confirmar(persona, correo, '123456').expect(400)).body.codigo,
    ).toBe('OTP_INVALIDO');
  });

  it('CA-2: en C (manual) la membresía queda pendiente', async () => {
    const correo = 'persona@vc.hu01.test';
    await agregar(persona, correo).expect(202);
    const r = await confirmar(
      persona,
      correo,
      correos.codigoPara(correo)!,
    ).expect(200);
    expect(r.body.membresia).toEqual({
      organizacionId: c.id,
      organizacion: 'HU01 Var C',
      rol: 'miembro',
      estado: 'pendiente',
    });
    expect(await activaEnBd(personaId)).toBe(a.id);
  });

  it('CA-3: la lista de sus organizaciones trae cada estado y cuál está activa', async () => {
    const cuerpo = await yo(persona);
    expect(cuerpo.organizacionActiva).toBe(a.id);
    expect(cuerpo.membresias).toEqual([
      {
        organizacionId: a.id,
        organizacion: 'HU01 Var A',
        rol: 'miembro',
        estado: 'aprobada',
      },
      {
        organizacionId: d.id,
        organizacion: 'HU01 Var D',
        rol: 'miembro',
        estado: 'rechazada',
      },
      {
        organizacionId: b.id,
        organizacion: 'HU01 Var B',
        rol: 'miembro',
        estado: 'aprobada',
      },
      {
        organizacionId: c.id,
        organizacion: 'HU01 Var C',
        rol: 'miembro',
        estado: 'pendiente',
      },
    ]);
  });

  it('CA-4: elegir B como activa da un token nuevo con org = B, sin cerrar sesión; se recuerda para el próximo inicio (RN-6)', async () => {
    const login = await e
      .api()
      .post('/api/v1/autenticacion/iniciar-sesion')
      .send({
        correo: 'persona@va.hu01.test',
        contrasena: CONTRASENA,
        tipoCliente: 'movil',
      })
      .expect(200);
    expect(await orgDelToken(login.body.tokenAcceso)).toBe(a.id);
    const r = await activar(login.body.tokenAcceso, b.id).expect(200);
    expect(Object.keys(r.body)).toEqual(['tokenAcceso']);
    const token = await e.app.get(JwtService).verifyAsync(r.body.tokenAcceso);
    expect(token).toMatchObject({ sub: personaId, org: b.id, cli: 'movil' });
    expect((await yo(r.body.tokenAcceso)).organizacionActiva).toBe(b.id);
    expect(await activaEnBd(personaId)).toBe(b.id);

    // El refresco no cambia: la renovación siguiente ya trae B.
    const renovada = await e
      .api()
      .post('/api/v1/autenticacion/refrescar')
      .send({ tokenRefresco: login.body.tokenRefresco })
      .expect(200);
    expect(await orgDelToken(renovada.body.tokenAcceso)).toBe(b.id);
    const otroInicio = await e.iniciar('persona@va.hu01.test');
    expect(await orgDelToken(otroInicio)).toBe(b.id);

    // Y se puede volver a A.
    const deVuelta = await activar(otroInicio, a.id).expect(200);
    expect(await orgDelToken(deVuelta.body.tokenAcceso)).toBe(a.id);
    persona = deVuelta.body.tokenAcceso;
  });

  it('CA-4: en web el token nuevo sigue siendo de web', async () => {
    const login = await e
      .api()
      .post('/api/v1/autenticacion/iniciar-sesion')
      .send({
        correo: 'persona@va.hu01.test',
        contrasena: CONTRASENA,
        tipoCliente: 'web',
      })
      .expect(200);
    const r = await activar(login.body.tokenAcceso, b.id).expect(200);
    expect(
      await e.app.get(JwtService).verifyAsync(r.body.tokenAcceso),
    ).toMatchObject({ org: b.id, cli: 'web' });
    await activar(r.body.tokenAcceso, a.id).expect(200);
  });

  it('CA-5: no se puede activar una pendiente, una rechazada ni una sin membresía (misma respuesta)', async () => {
    const respuestas = [];
    // C pendiente, D rechazada, una organización que no existe.
    for (const id of [c.id, d.id, '00000000-0000-4000-8000-000000000000']) {
      const r = await activar(persona, id).expect(403);
      respuestas.push(r.body);
    }
    // Alguien solo de A pide B, que existe pero no es suya.
    const soloA = await miembroCon(e, a.id, `soloa${DOMINIO}`, 'aprobada');
    respuestas.push((await activar(soloA, b.id).expect(403)).body);
    for (const r of respuestas) expect(r).toEqual(respuestas[0]);
    expect(respuestas[0]).toEqual({
      codigo: 'MEMBRESIA_NO_APROBADA',
      mensaje:
        'Solo puedes elegir una organización donde tu membresía esté aprobada.',
    });
    expect(await activaEnBd(personaId)).toBe(a.id);
    // Id mal formado u organización en otro campo: validación.
    await activar(persona, 'no-es-un-uuid').expect(400);
    await e
      .api()
      .put('/api/v1/yo/organizacion-activa')
      .set(conToken(persona))
      .send({})
      .expect(400);
  });

  it('CA-7: ya es miembro (aprobada o pendiente) → YA_ES_MIEMBRO; rechazada → MEMBRESIA_RECHAZADA; sin enviar código', async () => {
    const casos: [string, string][] = [
      ['persona@va.hu01.test', 'YA_ES_MIEMBRO'], // aprobada, su correo de cuenta
      ['otro.correo@vb.hu01.test', 'YA_ES_MIEMBRO'], // aprobada, con otro correo de B
      ['persona@vc.hu01.test', 'YA_ES_MIEMBRO'], // pendiente
      ['persona@vd.hu01.test', 'MEMBRESIA_RECHAZADA'], // HU-03 RN-4
    ];
    for (const [correo, codigo] of casos) {
      const antes = (await filas(correo)).length;
      const r = await agregar(persona, correo).expect(409);
      expect(r.body.codigo).toBe(codigo);
      expect(await filas(correo)).toHaveLength(antes);
    }
    expect(correos.enviados).toHaveLength(0);
    expect(
      (await agregar(persona, 'persona@va.hu01.test').expect(409)).body.mensaje,
    ).toBe(
      'Ya eres miembro de esta organización o tu solicitud está pendiente.',
    );
  });

  it('CA-7: un correo que ya usa otra persona → CORREO_EN_USO', async () => {
    // Otra cuenta con membresía en B con ese correo institucional, y otra cuya cuenta es ese correo.
    const otra = await e.crearUsuario(`otra${DOMINIO}`);
    await e.bd.query(
      `INSERT INTO membresias (organizacion_id, usuario_id, rol, estado, correo_institucional) VALUES ($1, $2, 'miembro', 'aprobada', 'Tomado@vb.hu01.test')`,
      [b.id, otra],
    );
    await e.crearUsuario('cuenta@vc.hu01.test');
    const nueva = await miembroCon(e, a.id, `nueva${DOMINIO}`, 'aprobada');
    for (const correo of ['tomado@vb.hu01.test', 'CUENTA@vc.hu01.test']) {
      const r = await agregar(nueva, correo).expect(409);
      expect(r.body.codigo).toBe('CORREO_EN_USO');
    }
    expect(correos.enviados).toHaveLength(0);
  });

  it('dominio no afiliado → ORGANIZACION_NO_AFILIADA y no se envía código', async () => {
    for (const correo of ['persona@gmail.com', 'persona@nada.hu01.test']) {
      const r = await agregar(persona, correo).expect(422);
      expect(r.body.codigo).toBe('ORGANIZACION_NO_AFILIADA');
      expect(await filas(correo)).toHaveLength(0);
    }
    expect(correos.enviados).toHaveLength(0);
  });

  it('CA-1: mismas reglas que el registro: reenvío 1 por minuto, el anterior deja de servir, vencido y bloqueo tras 5 errores', async () => {
    const token = await miembroCon(e, a.id, `reglas${DOMINIO}`, 'aprobada');
    const correo = 'reglas@vb.hu01.test';
    await agregar(token, correo).expect(202);
    const primero = correos.codigoPara(correo)!;
    // Reenvío por el endpoint del registro con este propósito (la app reutiliza la pantalla Código).
    expect((await reenviar(correo).expect(429)).body.codigo).toBe(
      'OTP_LIMITE_REENVIO',
    );
    expect((await agregar(token, correo).expect(429)).body.codigo).toBe(
      'OTP_LIMITE_REENVIO',
    );
    await pasarMinuto(correo);
    await reenviar(correo).expect(202);
    const segundo = correos.codigoPara(correo)!;
    const [anterior, vigente] = await filas(correo);
    expect(anterior.invalidado_en).not.toBeNull();
    expect(vigente.datos.organizacionId).toBe(b.id);
    if (primero !== segundo)
      expect(
        (await confirmar(token, correo, primero).expect(400)).body.codigo,
      ).toBe('OTP_INVALIDO');

    // Vencido: se dice aparte.
    await e.bd.query(
      `UPDATE codigos_otp SET vence_en = now() - interval '1 second' WHERE correo = $1 AND usado_en IS NULL AND invalidado_en IS NULL`,
      [correo],
    );
    const vencido = await confirmar(token, correo, segundo).expect(410);
    expect(vencido.body.codigo).toBe('OTP_VENCIDO');

    await pasarMinuto(correo);
    await reenviar(correo).expect(202);
    const tercero = correos.codigoPara(correo)!;
    // Los errores se suman por correo (incluido el de `primero`, si lo hubo): se bloquea al quinto.
    let r;
    do {
      r = await confirmar(token, correo, otroCodigo(tercero));
    } while (r.status === 400);
    expect(r.status).toBe(429);
    expect(r.body.codigo).toBe('OTP_BLOQUEADO');
    const hasta = new Date(r.body.reintentarEn).getTime();
    expect(hasta).toBeGreaterThan(Date.now() + 14.9 * 60_000);
    expect(
      (await confirmar(token, correo, tercero).expect(429)).body.codigo,
    ).toBe('OTP_BLOQUEADO');
    await pasarMinuto(correo);
    expect((await agregar(token, correo).expect(429)).body.codigo).toBe(
      'OTP_BLOQUEADO',
    );
    expect(await membresiasDe(await idDe(`reglas${DOMINIO}`))).toHaveLength(1);
  });

  it('sin organización activa (solo pendiente) agrega una automática y esta queda activa', async () => {
    const id = await e.crearUsuario(`sinactiva${DOMINIO}`);
    await e.bd.query(
      `INSERT INTO membresias (organizacion_id, usuario_id, rol, estado) VALUES ($1, $2, 'miembro', 'pendiente')`,
      [c.id, id],
    );
    const token = await e.iniciar(`sinactiva${DOMINIO}`);
    expect(await orgDelToken(token)).toBeNull();
    const correo = 'sinactiva@vb.hu01.test';
    await agregar(token, correo).expect(202);
    await confirmar(token, correo, correos.codigoPara(correo)!).expect(200);
    expect(await activaEnBd(id)).toBe(b.id);
    expect(await orgDelToken(await e.iniciar(`sinactiva${DOMINIO}`))).toBe(
      b.id,
    );
  });

  it('si el correo falla no se guarda nada y se puede reintentar', async () => {
    const token = await miembroCon(e, a.id, `caido${DOMINIO}`, 'aprobada');
    const correo = 'caido@vb.hu01.test';
    e.correos.enviador = {
      enviar: async () => {
        throw new Error('SES caído');
      },
    };
    const r = await agregar(token, correo).expect(503);
    expect(r.body.codigo).toBe('CORREO_NO_DISPONIBLE');
    expect(await filas(correo)).toHaveLength(0);
    correos = buzon(e);
    await agregar(token, correo).expect(202);
  });

  it('autenticación y validación', async () => {
    await e
      .api()
      .post('/api/v1/membresias')
      .send({ correo: 'x@vb.hu01.test' })
      .expect(401);
    await e
      .api()
      .post('/api/v1/membresias/confirmar')
      .send({ correo: 'x@vb.hu01.test', codigo: '123456' })
      .expect(401);
    await e
      .api()
      .put('/api/v1/yo/organizacion-activa')
      .send({ organizacionId: b.id })
      .expect(401);
    await agregar(persona, 'no-es-correo').expect(400);
    await confirmar(persona, 'persona@vb.hu01.test', '12ab56').expect(400);
  });
});
