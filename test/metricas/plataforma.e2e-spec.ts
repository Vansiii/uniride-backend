import { randomUUID } from 'node:crypto';
import {
  DOMINIO,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import { ayudasFraude, DIA_MS } from '../fraude/ayudas-fraude.js';

/** HU-33: el super administrador ve la plataforma y cada organización; coincide con HU-32. 0,1° ≈ 11,12 km. */
describe('HU-33 · métricas globales (e2e)', () => {
  let e: Entorno;
  const f = ayudasFraude(() => e);
  let superToken: string;
  let a: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let b: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let inactiva: Awaited<ReturnType<typeof organizacionConAdmin>>;
  const con = (t: string) => ({ Authorization: `Bearer ${t}` });
  const RUTA = '/api/v1/plataforma/metricas';
  const hace = (dias: number) => new Date(Date.now() - dias * DIA_MS);

  const sembrar = async (
    org: { id: string },
    conductor: Awaited<ReturnType<typeof f.persona>>,
    i: number,
    grados: number,
    pagadaHace: number,
    estado: 'pagada' | 'verificacion_fallida' = 'pagada',
  ) => {
    const p = await f.persona(org.id);
    const salida = hace(pagadaHace + 1);
    salida.setMinutes(salida.getMinutes() + i * 5);
    const { reservaId, viajeId } = await f.reservaEn(
      org.id,
      conductor,
      p,
      salida,
      { estado },
    );
    await e.bd.query(
      `UPDATE viajes SET origen_lat = -17.78, origen_lng = -63.18, destino_lat = $2, destino_lng = -63.18 WHERE id = $1`,
      [viajeId, -17.78 + grados],
    );
    if (estado === 'pagada')
      await e.bd.query(
        `INSERT INTO movimientos_billetera (billetera_id, tipo, monto, estado, reserva_id, hash_tx, clave_idempotencia, creado_en)
         VALUES ($1, 'liberacion_viaje', 10.50, 'confirmado', $2, '0x' || repeat('a', 64), $3, $4)`,
        [conductor.billetera, reservaId, randomUUID(), hace(pagadaHace)],
      );
  };

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    superToken = await e.iniciar(`super${DOMINIO}`);
    a = await organizacionConAdmin(e, superToken, 'Plataforma A');
    b = await organizacionConAdmin(e, superToken, 'Plataforma B');
    inactiva = await organizacionConAdmin(e, superToken, 'Plataforma Inactiva');
    await f.r.preparar();
    const ca = await f.persona(a.id);
    const cb = await f.persona(b.id);
    await sembrar(a, ca, 1, 0.1, 2);
    await sembrar(a, ca, 2, 0.05, 20);
    await sembrar(a, ca, 3, 0.1, 40); // solo «todo»
    await sembrar(b, cb, 1, 0.1, 3);
    await sembrar(b, cb, 2, 0.1, 1, 'verificacion_fallida');
  });
  afterAll(() => e.cerrar());

  const pedir = (periodo?: string) =>
    e
      .api()
      .get(periodo ? `${RUTA}?periodo=${periodo}` : RUTA)
      .set(con(superToken));
  const de = (
    cuerpo: { porOrganizacion: { organizacionId: string }[] },
    id: string,
  ) =>
    cuerpo.porOrganizacion.find((o) => o.organizacionId === id) as unknown as {
      viajesPagados: number;
      miembrosActivos: number;
      co2Kg: number;
      sinActividad: boolean;
    };

  it('CA-1, CA-3: el total global es la suma de la tabla', async () => {
    for (const periodo of ['7d', '30d', 'todo']) {
      const c = (await pedir(periodo).expect(200)).body;
      const filas = c.porOrganizacion as {
        viajesPagados: number;
        miembrosActivos: number;
      }[];
      expect(c.global.viajesPagados).toBe(
        filas.reduce((n, o) => n + o.viajesPagados, 0),
      );
      expect(c.global.miembrosActivos).toBe(
        filas.reduce((n, o) => n + o.miembrosActivos, 0),
      );
    }
  });

  it('CA-2, CA-4, CA-5: por organización y período; la sin actividad sale marcada', async () => {
    const d30 = (await pedir('30d').expect(200)).body;
    expect(de(d30, a.id)).toMatchObject({ viajesPagados: 2, co2Kg: 2 });
    expect(de(d30, b.id)).toMatchObject({ viajesPagados: 1, co2Kg: 1.3 });
    expect(de(d30, inactiva.id)).toMatchObject({
      viajesPagados: 0,
      co2Kg: 0,
      sinActividad: true,
    });
    expect(de(d30, a.id).sinActividad).toBe(false);
    const d7 = (await pedir('7d').expect(200)).body;
    expect(de(d7, a.id).viajesPagados).toBe(1);
    const todo = (await pedir('todo').expect(200)).body;
    expect(de(todo, a.id).viajesPagados).toBe(3);
    const porDefecto = (await pedir().expect(200)).body;
    expect(porDefecto.periodo).toBe('30d');
  });

  it('CA-1: cuenta la reserva fallida; CA-3 coincide con HU-32 de cada organización', async () => {
    const g = (await pedir('30d').expect(200)).body;
    expect(g.global.fallidasOExpiradas).toBeGreaterThanOrEqual(1);
    expect(g.global.organizacionesActivas).toBeGreaterThanOrEqual(3);
    for (const org of [a, b]) {
      const r = await e
        .api()
        .get('/api/v1/organizacion/resumen?periodo=30d')
        .set(con(org.token))
        .expect(200);
      expect(de(g, org.id)).toMatchObject({
        viajesPagados: r.body.viajesPagados,
        miembrosActivos: r.body.miembrosActivos,
        co2Kg: r.body.co2Kg,
      });
    }
  });

  it('CA-8: solo agregados, sin personas ni correos', async () => {
    const c = (await pedir('todo').expect(200)).body;
    const texto = JSON.stringify(c);
    expect(texto).not.toContain('@');
    expect(texto).not.toContain(a.adminId);
    expect(Object.keys(c).sort()).toEqual([
      'global',
      'periodo',
      'porOrganizacion',
    ]);
    for (const o of c.porOrganizacion)
      expect(Object.keys(o).sort()).toEqual([
        'co2Kg',
        'miembrosActivos',
        'nombre',
        'organizacionId',
        'sinActividad',
        'viajesPagados',
      ]);
  });

  it('CA-10: la consulta queda en la auditoría; período inválido → 400', async () => {
    await pedir('7d').expect(200);
    const { rows } = await e.bd.query(
      `SELECT count(*)::int AS n FROM registros_auditoria WHERE accion = 'plataforma.metricas.consultadas'`,
    );
    expect(rows[0].n).toBeGreaterThan(0);
    await pedir('1y').expect(400);
  });
});
