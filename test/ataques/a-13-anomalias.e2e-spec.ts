import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasFraude, HORA_MS } from '../fraude/ayudas-fraude.js';

/** HU-25 CA-13 · A-13: la alerta de un patrón queda solo en la organización de cada reserva involucrada. */
describe('A-13 · alertas de anomalías por organización (e2e)', () => {
  let e: Entorno;
  const f = ayudasFraude(() => e);
  let a: string;
  let b: string;
  const hace = (ms: number) => new Date(Date.now() - ms);

  beforeAll(async () => {
    e = await prepararEntorno();
    a = (await f.r.v.organizacion('Fraude A13 A')).id;
    b = (await f.r.v.organizacion('Fraude A13 B')).id;
  });
  beforeEach(() => f.r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  it('A-13: un par con reservas en A deja alertas solo en A; nada en B', async () => {
    const c = await f.persona(a);
    const p = await f.persona(a);
    for (const h of [20, 12, 4])
      await f.viajeNormal(a, c, p, hace(h * HORA_MS));
    await f.tic();

    const alertas = [
      ...(await f.alertas([c.id])),
      ...(await f.alertas([c.id], 'fraude.bloqueo')),
    ];
    expect(alertas.length).toBeGreaterThan(0);
    expect(new Set(alertas.map((x) => x.organizacion_id))).toEqual(
      new Set([a]),
    );
    const { rows } = await e.bd.query(
      `SELECT 1 FROM registros_auditoria WHERE organizacion_id = $1 AND accion LIKE 'fraude.%'`,
      [b],
    );
    expect(rows).toEqual([]);
  });

  it('A-13: una persona con fallidas en dos organizaciones deja una alerta en cada una', async () => {
    const p = await f.persona(a);
    await f.viajeNormal(
      a,
      await f.persona(a),
      p,
      hace(30 * HORA_MS),
      'verificacion_fallida',
    );
    await f.viajeNormal(
      a,
      await f.persona(a),
      p,
      hace(20 * HORA_MS),
      'verificacion_fallida',
    );
    await f.viajeNormal(
      b,
      await f.persona(b),
      p,
      hace(2 * HORA_MS),
      'verificacion_fallida',
    );
    await f.tic();
    const orgs = (await f.alertas([p.id])).map((x) => x.organizacion_id);
    expect(new Set(orgs)).toEqual(new Set([a, b]));
    // Cada alerta lista solo las reservas de su organización.
    for (const x of await f.alertas([p.id])) {
      const { rows } = await e.bd.query(
        `SELECT organizacion_id FROM reservas WHERE id = ANY($1::uuid[])`,
        [x.detalle.reservas],
      );
      expect(new Set(rows.map((r) => r.organizacion_id))).toEqual(
        new Set([x.organizacion_id]),
      );
    }
  });
});
