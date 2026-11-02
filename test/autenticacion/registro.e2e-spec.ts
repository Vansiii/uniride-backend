import {
  buzon,
  CONTRASENA,
  organizacionConDominio,
  prepararEntorno,
  DOMINIO,
  type Entorno,
} from '../ayudas-organizaciones.js';

describe('HU-05 · Registro con correo institucional (e2e)', () => {
  let e: Entorno;
  let correos: ReturnType<typeof buzon>;
  let a: Awaited<ReturnType<typeof organizacionConDominio>>; // automática
  let b: Awaited<ReturnType<typeof organizacionConDominio>>; // manual
  const ruta = (r: string) => `/api/v1/autenticacion/${r}`;
  const registrar = (correo: string, extra: object = {}) =>
    e
      .api()
      .post(ruta('registro'))
      .send({
        nombreCompleto: 'Ana Pérez',
        correo,
        contrasena: CONTRASENA,
        aceptaTratamientoDatos: true,
        ...extra,
      });
  const verificar = (correo: string, codigo: string) =>
    e.api().post(ruta('verificar-otp')).send({ correo, codigo });
  const reenviar = (correo: string) =>
    e
      .api()
      .post(ruta('reenviar-codigo'))
      .send({ correo, proposito: 'registro' });
  const filas = async (correo: string) =>
    (
      await e.bd.query(
        `SELECT * FROM codigos_otp WHERE correo = $1 ORDER BY creado_en`,
        [correo],
      )
    ).rows;
  const cuentas = async (correo: string) =>
    (await e.bd.query(`SELECT * FROM usuarios WHERE correo = $1`, [correo]))
      .rows;
  // RN-4: simula que pasaron 2 minutos desde el último envío.
  const pasarMinuto = (correo: string) =>
    e.bd.query(
      `UPDATE codigos_otp SET creado_en = creado_en - interval '2 minutes' WHERE correo = $1`,
      [correo],
    );
  const otroCodigo = (codigo: string) =>
    String((Number(codigo) + 1) % 1_000_000).padStart(6, '0');

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    const superToken = await e.iniciar(`super${DOMINIO}`);
    a = await organizacionConDominio(
      e,
      superToken,
      'Reg A',
      'a.hu01.test',
      'automatica',
    );
    b = await organizacionConDominio(
      e,
      superToken,
      'Reg B',
      'b.hu01.test',
      'manual',
    );
  }, 60_000); // dos altas con invitación y afiliación: bajo carga pasa de los 10 s por defecto
  beforeEach(() => {
    correos = buzon(e);
  });
  afterAll(() => e.cerrar());

  it('CA-1: con dominio afiliado envía un código de 6 dígitos que vence en 10 minutos; no crea la cuenta todavía', async () => {
    const correo = 'ana@a.hu01.test';
    const antes = Date.now();
    const r = await registrar(' Ana@A.hu01.test ').expect(202);
    expect(Object.keys(r.body)).toEqual(['reenviarEn']);
    const reenviarEn = new Date(r.body.reenviarEn).getTime();
    expect(reenviarEn).toBeGreaterThanOrEqual(antes + 59_000);
    expect(reenviarEn).toBeLessThanOrEqual(Date.now() + 61_000);

    expect(correos.enviados).toHaveLength(1);
    expect(correos.enviados[0].para).toBe(correo);
    expect(correos.enviados[0].texto).toContain('10 minutos');
    const codigo = correos.codigoPara(correo)!;
    expect(codigo).toMatch(/^\d{6}$/);

    const [fila] = await filas(correo);
    // RN-6: solo el HMAC del código y el hash de la contraseña.
    expect(fila.hash_codigo).toMatch(/^[0-9a-f]{64}$/);
    expect(fila.hash_codigo).not.toContain(codigo);
    expect(JSON.stringify(fila.datos)).not.toContain(CONTRASENA);
    expect(fila.datos.hashContrasena).toMatch(/^\$2[aby]\$/);
    expect(fila.datos.organizacionId).toBe(a.id);
    const vigencia = new Date(fila.vence_en).getTime() - antes;
    expect(vigencia).toBeGreaterThan(9.9 * 60_000);
    expect(vigencia).toBeLessThan(10.1 * 60_000);
    // RN-8: sin código confirmado no hay cuenta.
    expect(await cuentas(correo)).toHaveLength(0);
  });

  it('CA-2: automática → aprobada, con sesión, consentimiento con fecha y auditoría', async () => {
    const correo = 'beto@a.hu01.test';
    await registrar(correo).expect(202);
    const r = await verificar(correo, correos.codigoPara(correo)!).expect(200);
    expect(r.body.estadoMembresia).toBe('aprobada');
    expect(r.body.tokenAcceso).toBeTruthy();
    expect(r.body.tokenRefresco).toBeTruthy();

    const yo = await e
      .api()
      .get('/api/v1/yo')
      .set({ Authorization: `Bearer ${r.body.tokenAcceso}` })
      .expect(200);
    expect(yo.body).toMatchObject({
      correo,
      nombreCompleto: 'Ana Pérez',
      organizacionActiva: a.id,
      membresias: [
        {
          organizacionId: a.id,
          organizacion: 'HU01 Reg A',
          rol: 'miembro',
          estado: 'aprobada',
        },
      ],
    });

    const [cuenta] = await cuentas(correo);
    expect(cuenta.hash_contrasena).toMatch(/^\$2[aby]\$/);
    expect(cuenta.consentimiento_datos_en).not.toBeNull();
    const { rows: membresias } = await e.bd.query(
      `SELECT organizacion_id, estado, correo_institucional FROM membresias WHERE usuario_id = $1`,
      [cuenta.id],
    );
    expect(membresias).toEqual([
      {
        organizacion_id: a.id,
        estado: 'aprobada',
        correo_institucional: correo,
      },
    ]);
    const { rows: auditoria } = await e.bd.query(
      `SELECT organizacion_id, resultado, detalle FROM registros_auditoria WHERE accion = 'registro.alta' AND actor_id = $1`,
      [cuenta.id],
    );
    expect(auditoria).toEqual([
      {
        organizacion_id: a.id,
        resultado: 'ok',
        detalle: { estadoMembresia: 'aprobada' },
      },
    ]);
    // Un solo uso, y los datos del código (hash de la contraseña) se borran.
    const [fila] = await filas(correo);
    expect(fila.usado_en).not.toBeNull();
    expect(fila.datos).toEqual({});
    const otra = await verificar(correo, correos.codigoPara(correo)!).expect(
      400,
    );
    expect(otra.body.codigo).toBe('OTP_INVALIDO');
    // Con la cuenta creada, inicia sesión con su contraseña (HU-06).
    await e.iniciar(correo);
  });

  it('CA-2: manual → pendiente y sin organización activa', async () => {
    const correo = 'carla@b.hu01.test';
    await registrar(correo).expect(202);
    const r = await verificar(correo, correos.codigoPara(correo)!).expect(200);
    expect(r.body.estadoMembresia).toBe('pendiente');
    const yo = await e
      .api()
      .get('/api/v1/yo')
      .set({ Authorization: `Bearer ${r.body.tokenAcceso}` })
      .expect(200);
    expect(yo.body.organizacionActiva).toBeNull();
    expect(yo.body.membresias).toEqual([
      {
        organizacionId: b.id,
        organizacion: 'HU01 Reg B',
        rol: 'miembro',
        estado: 'pendiente',
      },
    ]);
  });

  it('CA-3: dominio no afiliado → ORGANIZACION_NO_AFILIADA y no se envía código', async () => {
    for (const correo of [
      'dario@noafiliada.hu01.test',
      'dario@gmail.com',
      'dario@sub.a.hu01.test',
    ]) {
      const r = await registrar(correo).expect(422);
      expect(r.body.codigo).toBe('ORGANIZACION_NO_AFILIADA');
      expect(r.body.mensaje).toBe(
        'Tu organización no está afiliada a UniRide.',
      );
      expect(await filas(correo)).toHaveLength(0);
    }
    expect(correos.enviados).toHaveLength(0);
  });

  it('CA-4: 5 códigos erróneos seguidos bloquean 15 minutos, aunque luego el código sea correcto', async () => {
    const correo = 'eva@a.hu01.test';
    await registrar(correo).expect(202);
    const codigo = correos.codigoPara(correo)!;
    for (let i = 1; i <= 4; i++) {
      const r = await verificar(correo, otroCodigo(codigo)).expect(400);
      expect(r.body.codigo).toBe('OTP_INVALIDO');
    }
    const quinto = await verificar(correo, otroCodigo(codigo)).expect(429);
    expect(quinto.body.codigo).toBe('OTP_BLOQUEADO');
    const hasta = new Date(quinto.body.reintentarEn).getTime();
    expect(hasta).toBeGreaterThan(Date.now() + 14.9 * 60_000);
    expect(hasta).toBeLessThan(Date.now() + 15.1 * 60_000);

    const sexto = await verificar(correo, codigo).expect(429);
    expect(sexto.body.codigo).toBe('OTP_BLOQUEADO');
    // Ni registrarse de nuevo ni pedir otro código levantan el bloqueo.
    await pasarMinuto(correo);
    expect((await registrar(correo).expect(429)).body.codigo).toBe(
      'OTP_BLOQUEADO',
    );
    expect((await reenviar(correo).expect(429)).body.codigo).toBe(
      'OTP_BLOQUEADO',
    );
    expect(await cuentas(correo)).toHaveLength(0);
    const { rows } = await e.bd.query(
      `SELECT 1 FROM registros_auditoria WHERE accion = 'otp.bloqueo' AND entidad_id = $1`,
      [(await filas(correo))[0].id],
    );
    expect(rows).toHaveLength(1);
  });

  it('CA-5: un código vencido se rechaza y se puede pedir uno nuevo', async () => {
    const correo = 'fabi@a.hu01.test';
    await registrar(correo).expect(202);
    const viejo = correos.codigoPara(correo)!;
    await e.bd.query(
      `UPDATE codigos_otp SET vence_en = now() - interval '1 second', creado_en = creado_en - interval '11 minutes' WHERE correo = $1`,
      [correo],
    );
    const r = await verificar(correo, viejo).expect(410);
    expect(r.body.codigo).toBe('OTP_VENCIDO');
    expect(r.body.mensaje).toBe('El código venció. Pide uno nuevo.');
    await reenviar(correo).expect(202);
    const nuevo = correos.codigoPara(correo)!;
    const ok = await verificar(correo, nuevo).expect(200);
    expect(ok.body.estadoMembresia).toBe('aprobada');
  });

  it('CA-6: pedir un código nuevo invalida el anterior; máximo uno por minuto', async () => {
    const correo = 'gabi@a.hu01.test';
    await registrar(correo).expect(202);
    const primero = correos.codigoPara(correo)!;
    const pronto = await reenviar(correo).expect(429);
    expect(pronto.body.codigo).toBe('OTP_LIMITE_REENVIO');
    expect(new Date(pronto.body.reenviarEn).getTime()).toBeGreaterThan(
      Date.now(),
    );
    await pasarMinuto(correo);
    await reenviar(correo).expect(202);
    const segundo = correos.codigoPara(correo)!;
    expect(correos.enviados.filter((c) => c.para === correo)).toHaveLength(2);
    const [anterior, vigente] = await filas(correo);
    expect(anterior.invalidado_en).not.toBeNull();
    expect(anterior.datos).toEqual({});
    expect(vigente.invalidado_en).toBeNull();
    // Los datos del registro pasan al código nuevo.
    expect(vigente.datos.organizacionId).toBe(a.id);
    if (primero !== segundo)
      expect((await verificar(correo, primero).expect(400)).body.codigo).toBe(
        'OTP_INVALIDO',
      );
    await verificar(correo, segundo).expect(200);
  });

  it('RN-4: máximo 5 códigos por hora', async () => {
    const correo = 'hugo@a.hu01.test';
    for (let i = 0; i < 5; i++) {
      await (i === 0 ? registrar(correo) : reenviar(correo)).expect(202);
      await pasarMinuto(correo);
    }
    const r = await reenviar(correo).expect(429);
    expect(r.body.codigo).toBe('OTP_LIMITE_REENVIO');
    // El más antiguo fue hace ~10 min: el próximo, en ~50 min.
    expect(new Date(r.body.reenviarEn).getTime()).toBeGreaterThan(
      Date.now() + 45 * 60_000,
    );
    expect((await registrar(correo).expect(429)).body.codigo).toBe(
      'OTP_LIMITE_REENVIO',
    );
  });

  it('doble envío del formulario: un solo código vigente', async () => {
    const correo = 'ines@a.hu01.test';
    const respuestas = await Promise.all([
      registrar(correo),
      registrar(correo),
    ]);
    expect(respuestas.map((r) => r.status).sort()).toEqual([202, 429]);
    const vigentes = (await filas(correo)).filter(
      (f) => !f.usado_en && !f.invalidado_en,
    );
    expect(vigentes).toHaveLength(1);
    expect(correos.enviados).toHaveLength(1);
  });

  it('CA-7: un correo con cuenta recibe la misma respuesta que un registro normal y un aviso, sin código', async () => {
    const existente = 'juan@a.hu01.test';
    const nuevo = 'karen@a.hu01.test';
    await e.crearUsuario(existente);
    const rExistente = await registrar(existente).expect(202);
    const rNuevo = await registrar(nuevo).expect(202);
    expect(Object.keys(rExistente.body)).toEqual(Object.keys(rNuevo.body));
    // Los límites también son los mismos.
    const [otraExistente, otraNueva] = [
      await registrar(existente).expect(429),
      await registrar(nuevo).expect(429),
    ];
    expect(otraExistente.body.codigo).toBe(otraNueva.body.codigo);
    expect((await reenviar(existente).expect(429)).body.codigo).toBe(
      'OTP_LIMITE_REENVIO',
    );

    const aviso = correos.enviados.filter((c) => c.para === existente);
    expect(aviso).toHaveLength(1);
    expect(aviso[0].asunto).toBe('Ya tienes una cuenta en UniRide');
    expect(correos.codigoPara(existente)).toBeUndefined();
    // Cualquier código falla como uno equivocado; la cuenta sigue igual.
    const r = await verificar(existente, '123456').expect(400);
    expect(r.body.codigo).toBe('OTP_INVALIDO');
    expect(await cuentas(existente)).toHaveLength(1);
    await e.iniciar(existente);
  });

  it('CA-9: sin aceptar el tratamiento de datos no hay registro', async () => {
    const correo = 'luis@a.hu01.test';
    const r = await registrar(correo, { aceptaTratamientoDatos: false }).expect(
      400,
    );
    expect(r.body.codigo).toBe('CONSENTIMIENTO_REQUERIDO');
    const sinCampo = await e
      .api()
      .post(ruta('registro'))
      .send({ nombreCompleto: 'Luis', correo, contrasena: CONTRASENA })
      .expect(400);
    expect(sinCampo.body.codigo).toBe('VALIDACION_FALLIDA');
    expect(await filas(correo)).toHaveLength(0);
    expect(correos.enviados).toHaveLength(0);
  });

  it('RN-5: contraseña débil → CONTRASENA_DEBIL', async () => {
    for (const contrasena of ['corta1', 'soloLetrasAqui', '12345678'])
      expect(
        (await registrar('mario@a.hu01.test', { contrasena }).expect(400)).body
          .codigo,
      ).toBe('CONTRASENA_DEBIL');
    expect(correos.enviados).toHaveLength(0);
  });

  it('si el correo falla no se guarda nada y se pide reintentar', async () => {
    const correo = 'nora@a.hu01.test';
    e.correos.enviador = {
      enviar: async () => {
        throw new Error('SES caído');
      },
    };
    const r = await registrar(correo).expect(503);
    expect(r.body.codigo).toBe('CORREO_NO_DISPONIBLE');
    expect(await filas(correo)).toHaveLength(0);
    // Sin fila no cuenta para el límite: puede reintentar en seguida.
    correos = buzon(e);
    await registrar(correo).expect(202);
  });

  it('reenviar sin registro pendiente responde igual y no envía nada', async () => {
    const r = await reenviar('nadie@a.hu01.test').expect(202);
    expect(Object.keys(r.body)).toEqual(['reenviarEn']);
    expect(correos.enviados).toHaveLength(0);
  });

  it('validación: código con formato inválido o propósito desconocido', async () => {
    await e
      .api()
      .post(ruta('verificar-otp'))
      .send({ correo: 'ana@a.hu01.test', codigo: '12ab56' })
      .expect(400);
    await e
      .api()
      .post(ruta('reenviar-codigo'))
      .send({ correo: 'ana@a.hu01.test', proposito: 'otro' })
      .expect(400);
  });
});
