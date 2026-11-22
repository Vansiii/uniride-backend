import { randomUUID } from 'node:crypto';
import {
  DOMINIO,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import { A, ayudasFraude, HORA_MS } from './ayudas-fraude.js';

/** PB-11: decisiones del administrador sobre las alertas y desempeño por origen. Nunca tocan bloqueos (RN-1). */
describe('PB-11 · decisiones y desempeño (e2e)', () => {
  let e: Entorno;
  const f = ayudasFraude(() => e);
  let org: Awaited<ReturnType<typeof organizacionConAdmin>>;
  const RUTA = '/api/v1/organizacion/alertas-fraude';
  const DESEMPENO = '/api/v1/organizacion/fraude/desempeno';
  const con = (t: string) => ({ Authorization: `Bearer ${t}` });
  const decidir = (id: string, cuerpo: object, token = org.token) =>
    e.api().post(`${RUTA}/${id}/decision`).set(con(token)).send(cuerpo);

  /** Una alerta de reglas real (P-2 repetido: con bloqueo de par) y una del modelo insertada como la dejaría el tic. */
  const alertas = async () => {
    const c = await f.persona(org.id);
    const p = await f.persona(org.id);
    for (const h of [3, 5])
      await f.reservaEn(org.id, c, p, new Date(Date.now() - h * HORA_MS), {
        abordaje: A,
        bajada: A,
      });
    await f.tic();
    const { rows } = await e.bd.query(
      `SELECT id FROM registros_auditoria WHERE accion = 'fraude.alerta' AND organizacion_id = $1
         AND detalle->'personas' ?| $2 ORDER BY creado_en`,
      [org.id, [c.id, p.id]],
    );
    const { rows: modelo } = await e.bd.query(
      `INSERT INTO registros_auditoria (accion, entidad, entidad_id, resultado, organizacion_id, detalle)
       VALUES ('fraude.alerta', 'organizacion', $1::text, 'ok', $1::uuid, $2) RETURNING id`,
      [
        org.id,
        {
          patron: 'comportamiento_atipico',
          personas: [c.id, p.id].sort(),
          puntaje: 92,
          factores: [{ cifra: 'viajes7d', valor: 9, percentil: 99 }],
        },
      ],
    );
    return {
      reglas: rows.map((r) => r.id as string),
      modelo: modelo[0].id as string,
      c,
      p,
    };
  };

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    org = await organizacionConAdmin(
      e,
      await e.iniciar(`super${DOMINIO}`),
      'Decisiones A',
    );
  });
  beforeEach(async () => {
    await f.r.preparar();
    await e.bd.query(
      `DELETE FROM registros_auditoria WHERE organizacion_id = $1
         AND accion IN ('fraude.alerta', 'fraude.bloqueo', 'fraude.decision', 'fraude.analisis_ia')`,
      [org.id],
    );
  });
  afterAll(async () => {
    await e.cerrar();
  });

  it('CA-8: registra la decisión con autor y fecha, conserva el historial y rige la última', async () => {
    const { modelo } = await alertas();
    await decidir(modelo, {
      decision: 'confirmado',
      nota: '  Mismo par todos los días  ',
    }).expect(204);
    await decidir(modelo, { decision: 'falso_positivo' }).expect(204);

    const { rows } = await e.bd.query(
      `SELECT actor_id, detalle FROM registros_auditoria
       WHERE accion = 'fraude.decision' AND entidad_id = $1 ORDER BY creado_en`,
      [modelo],
    );
    expect(rows.map((r) => r.detalle)).toEqual([
      { decision: 'confirmado', nota: 'Mismo par todos los días' },
      { decision: 'falso_positivo' },
    ]);
    expect(rows.every((r) => r.actor_id === org.adminId)).toBe(true);

    const r = await e.api().get(RUTA).set(con(org.token)).expect(200);
    const vista = r.body.alertas.find((a: { id: string }) => a.id === modelo);
    expect(vista.origen).toBe('modelo');
    expect(vista.decision).toMatchObject({
      valor: 'falso_positivo',
      autor: 'Admin',
    });
    expect(vista.decision.en).toBeTruthy();
  });

  it('valida la decisión y la nota', async () => {
    const { modelo } = await alertas();
    await decidir(modelo, { decision: 'bloquear' }).expect(400);
    await decidir(modelo, {
      decision: 'confirmado',
      nota: 'x'.repeat(201),
    }).expect(400);
    await decidir('no-es-uuid', { decision: 'confirmado' }).expect(400);
    await decidir(randomUUID(), { decision: 'confirmado' }).expect(404);
  });

  it('CA-10: el desempeño cuenta alertas y precisión por origen', async () => {
    const { reglas, modelo } = await alertas();
    const vacio = await e.api().get(DESEMPENO).set(con(org.token)).expect(200);
    const sinDecidir = vacio.body.porOrigen.find(
      (o: { origen: string }) => o.origen === 'modelo',
    );
    expect(sinDecidir).toMatchObject({ alertas: 1, precision: null });

    await decidir(modelo, { decision: 'confirmado' }).expect(204);
    await decidir(reglas[0], { decision: 'falso_positivo' }).expect(204);
    if (reglas[1])
      await decidir(reglas[1], { decision: 'confirmado' }).expect(204);

    const d = await e.api().get(DESEMPENO).set(con(org.token)).expect(200);
    const por = Object.fromEntries(
      d.body.porOrigen.map((o: { origen: string }) => [o.origen, o]),
    );
    expect(por.modelo).toMatchObject({
      alertas: 1,
      confirmadas: 1,
      falsosPositivos: 0,
      precision: 1,
    });
    expect(por.reglas.alertas).toBe(reglas.length);
    expect(por.reglas.falsosPositivos).toBe(1);
    expect(por.anillo).toMatchObject({ alertas: 0, precision: null });
    expect(d.body.validacion).toMatchObject({
      auc: expect.any(Number),
      escenarios: expect.any(Number),
    });
  });

  it('CA-12 · ataque A-10: «falso positivo» no levanta ni acorta el bloqueo de HU-25', async () => {
    const { reglas, c } = await alertas();
    const bloqueos = async () =>
      (
        await e.bd.query(
          `SELECT id, vence_en FROM bloqueos_preventivos WHERE usuario_id = $1 OR usuario_par_id = $1 ORDER BY id`,
          [c.id],
        )
      ).rows;
    const antes = await bloqueos();
    expect(antes.length).toBeGreaterThan(0);
    for (const id of reglas)
      await decidir(id, { decision: 'falso_positivo' }).expect(204);
    expect(await bloqueos()).toEqual(antes);
    const vigentes = await e
      .api()
      .get('/api/v1/organizacion/bloqueos-vigentes')
      .set(con(org.token))
      .expect(200);
    expect(vigentes.body.bloqueos.length).toBeGreaterThan(0);
  });

  it('CA-14 · ataque A-08: sin sesión o como miembro se rechaza', async () => {
    const { modelo } = await alertas();
    const miembro = await f.persona(org.id);
    await e
      .api()
      .post(`${RUTA}/${modelo}/decision`)
      .send({ decision: 'confirmado' })
      .expect(401);
    await decidir(modelo, { decision: 'confirmado' }, miembro.token).expect(
      403,
    );
    await e.api().get(DESEMPENO).expect(401);
    await e.api().get(DESEMPENO).set(con(miembro.token)).expect(403);
    const { rows } = await e.bd.query(
      `SELECT 1 FROM registros_auditoria WHERE accion = 'fraude.decision' AND entidad_id = $1`,
      [modelo],
    );
    expect(rows).toEqual([]);
  });
});
