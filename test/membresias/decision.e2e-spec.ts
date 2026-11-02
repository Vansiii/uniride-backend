import type { ExecutionContext } from '@nestjs/common';
import { OrganizacionGuard } from '../../src/comun/organizacion.guard.js';
import {
  buzon,
  DOMINIO,
  miembroCon,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';

describe('HU-03 · Aprobación de miembros (e2e)', () => {
  let e: Entorno;
  let superToken: string;
  let a: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let b: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let n = 0;
  const conToken = (t: string) => ({ Authorization: `Bearer ${t}` });
  const lista = (id: string) => `/api/v1/organizaciones/${id}/membresias`;
  const decision = (id: string) => `/api/v1/membresias/${id}/decision`;
  const decidir = (token: string, id: string, cuerpo: object) =>
    e.api().post(decision(id)).set(conToken(token)).send(cuerpo);

  /** Solicitud pendiente como la deja el registro de HU-05 (sin organización activa). */
  const solicitud = async (
    organizacionId: string,
    nombre = 'Ana Pérez',
    creadoEn = new Date(),
  ) => {
    const correo = `sol${++n}${DOMINIO}`;
    const usuarioId = await e.crearUsuario(correo);
    await e.bd.query(`UPDATE usuarios SET nombre_completo = $1 WHERE id = $2`, [
      nombre,
      usuarioId,
    ]);
    const { rows } = await e.bd.query(
      `INSERT INTO membresias (organizacion_id, usuario_id, rol, estado, correo_institucional, creado_en)
       VALUES ($1, $2, 'miembro', 'pendiente', $3, $4) RETURNING id`,
      [organizacionId, usuarioId, correo, creadoEn],
    );
    return { id: rows[0].id as string, usuarioId, correo };
  };
  const membresia = async (id: string) =>
    (
      await e.bd.query(
        `SELECT estado, decidido_por, decidido_en, motivo FROM membresias WHERE id = $1`,
        [id],
      )
    ).rows[0];
  const correosDe = async (id: string) =>
    (
      await e.bd.query(
        `SELECT destinatario, plantilla, datos, estado, intentos FROM correos_salientes
         WHERE referencia_tipo = 'membresia' AND referencia_id = $1`,
        [id],
      )
    ).rows;
  const auditoriasDe = async (id: string) =>
    (
      await e.bd.query(
        `SELECT actor_id, organizacion_id, resultado, detalle, creado_en FROM registros_auditoria
         WHERE accion = 'membresia.decision' AND entidad_id = $1 ORDER BY creado_en`,
        [id],
      )
    ).rows;

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    superToken = await e.iniciar(`super${DOMINIO}`);
    a = await organizacionConAdmin(e, superToken, 'Memb A');
    b = await organizacionConAdmin(e, superToken, 'Memb B');
  });
  afterAll(() => e.cerrar());

  it('lista vacía: sin pendientes responde []', async () => {
    const r = await e.api().get(lista(a.id)).set(conToken(a.token)).expect(200);
    expect(r.body).toEqual([]);
  });

  it('CA-1: lista solo las pendientes de A con nombre, correo y fecha, de la más antigua a la más reciente', async () => {
    const t0 = Date.parse('2026-10-20T12:00:00Z');
    const segunda = await solicitud(a.id, 'Beto Rojas', new Date(t0 + 60_000));
    const primera = await solicitud(a.id, 'Ana Pérez', new Date(t0));
    const tercera = await solicitud(a.id, 'Caro Díaz', new Date(t0 + 120_000));
    await miembroCon(e, a.id, `aprobado.l${DOMINIO}`, 'aprobada');
    await miembroCon(e, a.id, `rechazado.l${DOMINIO}`, 'rechazada');
    const deB = await solicitud(b.id, 'De B');

    const r = await e.api().get(lista(a.id)).set(conToken(a.token)).expect(200);
    expect(r.body).toEqual(
      [primera, segunda, tercera].map((s, i) => ({
        id: s.id,
        nombreCompleto: ['Ana Pérez', 'Beto Rojas', 'Caro Díaz'][i],
        correoInstitucional: s.correo,
        creadoEn: new Date(t0 + i * 60_000).toISOString(),
      })),
    );
    expect(JSON.stringify(r.body)).not.toContain(deB.id);
    // `?estado=pendiente` es lo mismo; otros estados no se listan en v1.
    const explicita = await e
      .api()
      .get(`${lista(a.id)}?estado=pendiente`)
      .set(conToken(a.token))
      .expect(200);
    expect(explicita.body).toEqual(r.body);
    const otra = await e
      .api()
      .get(`${lista(a.id)}?estado=aprobada`)
      .set(conToken(a.token))
      .expect(400);
    expect(otra.body.codigo).toBe('VALIDACION_FALLIDA');
    // Se limpian para no afectar al resto de pruebas.
    for (const s of [primera, segunda, tercera])
      await decidir(a.token, s.id, { decision: 'rechazar' }).expect(200);
  });

  it('CA-2: aprobar deja la membresía aprobada, fija la organización activa y la persona recibe el correo', async () => {
    const s = await solicitud(a.id, 'Dani Vaca');
    const r = await decidir(a.token, s.id, { decision: 'aprobar' }).expect(200);
    expect(r.body).toEqual({ id: s.id, estado: 'aprobada' });
    expect(await membresia(s.id)).toMatchObject({
      estado: 'aprobada',
      decidido_por: a.adminId,
      motivo: null,
    });
    const { rows } = await e.bd.query(
      `SELECT ultima_organizacion_id FROM usuarios WHERE id = $1`,
      [s.usuarioId],
    );
    expect(rows[0].ultima_organizacion_id).toBe(a.id);
    const [cola] = await correosDe(s.id);
    expect(cola).toMatchObject({
      destinatario: s.correo,
      plantilla: 'membresia_aprobada',
      estado: 'pendiente',
    });
    const { enviados } = buzon(e);
    await e.correos.procesarPendientes();
    const aviso = enviados.find((c) => c.para === s.correo);
    expect(aviso?.asunto).toBe('Ya eres miembro de HU01 Memb A en UniRide');
    expect(aviso?.texto).toContain('Hola Dani Vaca');
    expect((await correosDe(s.id))[0].estado).toBe('enviado');
    // Ya aprobada, su sesión entra en A (RN-5: viajar exige además HU-08 y HU-09).
    const token = await e.iniciar(s.correo);
    const yo = await e.api().get('/api/v1/yo').set(conToken(token)).expect(200);
    expect(yo.body.organizacionActiva).toBe(a.id);
    expect(yo.body.membresias).toEqual([
      expect.objectContaining({ organizacionId: a.id, estado: 'aprobada' }),
    ]);
  });

  it('CA-2: si la persona ya tenía organización activa, aprobar no la cambia', async () => {
    const s = await solicitud(a.id);
    await e.bd.query(
      `UPDATE usuarios SET ultima_organizacion_id = $1 WHERE id = $2`,
      [b.id, s.usuarioId],
    );
    await decidir(a.token, s.id, { decision: 'aprobar' }).expect(200);
    const { rows } = await e.bd.query(
      `SELECT ultima_organizacion_id FROM usuarios WHERE id = $1`,
      [s.usuarioId],
    );
    expect(rows[0].ultima_organizacion_id).toBe(b.id);
  });

  it('CA-3: rechazar con motivo deja la membresía rechazada y el correo lleva el motivo', async () => {
    const s = await solicitud(a.id, 'Eva Soto');
    const r = await decidir(a.token, s.id, {
      decision: 'rechazar',
      motivo: '  No pertenece a la carrera  ',
    }).expect(200);
    expect(r.body).toEqual({ id: s.id, estado: 'rechazada' });
    expect(await membresia(s.id)).toMatchObject({
      estado: 'rechazada',
      decidido_por: a.adminId,
      motivo: 'No pertenece a la carrera',
    });
    const { rows } = await e.bd.query(
      `SELECT ultima_organizacion_id FROM usuarios WHERE id = $1`,
      [s.usuarioId],
    );
    expect(rows[0].ultima_organizacion_id).toBeNull();
    const { enviados } = buzon(e);
    await e.correos.procesarPendientes();
    const aviso = enviados.find((c) => c.para === s.correo);
    expect(aviso?.asunto).toBe(
      'Tu solicitud para HU01 Memb A en UniRide no fue aprobada',
    );
    expect(aviso?.texto).toContain('Motivo: No pertenece a la carrera');
  });

  it('CA-3: rechazar sin motivo también avisa, sin línea de motivo', async () => {
    const s = await solicitud(a.id);
    await decidir(a.token, s.id, { decision: 'rechazar' }).expect(200);
    expect((await membresia(s.id)).motivo).toBeNull();
    const { enviados } = buzon(e);
    await e.correos.procesarPendientes();
    const aviso = enviados.find((c) => c.para === s.correo);
    expect(aviso?.texto).toContain('rechazó tu solicitud');
    expect(aviso?.texto).not.toContain('Motivo');
  });

  it('CA-4: cada decisión queda auditada con autor, fecha, decisión y motivo', async () => {
    const s = await solicitud(a.id);
    const antes = Date.now();
    await decidir(a.token, s.id, {
      decision: 'rechazar',
      motivo: 'Correo dudoso',
    }).expect(200);
    const filas = await auditoriasDe(s.id);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      actor_id: a.adminId,
      organizacion_id: a.id,
      resultado: 'ok',
      detalle: { decision: 'rechazar', motivo: 'Correo dudoso' },
    });
    expect(new Date(filas[0].creado_en).getTime()).toBeGreaterThanOrEqual(
      antes - 1000,
    );
    const m = await membresia(s.id);
    expect(new Date(m.decidido_en).getTime()).toBeGreaterThanOrEqual(
      antes - 1000,
    );
  });

  it('CA-5: una solicitud ya decidida no se vuelve a decidir; vale la primera', async () => {
    const s = await solicitud(a.id);
    await decidir(a.token, s.id, { decision: 'rechazar' }).expect(200);
    for (const cuerpo of [
      { decision: 'aprobar' },
      { decision: 'rechazar', motivo: 'otro' },
    ]) {
      const r = await decidir(a.token, s.id, cuerpo).expect(409);
      expect(r.body.codigo).toBe('MEMBRESIA_YA_DECIDIDA');
    }
    expect(await membresia(s.id)).toMatchObject({
      estado: 'rechazada',
      motivo: null,
    });
    expect(await correosDe(s.id)).toHaveLength(1);
    expect((await auditoriasDe(s.id)).map((f) => f.resultado)).toEqual([
      'ok',
      'fallo',
      'fallo',
    ]);
  });

  it('CA-5: dos administradores deciden a la vez: una sola decisión gana, la otra es 409', async () => {
    const otroAdmin = await miembroCon(
      e,
      a.id,
      `admin2${DOMINIO}`,
      'aprobada',
      'admin_organizacion',
    );
    for (let ronda = 0; ronda < 5; ronda++) {
      const s = await solicitud(a.id);
      const [r1, r2] = await Promise.all([
        decidir(a.token, s.id, { decision: 'aprobar' }),
        decidir(otroAdmin, s.id, { decision: 'rechazar', motivo: 'tarde' }),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([200, 409]);
      const [ganadora, perdedora] = r1.status === 200 ? [r1, r2] : [r2, r1];
      expect(perdedora.body.codigo).toBe('MEMBRESIA_YA_DECIDIDA');
      expect((await membresia(s.id)).estado).toBe(ganadora.body.estado);
      expect(await correosDe(s.id)).toHaveLength(1);
      expect(
        (await auditoriasDe(s.id)).filter((f) => f.resultado === 'ok'),
      ).toHaveLength(1);
    }
  });

  it('falla el correo: la decisión queda guardada y el aviso se reintenta', async () => {
    const s = await solicitud(a.id);
    e.correos.enviador = {
      enviar: async () => {
        throw new Error('SES caído');
      },
    };
    await decidir(a.token, s.id, { decision: 'aprobar' }).expect(200);
    await e.correos.procesarPendientes();
    expect((await membresia(s.id)).estado).toBe('aprobada');
    expect(await correosDe(s.id)).toEqual([
      expect.objectContaining({ estado: 'pendiente', intentos: 1 }),
    ]);
  });

  it('CA-7: con la membresía rechazada no pasa OrganizacionGuard (ni con token viejo ni tras volver a entrar)', async () => {
    const correo = `rechazable${DOMINIO}`;
    // `miembroCon` le deja A como organización activa: su token dice `org = A`.
    const tokenViejo = await miembroCon(e, a.id, correo, 'pendiente');
    const { rows } = await e.bd.query(
      `SELECT m.id, m.usuario_id FROM membresias m JOIN usuarios u ON u.id = m.usuario_id WHERE u.correo = $1`,
      [correo],
    );
    await decidir(a.token, rows[0].id, { decision: 'rechazar' }).expect(200);
    const nuevo = await e.iniciar(correo);
    for (const t of [tokenViejo, nuevo]) {
      const r = await e.api().get(lista(a.id)).set(conToken(t)).expect(403);
      expect(r.body.codigo).toBe('NO_AUTORIZADO');
    }
    // El guard que protegerá viajes y billetera: rechazada no pasa, aprobada sí (misma persona, mismo rol).
    const guard = e.app.get(OrganizacionGuard, { strict: false });
    const contexto = (org: string, id: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ usuario: { id, org, cli: 'movil' } }),
        }),
      }) as unknown as ExecutionContext;
    await expect(
      guard.canActivate(contexto(a.id, rows[0].usuario_id)),
    ).rejects.toMatchObject({ codigo: 'NO_AUTORIZADO' });
    await e.bd.query(
      `INSERT INTO membresias (organizacion_id, usuario_id, rol, estado) VALUES ($1, $2, 'miembro', 'aprobada')`,
      [b.id, rows[0].usuario_id],
    );
    await expect(
      guard.canActivate(contexto(b.id, rows[0].usuario_id)),
    ).resolves.toBe(true);
  });

  it('RN-1: solo un admin de la organización con membresía aprobada lista y decide', async () => {
    const s = await solicitud(a.id);
    const miembro = await miembroCon(e, a.id, `miembro${DOMINIO}`, 'aprobada');
    const adminPendiente = await miembroCon(
      e,
      a.id,
      `adminpend${DOMINIO}`,
      'pendiente',
      'admin_organizacion',
    );
    for (const t of [miembro, adminPendiente, superToken]) {
      const leer = await e.api().get(lista(a.id)).set(conToken(t)).expect(403);
      expect(leer.body.codigo).toBe('NO_AUTORIZADO');
      const r = await decidir(t, s.id, { decision: 'aprobar' }).expect(403);
      expect(r.body.codigo).toBe('NO_AUTORIZADO');
    }
    await e.api().get(lista(a.id)).expect(401);
    await e
      .api()
      .post(decision(s.id))
      .send({ decision: 'aprobar' })
      .expect(401);
    expect((await membresia(s.id)).estado).toBe('pendiente');
  });

  it('validación: decisión desconocida, motivo largo o campos extra son 400 y no deciden', async () => {
    const s = await solicitud(a.id);
    for (const cuerpo of [
      {},
      { decision: 'quizas' },
      { decision: 'rechazar', motivo: 'x'.repeat(501) },
      { decision: 'rechazar', motivo: 5 },
      { decision: 'aprobar', organizacionId: b.id },
    ]) {
      const r = await decidir(a.token, s.id, cuerpo).expect(400);
      expect(r.body.codigo).toBe('VALIDACION_FALLIDA');
    }
    expect((await membresia(s.id)).estado).toBe('pendiente');
  });
});
