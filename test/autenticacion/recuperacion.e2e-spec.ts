import bcrypt from 'bcryptjs';
import {
  buzon,
  CONTRASENA,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';

const NUEVA = 'NuevaClave99';

describe('HU-34 · Recuperación de contraseña (e2e)', () => {
  let e: Entorno;
  let correos: ReturnType<typeof buzon>;
  const ruta = (r: string) => `/api/v1/autenticacion/${r}`;
  const solicitar = (correo: string) =>
    e.api().post(ruta('recuperar-contrasena')).send({ correo });
  const restablecer = (
    correo: string,
    codigo: string,
    contrasenaNueva = NUEVA,
  ) =>
    e
      .api()
      .post(ruta('restablecer-contrasena'))
      .send({ correo, codigo, contrasenaNueva });
  const reenviar = (correo: string) =>
    e
      .api()
      .post(ruta('reenviar-codigo'))
      .send({ correo, proposito: 'recuperacion' });
  const iniciar = (correo: string, contrasena: string) =>
    e
      .api()
      .post(ruta('iniciar-sesion'))
      .send({ correo, contrasena, tipoCliente: 'movil' });
  // Los correos de recuperación salen por la cola: el worker los entrega.
  const entregar = () => e.correos.procesarPendientes();
  const codigoDe = async (correo: string) => {
    await entregar();
    return correos.codigoPara(correo)!;
  };
  const filas = async (correo: string) =>
    (
      await e.bd.query(
        `SELECT * FROM codigos_otp WHERE correo = $1 AND proposito = 'recuperacion' ORDER BY creado_en`,
        [correo],
      )
    ).rows;
  const cola = async (correo: string) =>
    (
      await e.bd.query(
        `SELECT plantilla, estado, intentos, datos FROM correos_salientes WHERE destinatario = $1 ORDER BY creado_en`,
        [correo],
      )
    ).rows;
  const auditoria = async (accion: string, dominio: string) =>
    (
      await e.bd.query(
        `SELECT actor_id, entidad_id, resultado, detalle FROM registros_auditoria WHERE accion = $1 AND detalle->>'dominio' = $2 ORDER BY creado_en`,
        [accion, dominio],
      )
    ).rows;
  // RN-1: simula que pasaron 2 minutos desde el último envío.
  const pasarMinuto = (correo: string) =>
    e.bd.query(
      `UPDATE codigos_otp SET creado_en = creado_en - interval '2 minutes' WHERE correo = $1`,
      [correo],
    );
  const otroCodigo = (codigo: string) =>
    String((Number(codigo) + 1) % 1_000_000).padStart(6, '0');

  beforeAll(async () => {
    e = await prepararEntorno();
  });
  beforeEach(() => {
    correos = buzon(e);
  });
  afterAll(() => e.cerrar());

  it('CA-1: con cuenta, el código de 6 dígitos que vence en 10 minutos sale por la cola', async () => {
    const correo = 'rec.ana@hu01.test';
    const id = await e.crearUsuario(correo);
    const antes = Date.now();
    const r = await solicitar(' Rec.Ana@HU01.test ').expect(202);
    expect(Object.keys(r.body)).toEqual(['reenviarEn']);
    const reenviarEn = new Date(r.body.reenviarEn).getTime();
    expect(reenviarEn).toBeGreaterThanOrEqual(antes + 59_000);
    expect(reenviarEn).toBeLessThanOrEqual(Date.now() + 61_000);

    // No se envía en el momento: queda en la cola.
    expect(correos.enviados).toHaveLength(0);
    expect(await cola(correo)).toMatchObject([
      { plantilla: 'otp_recuperacion', estado: 'pendiente' },
    ]);
    const codigo = await codigoDe(correo);
    expect(codigo).toMatch(/^\d{6}$/);
    expect(correos.enviados).toHaveLength(1);
    expect(correos.enviados[0].texto).toContain('10 minutos');
    expect(correos.enviados[0].texto).toContain('cambiar la contraseña');
    // Enviado, la cola ya no guarda el código.
    expect(await cola(correo)).toMatchObject([
      { estado: 'enviado', datos: {} },
    ]);

    const [fila] = await filas(correo);
    expect(fila.hash_codigo).toMatch(/^[0-9a-f]{64}$/);
    expect(fila.hash_codigo).not.toContain(codigo);
    expect(fila.datos).toEqual({ usuarioId: id });
    const vigencia = new Date(fila.vence_en).getTime() - antes;
    expect(vigencia).toBeGreaterThan(9.9 * 60_000);
    expect(vigencia).toBeLessThan(10.1 * 60_000);
    // RN-6
    expect(await auditoria('recuperacion.solicitud', 'hu01.test')).toEqual([
      {
        actor_id: id,
        entidad_id: id,
        resultado: 'ok',
        detalle: { dominio: 'hu01.test', conCuenta: true },
      },
    ]);
  });

  it('CA-2: sin cuenta, misma respuesta y mismos límites, sin enviar nada', async () => {
    const existente = 'rec.beto@b.hu01.test';
    const nadie = 'rec.nadie@b.hu01.test';
    await e.crearUsuario(existente);
    const [rE, rN] = [
      await solicitar(existente).expect(202),
      await solicitar(nadie).expect(202),
    ];
    expect(Object.keys(rN.body)).toEqual(Object.keys(rE.body));
    // Ningún correo para quien no tiene cuenta, ni en la cola.
    expect(await cola(nadie)).toEqual([]);
    await entregar();
    expect(correos.enviados.filter((c) => c.para === nadie)).toHaveLength(0);
    expect(correos.codigoPara(existente)).toMatch(/^\d{6}$/);
    const [senuelo] = await filas(nadie);
    expect(senuelo.datos).toEqual({ senuelo: true });

    // El 429 tampoco revela nada: mismos límites por correo.
    const [lE, lN] = [
      await solicitar(existente).expect(429),
      await solicitar(nadie).expect(429),
    ];
    expect(lN.body.codigo).toBe('OTP_LIMITE_REENVIO');
    expect(lE.body.codigo).toBe(lN.body.codigo);
    expect(Object.keys(lN.body)).toEqual(Object.keys(lE.body));
    expect((await reenviar(nadie).expect(429)).body.codigo).toBe(
      'OTP_LIMITE_REENVIO',
    );
    await pasarMinuto(existente);
    await pasarMinuto(nadie);
    await reenviar(existente).expect(202);
    await reenviar(nadie).expect(202);
    await entregar();
    expect(correos.enviados.filter((c) => c.para === nadie)).toHaveLength(0);

    // Cualquier código para un correo sin cuenta falla como uno equivocado.
    const codigo = correos.codigoPara(existente)!;
    const [vE, vN] = [
      await restablecer(existente, otroCodigo(codigo)).expect(400),
      await restablecer(nadie, codigo).expect(400),
    ];
    expect(vN.body).toEqual(vE.body);
    expect(vN.body.codigo).toBe('OTP_INVALIDO');
    expect(
      await e.bd.query(`SELECT 1 FROM usuarios WHERE correo = $1`, [nadie]),
    ).toMatchObject({ rowCount: 0 });

    // RN-6: cada solicitud queda registrada, pero solo con el dominio.
    const eventos = await auditoria('recuperacion.solicitud', 'b.hu01.test');
    const sinCuenta = eventos.filter((f) => f.detalle.conCuenta === false);
    expect(sinCuenta.map((f) => f.resultado)).toEqual(['ok', 'fallo']);
    expect(sinCuenta.every((f) => f.actor_id === null)).toBe(true);
    expect(sinCuenta[1].detalle.motivo).toBe('OTP_LIMITE_REENVIO');
    expect(JSON.stringify(eventos)).not.toContain('rec.nadie');
  });

  it('CA-3: código correcto y contraseña válida → cambia, cierra todas las sesiones, levanta el bloqueo y avisa', async () => {
    const correo = 'rec.carla@hu01.test';
    const id = await e.crearUsuario(correo);
    const sesiones = [
      (await iniciar(correo, CONTRASENA).expect(200)).body,
      (await iniciar(correo, CONTRASENA).expect(200)).body,
    ];
    await e.bd.query(
      `UPDATE usuarios SET intentos_fallidos = 3, bloqueado_hasta = now() + interval '15 minutes' WHERE id = $1`,
      [id],
    );
    await solicitar(correo).expect(202);
    const codigo = await codigoDe(correo);
    const r = await restablecer(correo, codigo).expect(204);
    expect(r.body).toEqual({});

    const [cuenta] = (
      await e.bd.query(`SELECT * FROM usuarios WHERE id = $1`, [id])
    ).rows;
    expect(await bcrypt.compare(NUEVA, cuenta.hash_contrasena)).toBe(true);
    expect(cuenta.intentos_fallidos).toBe(0);
    expect(cuenta.bloqueado_hasta).toBeNull();
    // RN-3: todas las sesiones, no solo una.
    const { rows: tokens } = await e.bd.query(
      `SELECT revocado_en FROM tokens_refresco WHERE usuario_id = $1`,
      [id],
    );
    expect(tokens).toHaveLength(2);
    expect(tokens.every((t) => t.revocado_en !== null)).toBe(true);
    for (const s of sesiones) {
      const rr = await e
        .api()
        .post(ruta('refrescar'))
        .send({ tokenRefresco: s.tokenRefresco })
        .expect(401);
      expect(rr.body.codigo).toBe('SESION_EXPIRADA');
    }
    // Inicia con la nueva; la anterior ya no sirve.
    expect((await iniciar(correo, CONTRASENA).expect(401)).body.codigo).toBe(
      'CREDENCIALES_INVALIDAS',
    );
    await iniciar(correo, NUEVA).expect(200);

    // Aviso del cambio por la cola.
    expect((await cola(correo)).map((c) => c.plantilla)).toEqual([
      'otp_recuperacion',
      'contrasena_cambiada',
    ]);
    await entregar();
    const aviso = correos.enviados.filter((c) => c.para === correo).pop()!;
    expect(aviso.asunto).toBe('Tu contraseña de UniRide cambió');
    expect(aviso.texto).not.toMatch(/\b\d{6}\b/);

    expect(await auditoria('recuperacion.cambio', 'hu01.test')).toEqual([
      {
        actor_id: id,
        entidad_id: id,
        resultado: 'ok',
        detalle: { dominio: 'hu01.test' },
      },
    ]);
    // Un solo uso: el mismo código ya no sirve.
    const otra = await restablecer(correo, codigo, 'OtraClave77').expect(400);
    expect(otra.body.codigo).toBe('OTP_INVALIDO');
    await iniciar(correo, NUEVA).expect(200);
  });

  it(
    'CA-4: 5 códigos erróneos seguidos bloquean 15 minutos, con cuenta o sin ella',
    async () => {
      const existente = 'rec.eva@hu01.test';
      const nadie = 'rec.nadie2@hu01.test';
      await e.crearUsuario(existente);
      for (const correo of [existente, nadie]) {
        await solicitar(correo).expect(202);
        const codigo = (await codigoDe(correo)) ?? '123456';
        for (let i = 1; i <= 4; i++)
          expect(
            (await restablecer(correo, otroCodigo(codigo)).expect(400)).body
              .codigo,
          ).toBe('OTP_INVALIDO');
        const quinto = await restablecer(correo, otroCodigo(codigo)).expect(429);
        expect(quinto.body.codigo).toBe('OTP_BLOQUEADO');
        const hasta = new Date(quinto.body.reintentarEn).getTime();
        expect(hasta).toBeGreaterThan(Date.now() + 14.9 * 60_000);
        expect(hasta).toBeLessThan(Date.now() + 15.1 * 60_000);
        // Ni el código correcto, ni pedir otro, levantan el bloqueo.
        expect((await restablecer(correo, codigo).expect(429)).body.codigo).toBe(
          'OTP_BLOQUEADO',
        );
        await pasarMinuto(correo);
        expect((await solicitar(correo).expect(429)).body.codigo).toBe(
          'OTP_BLOQUEADO',
        );
        expect((await reenviar(correo).expect(429)).body.codigo).toBe(
          'OTP_BLOQUEADO',
        );
        const { rows } = await e.bd.query(
          `SELECT 1 FROM registros_auditoria WHERE accion = 'otp.bloqueo' AND entidad_id = $1`,
          [(await filas(correo))[0].id],
        );
        expect(rows).toHaveLength(1);
      }
      await iniciar(existente, CONTRASENA).expect(200);
    },
    20000,
  );

  it('CA-5: un código vencido se rechaza y se puede pedir otro; uno usado, también', async () => {
    const correo = 'rec.fabi@hu01.test';
    await e.crearUsuario(correo);
    await solicitar(correo).expect(202);
    const viejo = await codigoDe(correo);
    await e.bd.query(
      `UPDATE codigos_otp SET vence_en = now() - interval '1 second', creado_en = creado_en - interval '11 minutes' WHERE correo = $1`,
      [correo],
    );
    const r = await restablecer(correo, viejo).expect(410);
    expect(r.body.codigo).toBe('OTP_VENCIDO');
    expect(r.body.mensaje).toBe('El código venció. Pide uno nuevo.');
    await iniciar(correo, CONTRASENA).expect(200);

    await solicitar(correo).expect(202);
    const nuevo = await codigoDe(correo);
    await restablecer(correo, nuevo).expect(204);
    expect((await restablecer(correo, nuevo).expect(400)).body.codigo).toBe(
      'OTP_INVALIDO',
    );
  });

  it('CA-6: una contraseña débil se rechaza con el requisito y no gasta el código', async () => {
    const correo = 'rec.gabi@hu01.test';
    await e.crearUsuario(correo);
    await solicitar(correo).expect(202);
    const codigo = await codigoDe(correo);
    for (const contrasena of ['corta1', 'soloLetrasAqui', '12345678']) {
      const r = await restablecer(correo, codigo, contrasena).expect(400);
      expect(r.body.codigo).toBe('CONTRASENA_DEBIL');
      expect(r.body.mensaje).toBe(
        'La contraseña debe tener al menos 8 caracteres, con letras y números.',
      );
    }
    const [fila] = await filas(correo);
    expect(fila.usado_en).toBeNull();
    expect(fila.intentos).toBe(0);
    await iniciar(correo, CONTRASENA).expect(200);
    await restablecer(correo, codigo).expect(204);
    await iniciar(correo, NUEVA).expect(200);
  });

  it('si el correo falla, la respuesta es la misma, no cambia nada y el envío se reintenta solo', async () => {
    const correo = 'rec.nora@hu01.test';
    await e.crearUsuario(correo);
    e.correos.enviador = {
      enviar: async () => {
        throw new Error('SES caído');
      },
    };
    const r = await solicitar(correo).expect(202);
    expect(Object.keys(r.body)).toEqual(['reenviarEn']);
    await entregar();
    expect(await cola(correo)).toMatchObject([
      { plantilla: 'otp_recuperacion', estado: 'pendiente', intentos: 1 },
    ]);
    await iniciar(correo, CONTRASENA).expect(200);
    // Vuelve el servicio: el worker lo reintenta y el código sirve.
    correos = buzon(e);
    await e.bd.query(
      `UPDATE correos_salientes SET proximo_intento_en = now() WHERE destinatario = $1`,
      [correo],
    );
    const codigo = await codigoDe(correo);
    await restablecer(correo, codigo).expect(204);
  });

  it('doble envío del formulario: un solo código vigente', async () => {
    const correo = 'rec.ines@hu01.test';
    await e.crearUsuario(correo);
    const respuestas = await Promise.all([
      solicitar(correo),
      solicitar(correo),
    ]);
    expect(respuestas.map((r) => r.status).sort()).toEqual([202, 429]);
    const vigentes = (await filas(correo)).filter(
      (f) => !f.usado_en && !f.invalidado_en,
    );
    expect(vigentes).toHaveLength(1);
    expect(await cola(correo)).toHaveLength(1);
  });

  it('validación: correo, código o contraseña con formato inválido', async () => {
    for (const cuerpo of [{}, { correo: 'no-es-correo' }])
      expect(
        (
          await e
            .api()
            .post(ruta('recuperar-contrasena'))
            .send(cuerpo)
            .expect(400)
        ).body.codigo,
      ).toBe('VALIDACION_FALLIDA');
    for (const cuerpo of [
      { correo: 'rec.ana@hu01.test', codigo: '12ab56', contrasenaNueva: NUEVA },
      { correo: 'rec.ana@hu01.test', codigo: '123456' },
    ])
      expect(
        (
          await e
            .api()
            .post(ruta('restablecer-contrasena'))
            .send(cuerpo)
            .expect(400)
        ).body.codigo,
      ).toBe('VALIDACION_FALLIDA');
  });
});
