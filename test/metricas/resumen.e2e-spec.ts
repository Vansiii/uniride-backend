import { randomUUID } from 'node:crypto';
import {
  DOMINIO,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import { ayudasFraude, DIA_MS } from '../fraude/ayudas-fraude.js';

/** HU-32: el administrador ve las cifras de su organización por período. 0,1° de latitud ≈ 11,12 km. */
describe('HU-32 · resumen de la organización (e2e)', () => {
  let e: Entorno;
  const f = ayudasFraude(() => e);
  let org: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let vacia: Awaited<ReturnType<typeof organizacionConAdmin>>;
  const con = (t: string) => ({ Authorization: `Bearer ${t}` });
  const RUTA = '/api/v1/organizacion/resumen';
  const hace = (dias: number) => new Date(Date.now() - dias * DIA_MS);

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    const superToken = await e.iniciar(`super${DOMINIO}`);
    org = await organizacionConAdmin(e, superToken, 'Resumen A');
    vacia = await organizacionConAdmin(e, superToken, 'Resumen Vacia');
    await f.r.preparar();
    const c = await f.persona(org.id);
    const pagada = async (
      i: number,
      grados: number,
      pagadaHace: number,
      estado: 'pagada' | 'verificacion_fallida' = 'pagada',
    ) => {
      const p = await f.persona(org.id);
      const salida = hace(pagadaHace + 1);
      salida.setMinutes(salida.getMinutes() + i * 5);
      const { reservaId, viajeId } = await f.reservaEn(org.id, c, p, salida, {
        estado,
      });
      await e.bd.query(
        `UPDATE viajes SET origen_lat = -17.78, origen_lng = -63.18, destino_lat = $2, destino_lng = -63.18 WHERE id = $1`,
        [viajeId, -17.78 + grados],
      );
      await e.bd.query(
        `INSERT INTO movimientos_billetera (billetera_id, tipo, monto, estado, reserva_id, hash_tx, clave_idempotencia, creado_en)
         VALUES ($1, 'liberacion_viaje', 10.50, 'confirmado', $2, '0x' || repeat('a', 64), $3, $4)`,
        [c.billetera, reservaId, randomUUID(), hace(pagadaHace)],
      );
    };
    await pagada(1, 0.1, 2); // dentro de 7 días
    await pagada(2, 0.05, 20); // dentro de 30
    await pagada(3, 0.1, 40); // solo «todo»
    await pagada(4, 0.1, 1, 'verificacion_fallida'); // no pagada: no cuenta
  });
  afterAll(() => e.cerrar());

  const pedir = (periodo?: string) =>
    e
      .api()
      .get(periodo ? `${RUTA}?periodo=${periodo}` : RUTA)
      .set(con(org.token));

  it('CA-2, CA-4, CA-5: cuenta solo reservas pagadas del período; CO₂ = km × 0,12 con un decimal', async () => {
    const d7 = (await pedir('7d').expect(200)).body;
    expect(d7).toMatchObject({
      periodo: '7d',
      viajesPagados: 1,
      pasajeros: 1,
      co2Kg: 1.3,
    });
    const d30 = (await pedir('30d').expect(200)).body;
    expect(d30).toMatchObject({ viajesPagados: 2, pasajeros: 2, co2Kg: 2 });
    const todo = (await pedir('todo').expect(200)).body;
    expect(todo).toMatchObject({ viajesPagados: 3, pasajeros: 3, co2Kg: 3.3 });
    expect(todo.miembrosActivos).toBeGreaterThanOrEqual(5);
  });

  it('CA-3: sin período usa 30 días', async () => {
    const r = await pedir().expect(200);
    expect(r.body).toMatchObject({ periodo: '30d', viajesPagados: 2 });
  });

  it('CA-6: organización sin viajes → ceros', async () => {
    const r = await e.api().get(RUTA).set(con(vacia.token)).expect(200);
    expect(r.body).toEqual({
      periodo: '30d',
      viajesPagados: 0,
      miembrosActivos: 1,
      pasajeros: 0,
      co2Kg: 0,
    });
  });

  it('CA-9: la consulta queda en la auditoría', async () => {
    await pedir('7d').expect(200);
    const { rows } = await e.bd.query(
      `SELECT count(*)::int AS n FROM registros_auditoria WHERE organizacion_id = $1 AND accion = 'organizacion.resumen.consultado'`,
      [org.id],
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('período inválido → 400', async () => {
    await pedir('1y').expect(400);
  });
});
