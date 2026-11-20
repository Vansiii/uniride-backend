import { randomUUID } from 'node:crypto';
import { vi, type MockInstance } from 'vitest';
import { AnalisisRiesgoService } from '../../src/fraude/analisis-riesgo.service.js';
import { GroqServicio } from '../../src/ia/groq.servicio.js';
import { IaLocalServicio } from '../../src/ia/ia-local.servicio.js';
import { IaServicio } from '../../src/ia/ia.servicio.js';
import {
  DOMINIO,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import { A, ayudasFraude, HORA_MS } from './ayudas-fraude.js';

/** PB-10: la IA (local → Groq) analiza cada alerta de HU-25; nunca bloquea ni toca dinero. */
describe('PB-10 · análisis de riesgo con IA (e2e)', () => {
  let e: Entorno;
  const f = ayudasFraude(() => e);
  let org: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let otra: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let local: MockInstance;
  let groq: MockInstance;
  const RUTA = '/api/v1/organizacion/alertas-fraude';
  const con = (t: string) => ({ Authorization: `Bearer ${t}` });
  const hace = (ms: number) => new Date(Date.now() - ms);
  const respuesta = (o: Record<string, unknown> = {}) =>
    JSON.stringify({
      riesgo: 'alto',
      puntaje: 87,
      motivos: ['6 reservas del par en 7 días sin desplazamiento real'],
      recomendacion: 'Revisar ambas cuentas.',
      ...o,
    });
  const analizar = (orgId = org.id) =>
    e.app.get(AnalisisRiesgoService).analizarPendientes(orgId);
  const analisisDe = async (alertaId: string) =>
    (
      await e.bd.query(
        `SELECT resultado, detalle FROM registros_auditoria
         WHERE accion = 'fraude.analisis_ia' AND entidad_id = $1 ORDER BY creado_en`,
        [alertaId],
      )
    ).rows;
  const listar = async (token = org.token) =>
    (await e.api().get(RUTA).set(con(token)).expect(200)).body.alertas;

  /** Una alerta real de HU-25 (P-2, sin desplazamiento) entre dos personas nuevas. */
  const alertaReal = async (orgId = org.id) => {
    const c = await f.persona(orgId);
    const p = await f.persona(orgId);
    await f.reservaEn(orgId, c, p, hace(2 * HORA_MS), {
      abordaje: A,
      bajada: A,
    });
    await f.tic();
    const { rows } = await e.bd.query(
      `SELECT id FROM registros_auditoria WHERE accion = 'fraude.alerta' AND organizacion_id = $1
         AND detalle->'personas' ?| $2 ORDER BY creado_en DESC LIMIT 1`,
      [orgId, [c.id, p.id]],
    );
    return { alertaId: rows[0].id as string, c, p };
  };

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    const superToken = await e.iniciar(`super${DOMINIO}`);
    org = await organizacionConAdmin(e, superToken, 'IA Riesgo A');
    otra = await organizacionConAdmin(e, superToken, 'IA Riesgo B');
    const l = e.app.get(IaLocalServicio);
    vi.spyOn(l, 'configurada', 'get').mockReturnValue(true);
    local = vi.spyOn(l, 'completarJson');
    groq = vi.spyOn(e.app.get(GroqServicio), 'completarJson');
  });
  beforeEach(async () => {
    await f.r.preparar();
    local.mockReset();
    groq.mockReset();
    // Cada prueba arranca con la IA local disponible (sin el salto de 60 s de una prueba anterior).
    (
      e.app.get(IaServicio) as unknown as { localCaidaHasta: number }
    ).localCaidaHasta = 0;
    await e.bd.query(
      `DELETE FROM registros_auditoria WHERE accion IN ('fraude.alerta', 'fraude.analisis_ia') AND organizacion_id = ANY($1)`,
      [[org.id, otra.id]],
    );
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await e.cerrar();
  });

  it('CA-1, CA-5, CA-6: la IA local analiza la alerta y el admin ve riesgo, motivos y proveedor; Groq no se llama', async () => {
    const { alertaId } = await alertaReal();
    local.mockResolvedValue(respuesta());
    expect(await analizar()).toEqual({ analizadas: 1, fallidas: 0 });
    expect(groq).not.toHaveBeenCalled();

    const [alerta] = await listar();
    expect(alerta.id).toBe(alertaId);
    expect(alerta.estadoAnalisis).toBe('listo');
    expect(alerta.analisis).toMatchObject({
      riesgo: 'alto',
      puntaje: 87,
      proveedor: 'local',
      recomendacion: 'Revisar ambas cuentas.',
    });
    expect(alerta.analisis.motivos).toHaveLength(1);
    expect(alerta.analisis.analizadoEn).toBeTruthy();
  });

  it('CA-8: a la IA solo le llegan cifras y «A»/«B»: ni ids, nombres, correos ni coordenadas', async () => {
    const { c, p } = await alertaReal();
    local.mockResolvedValue(respuesta());
    await analizar();
    const [sistema, usuario] = local.mock.calls[0] as [string, string];
    const nombres = (
      await e.bd.query(
        `SELECT nombre_completo, correo FROM usuarios WHERE id = ANY($1)`,
        [[c.id, p.id]],
      )
    ).rows;
    for (const texto of [sistema, usuario]) {
      expect(texto).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
      expect(texto).not.toContain(String(A.lat));
      for (const n of nombres) {
        expect(texto).not.toContain(n.nombre_completo);
        expect(texto).not.toContain(n.correo);
      }
    }
    const perfil = JSON.parse(usuario);
    expect(perfil.A).toBeDefined();
    expect(perfil.B).toBeDefined();
    expect(perfil.par.reservas30d).toBe(1);
  });

  it('CA-2: si la IA local falla, analiza Groq', async () => {
    await alertaReal();
    local.mockResolvedValue(null);
    groq.mockResolvedValue(respuesta({ riesgo: 'medio', puntaje: 55 }));
    await analizar();
    const [alerta] = await listar();
    expect(alerta.analisis).toMatchObject({
      riesgo: 'medio',
      proveedor: 'groq',
    });
  });

  it('CA-3: con las dos IA caídas queda pendiente, se reintenta 3 veces y luego «sin análisis»', async () => {
    const { alertaId } = await alertaReal();
    local.mockResolvedValue(null);
    groq.mockResolvedValue(null);
    await analizar();
    expect((await listar())[0].estadoAnalisis).toBe('pendiente');
    await analizar();
    await analizar();
    expect((await listar())[0].estadoAnalisis).toBe('sin_analisis');
    groq.mockClear();
    expect(await analizar()).toEqual({ analizadas: 0, fallidas: 0 });
    expect(groq).not.toHaveBeenCalled();
    const filas = await analisisDe(alertaId);
    expect(filas.map((x) => x.resultado)).toEqual(['fallo', 'fallo', 'fallo']);
    expect(filas[0].detalle).toEqual({ motivo: 'sin_proveedor' });
  });

  it('CA-4: una respuesta fuera de formato se descarta y no se muestra', async () => {
    const { alertaId } = await alertaReal();
    local.mockResolvedValue(respuesta({ riesgo: 'critico' }));
    groq.mockResolvedValue('El riesgo es alto');
    await analizar();
    const [alerta] = await listar();
    expect(alerta.estadoAnalisis).toBe('pendiente');
    expect(alerta.analisis).toBeUndefined();
    const [fila] = await analisisDe(alertaId);
    expect(fila).toMatchObject({
      resultado: 'fallo',
      detalle: { motivo: 'formato_invalido' },
    });
  });

  it('CA-11: dos ciclos a la vez dejan un solo análisis', async () => {
    const { alertaId } = await alertaReal();
    local.mockResolvedValue(respuesta());
    await Promise.all([analizar(), analizar()]);
    await analizar();
    const ok = (await analisisDe(alertaId)).filter((x) => x.resultado === 'ok');
    expect(ok).toHaveLength(1);
  });

  it('CA-7 · ataque A-10: aunque la IA pida bloquear o levantar, no cambian bloqueos, reservas ni saldos', async () => {
    const { c, p } = await alertaReal();
    const estado = async () => ({
      bloqueos: await f.bloqueos(c.id),
      reservas: (
        await e.bd.query(
          `SELECT id, estado FROM reservas WHERE pasajero_id = ANY($1) ORDER BY id`,
          [[c.id, p.id]],
        )
      ).rows,
      movimientos: (
        await e.bd.query(
          `SELECT m.id, m.estado FROM movimientos_billetera m JOIN billeteras b ON b.id = m.billetera_id
           WHERE b.usuario_id = ANY($1) ORDER BY m.id`,
          [[c.id, p.id]],
        )
      ).rows,
    });
    const antes = await estado();
    local.mockResolvedValue(
      respuesta({
        recomendacion: 'Bloquear la cuenta ya y levantar el bloqueo del par.',
      }),
    );
    await analizar();
    expect(await estado()).toEqual(antes);
  });

  it('CA-9 · ataque A-13: el admin de A no ve análisis de B y el perfil no cuenta reservas de otra organización', async () => {
    const { p } = await alertaReal();
    // Una reserva pagada del mismo par registrada en B: el perfil de la alerta de A no debe verla.
    // Se copia el viaje (mismo conductor) a B y se agrega una reserva pagada del mismo pasajero.
    await e.bd.query(
      `WITH origen AS (
         SELECT r.viaje_id, r.monto FROM reservas r WHERE r.pasajero_id = $3 LIMIT 1),
       viaje AS (
         INSERT INTO viajes
         SELECT (jsonb_populate_record(NULL::viajes,
           to_jsonb(v) || jsonb_build_object('id', gen_random_uuid(), 'organizacion_id', $1::uuid))).*
         FROM viajes v JOIN origen o ON o.viaje_id = v.id
         RETURNING id)
       INSERT INTO reservas (organizacion_id, viaje_id, pasajero_id, monto, estado, clave_idempotencia)
       SELECT $1, viaje.id, $3, origen.monto, 'pagada', $2 FROM viaje, origen`,
      [otra.id, randomUUID(), p.id],
    );
    await alertaReal(otra.id);
    local.mockResolvedValue(respuesta());
    await analizar(org.id);
    await analizar(otra.id);
    const perfil = JSON.parse(local.mock.calls[0][1] as string);
    expect(perfil.par.reservas30d).toBe(1);

    const deA = await listar(org.token);
    const deB = await listar(otra.token);
    expect(deA).toHaveLength(1);
    expect(deB).toHaveLength(1);
    expect(deA[0].id).not.toBe(deB[0].id);
  });

  it('CA-10 · ataque A-08: sin sesión o como miembro se rechaza, y no hay rutas para escribir análisis', async () => {
    const miembro = await f.persona(org.id);
    await e.api().get(RUTA).expect(401);
    await e.api().get(RUTA).set(con(miembro.token)).expect(403);
    await e.api().post(RUTA).set(con(org.token)).send({}).expect(404);
    await e
      .api()
      .post(`${RUTA}/${randomUUID()}/analisis`)
      .set(con(org.token))
      .send({ riesgo: 'bajo' })
      .expect(404);
  });
});
