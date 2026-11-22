import { vi, type MockInstance } from 'vitest';
import { AnalisisRiesgoService } from '../../src/fraude/analisis-riesgo.service.js';
import { ModeloRiesgoService } from '../../src/fraude/modelo-riesgo.service.js';
import { GroqServicio } from '../../src/ia/groq.servicio.js';
import { IaLocalServicio } from '../../src/ia/ia-local.servicio.js';
import { IaServicio } from '../../src/ia/ia.servicio.js';
import type { Persona } from '../reservas/ayudas-reservas.js';
import {
  DOMINIO,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import { A, ayudasFraude, DIA_MS, HORA_MS } from './ayudas-fraude.js';

/**
 * PB-11: modelo de riesgo propio por organización. Una organización con 8 personas que viajan mezcladas (28 pares
 * normales), un par sospechoso (10 viajes en 7 días sin desplazamiento) y un anillo de 3 que solo viaja entre sí.
 */
describe('PB-11 · modelo de riesgo propio y anillos (e2e)', () => {
  let e: Entorno;
  const f = ayudasFraude(() => e);
  let org: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let otra: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let pequena: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let s1: Persona, s2: Persona;
  let anillo: Persona[];
  let local: MockInstance;
  const RUTA = '/api/v1/organizacion/alertas-fraude';
  const DESEMPENO = '/api/v1/organizacion/fraude/desempeno';
  const con = (t: string) => ({ Authorization: `Bearer ${t}` });
  const hace = (ms: number) => new Date(Date.now() - ms);
  const modelo = () => e.app.get(ModeloRiesgoService);
  const ordenar = (ids: string[]) => [...ids].sort();

  const registros = async (orgId: string, accion: string) =>
    (
      await e.bd.query(
        `SELECT id, resultado, detalle, creado_en FROM registros_auditoria
         WHERE accion = $1 AND organizacion_id = $2 ORDER BY creado_en`,
        [accion, orgId],
      )
    ).rows;
  const alertasDe = async (orgId: string, patron: string) =>
    (await registros(orgId, 'fraude.alerta')).filter(
      (r) => r.detalle.patron === patron,
    );
  const limpiarModelo = (orgIds: string[]) =>
    e.bd.query(
      `DELETE FROM registros_auditoria WHERE organizacion_id = ANY($1)
         AND accion IN ('fraude.modelo', 'fraude.alerta', 'fraude.decision', 'fraude.analisis_ia')`,
      [orgIds],
    );

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    const superToken = await e.iniciar(`super${DOMINIO}`);
    org = await organizacionConAdmin(e, superToken, 'Modelo A');
    otra = await organizacionConAdmin(e, superToken, 'Modelo B');
    pequena = await organizacionConAdmin(e, superToken, 'Modelo C');
    await f.r.preparar();

    // 28 pares normales: cada persona viaja una vez con cada una de las otras 7, a 10 km en 30 min.
    const mezcla: Persona[] = [];
    for (let i = 0; i < 8; i++) mezcla.push(await f.persona(org.id));
    let k = 0;
    for (let i = 0; i < mezcla.length; i++)
      for (let j = i + 1; j < mezcla.length; j++)
        await f.viajeNormal(
          org.id,
          mezcla[i],
          mezcla[j],
          hace((++k * 9 + 1) * HORA_MS),
        );

    // Par sospechoso: 10 viajes en 7 días, sin moverse y en 1 minuto.
    s1 = await f.persona(org.id);
    s2 = await f.persona(org.id);
    for (let j = 0; j < 10; j++)
      await f.reservaEn(org.id, s1, s2, hace((j * 11 + 3) * HORA_MS), {
        abordaje: A,
        bajada: { ...A, en: 60_000 },
      });

    // Anillo: 3 personas que se turnan (3 viajes con cada una) y no viajan con nadie más.
    anillo = [];
    for (let i = 0; i < 3; i++) anillo.push(await f.persona(org.id));
    let m = 0;
    for (const [x, y] of [
      [0, 1],
      [1, 2],
      [2, 0],
    ])
      for (let j = 0; j < 3; j++)
        await f.viajeNormal(
          org.id,
          anillo[x],
          anillo[y],
          hace((++m * 13 + 5) * HORA_MS),
        );

    // Otra organización con 2 pares: no alcanza para entrenar (CA-2).
    const a = await f.persona(pequena.id);
    const b = await f.persona(pequena.id);
    const c = await f.persona(pequena.id);
    await f.viajeNormal(pequena.id, a, b, hace(5 * HORA_MS));
    await f.viajeNormal(pequena.id, b, c, hace(7 * HORA_MS));

    const l = e.app.get(IaLocalServicio);
    vi.spyOn(l, 'configurada', 'get').mockReturnValue(true);
    local = vi.spyOn(l, 'completarJson');
    vi.spyOn(e.app.get(GroqServicio), 'completarJson').mockResolvedValue(null);
  }, 300_000);

  beforeEach(async () => {
    await limpiarModelo([org.id, otra.id, pequena.id]);
    local.mockReset();
    (
      e.app.get(IaServicio) as unknown as { localCaidaHasta: number }
    ).localCaidaHasta = 0;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await e.cerrar();
  });

  it('CA-1, CA-3: entrena con los 32 pares y alerta el par sospechoso con puntaje ≥ 80 y sus factores; los normales no', async () => {
    const r = await modelo().entrenarPendientes(org.id);
    expect(r.entrenadas).toBe(1);
    const [m] = await registros(org.id, 'fraude.modelo');
    expect(m.resultado).toBe('ok');
    expect(m.detalle).toMatchObject({ version: 1, pares: 32, umbral: 80 });
    expect(m.detalle.filas).toHaveLength(32);
    // Las filas son solo números: nunca ids (RN-3, CA-15).
    expect(JSON.stringify(m.detalle.filas)).not.toMatch(/[0-9a-f]{8}-/);
    expect(
      m.detalle.histograma.reduce((s: number, n: number) => s + n, 0),
    ).toBe(32);

    const atipicas = await alertasDe(org.id, 'comportamiento_atipico');
    const sospechosa = atipicas.find(
      (a) =>
        JSON.stringify(a.detalle.personas) ===
        JSON.stringify(ordenar([s1.id, s2.id])),
    );
    expect(sospechosa).toBeDefined();
    expect(sospechosa!.detalle.puntaje).toBeGreaterThanOrEqual(80);
    // RN-5: las 3 cifras más apartadas, todas de las que hacen sospechoso al par (sin moverse, en 1 minuto, repetido).
    const factores = sospechosa!.detalle.factores as {
      cifra: string;
      percentil: number;
    }[];
    expect(factores).toHaveLength(3);
    for (const x of factores) {
      expect([
        'viajes7d',
        'viajes30d',
        'distanciaPromedioM',
        'duracionPromedioMin',
        'fraccionConductor',
        'fraccionPasajero',
      ]).toContain(x.cifra);
      expect(x.percentil).toBeGreaterThanOrEqual(0);
      expect(x.percentil).toBeLessThanOrEqual(100);
    }
    // Ningún par de la mezcla normal llega al umbral.
    const anomalos = new Set([s1.id, s2.id, ...anillo.map((p) => p.id)]);
    for (const a of atipicas)
      expect(a.detalle.personas.some((p: string) => anomalos.has(p))).toBe(
        true,
      );
  });

  it('CA-4: detecta el anillo de 3 y la API lo devuelve con su grafo, sin ids', async () => {
    await modelo().entrenarPendientes(org.id);
    const [a] = await alertasDe(org.id, 'anillo_colusion');
    expect(a.detalle.personas).toEqual(ordenar(anillo.map((p) => p.id)));
    expect(a.detalle.viajesInternos).toBe(9);
    expect(a.detalle.proporcion).toBe(1);

    const r = await e
      .api()
      .get(`${RUTA}?patron=anillo_colusion`)
      .set(con(org.token))
      .expect(200);
    const [alerta] = r.body.alertas;
    expect(alerta.origen).toBe('anillo');
    expect(alerta.personas).toHaveLength(3);
    expect(
      alerta.personas.every((p: { rol: string }) => p.rol === 'miembro'),
    ).toBe(true);
    expect(alerta.grafo.nodos).toHaveLength(3);
    expect(alerta.grafo.aristas).toHaveLength(3);
    expect(alerta.grafo.viajesInternos).toBe(9);
    expect(JSON.stringify(alerta.grafo)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-/,
    );
  });

  it('CA-16: dos procesos a la vez dejan un solo modelo; el día siguiente no repite alertas (7 días)', async () => {
    const [x, y] = await Promise.all([
      modelo().entrenarPendientes(org.id),
      modelo().entrenarPendientes(org.id),
    ]);
    expect(x.entrenadas + y.entrenadas).toBe(1);
    expect(await registros(org.id, 'fraude.modelo')).toHaveLength(1);
    const antes = (await registros(org.id, 'fraude.alerta')).length;
    expect(antes).toBeGreaterThan(0);

    // Dentro de las 24 h no reentrena.
    expect((await modelo().entrenarPendientes(org.id)).entrenadas).toBe(0);
    // Al día siguiente sí, con versión 2, sin repetir alertas.
    const manana = new Date(Date.now() + DIA_MS + HORA_MS);
    expect((await modelo().entrenarPendientes(org.id, manana)).entrenadas).toBe(
      1,
    );
    const modelos = await registros(org.id, 'fraude.modelo');
    expect(modelos.map((m) => m.detalle.version)).toEqual([1, 2]);
    expect(await registros(org.id, 'fraude.alerta')).toHaveLength(antes);
  });

  it('CA-2: con menos de 20 pares no entrena y el desempeño lo muestra', async () => {
    const r = await modelo().entrenarPendientes(pequena.id);
    expect(r).toMatchObject({ entrenadas: 0, sinDatos: 1 });
    const [m] = await registros(pequena.id, 'fraude.modelo');
    expect(m.resultado).toBe('fallo');
    expect(m.detalle).toMatchObject({
      motivo: 'sin_datos',
      pares: 2,
      minimo: 20,
    });
    const d = await e.api().get(DESEMPENO).set(con(pequena.token)).expect(200);
    expect(d.body.modelo).toBeNull();
    expect(d.body.sinDatos).toEqual({ pares: 2, minimo: 20 });
    // La validación simulada siempre está (CA-11).
    expect(d.body.validacion.auc).toBeGreaterThanOrEqual(0.85);
    expect(d.body.validacion.roc.length).toBeGreaterThan(2);
  });

  it('CA-9: los pares confirmados como fraude no se usan como normales al reentrenar', async () => {
    await modelo().entrenarPendientes(org.id);
    const [sospechosa] = (
      await alertasDe(org.id, 'comportamiento_atipico')
    ).filter((a) => a.detalle.personas.includes(s1.id));
    await e
      .api()
      .post(`${RUTA}/${sospechosa.id}/decision`)
      .set(con(org.token))
      .send({ decision: 'confirmado' })
      .expect(204);
    await modelo().entrenarPendientes(
      org.id,
      new Date(Date.now() + DIA_MS + HORA_MS),
    );
    const [, segundo] = await registros(org.id, 'fraude.modelo');
    expect(segundo.detalle.pares).toBe(31);
  });

  it('CA-5: con modelo vigente, el análisis usa su puntaje aunque la IA diga otro, y cita sus cifras', async () => {
    await modelo().entrenarPendientes(org.id);
    const [alerta] = (await alertasDe(org.id, 'comportamiento_atipico')).filter(
      (a) => a.detalle.personas.includes(s1.id),
    );
    local.mockResolvedValue(
      JSON.stringify({
        riesgo: 'bajo',
        puntaje: 3,
        motivos: ['10 viajes del par en 7 días'],
        recomendacion: 'Revisar el par.',
      }),
    );
    await e.app.get(AnalisisRiesgoService).analizarPendientes(org.id);
    const [sistema, usuario] = local.mock.calls[0] as [string, string];
    expect(sistema).toMatch(/Isolation Forest/);
    const perfil = JSON.parse(usuario);
    expect(perfil.modelo.puntaje).toBe(alerta.detalle.puntaje);
    expect(perfil.modelo.factores.length).toBeGreaterThan(0);
    expect(usuario).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);

    const r = await e
      .api()
      .get(`${RUTA}?patron=comportamiento_atipico`)
      .set(con(org.token))
      .expect(200);
    const vista = r.body.alertas.find(
      (a: { id: string }) => a.id === alerta.id,
    );
    expect(vista.analisis).toMatchObject({
      puntaje: alerta.detalle.puntaje,
      riesgo: 'alto',
      origenPuntaje: 'modelo',
    });
    expect(vista.factores.length).toBeGreaterThan(0);
  });

  it('CA-12 · ataque A-10: alertas del modelo y de anillo no crean bloqueos ni cambian reservas', async () => {
    const ids = [s1.id, s2.id, ...anillo.map((p) => p.id)];
    const reservas = async () =>
      (
        await e.bd.query(
          `SELECT id, estado, actualizado_en FROM reservas WHERE organizacion_id = $1 ORDER BY id`,
          [org.id],
        )
      ).rows;
    const antes = await reservas();
    await modelo().entrenarPendientes(org.id);
    expect((await registros(org.id, 'fraude.alerta')).length).toBeGreaterThan(
      0,
    );
    const { rows } = await e.bd.query(
      `SELECT * FROM bloqueos_preventivos WHERE usuario_id = ANY($1) OR usuario_par_id = ANY($1)`,
      [ids],
    );
    expect(rows).toEqual([]);
    expect(await reservas()).toEqual(antes);
  });

  it('CA-13 · ataque A-13: el modelo de A no usa datos de B y B no ve ni decide sobre alertas de A', async () => {
    const b1 = await f.persona(otra.id);
    const b2 = await f.persona(otra.id);
    for (let j = 0; j < 3; j++)
      await f.viajeNormal(otra.id, b1, b2, hace((j + 2) * HORA_MS));
    await modelo().entrenarPendientes(org.id);
    const [m] = await registros(org.id, 'fraude.modelo');
    expect(m.detalle.pares).toBe(32);

    const [alerta] = await registros(org.id, 'fraude.alerta');
    const deB = await e.api().get(RUTA).set(con(otra.token)).expect(200);
    expect(deB.body.alertas.map((a: { id: string }) => a.id)).not.toContain(
      alerta.id,
    );
    await e
      .api()
      .post(`${RUTA}/${alerta.id}/decision`)
      .set(con(otra.token))
      .send({ decision: 'falso_positivo' })
      .expect(404);
    expect(await registros(org.id, 'fraude.decision')).toEqual([]);
    const d = await e.api().get(DESEMPENO).set(con(otra.token)).expect(200);
    expect(d.body.modelo).toBeNull();
    expect(
      d.body.porOrigen.reduce(
        (s: number, o: { alertas: number }) => s + o.alertas,
        0,
      ),
    ).toBe(0);
  });
});
