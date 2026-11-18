import pg from 'pg';
import {
  DOMINIO,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import {
  ayudasBilletera,
  URC,
  type CadenaControlable,
} from '../billetera/ayudas-billetera.js';

/** A-09 (doble acreditación): confirmar o reintentar cuantas veces sea acuña una sola vez, y la API no reescribe la orden. */
describe('A-09 · una recarga no se acredita dos veces (e2e)', () => {
  let e: Entorno;
  let cadena: CadenaControlable;
  /** El rol con el que corre la API. `e.bd` es el dueño. */
  let api: pg.Client;
  const b = ayudasBilletera(() => e);
  let n = 0;
  const SIN_PERMISO = { code: '42501' };

  beforeAll(async () => {
    e = await prepararEntorno();
    api = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await api.connect();
  });
  beforeEach(async () => {
    cadena = b.preparar();
    await b.vaciarCola();
  });
  afterAll(async () => {
    await api.end();
    await e.cerrar();
  });

  const conOrden = async () => {
    const u = await b.recargador(`a09r${++n}${DOMINIO}`);
    const { body } = await b.crearRecarga(u.token).expect(201);
    return { u, id: body.ordenId as string };
  };

  it('repetir la confirmación mientras procesa: 202, sin otro movimiento ni trabajo', async () => {
    const { u, id } = await conOrden();
    await b.confirmarRecarga(u.token, id, u.dispositivo).expect(202);
    const r = await b.confirmarRecarga(u.token, id, u.dispositivo).expect(202);
    expect(r.body.estado).toBe('procesando');
    expect(await b.filasDeOrden(id)).toHaveLength(1);
  });

  it('repetirla ya acreditada: 200 con el mismo hash, sin acuñar', async () => {
    const { u, id } = await conOrden();
    await b.confirmarRecarga(u.token, id, u.dispositivo).expect(202);
    await b.worker().procesarPendientes();
    const hash = (await b.filaOrden(id)).hash_tx;
    const r = await b.confirmarRecarga(u.token, id, u.dispositivo).expect(200);
    expect(r.body).toMatchObject({ estado: 'completada', hashTx: hash });
    await b.worker().procesarPendientes();
    expect(cadena.acunaciones).toBe(1);
    expect(cadena.saldos.get(u.direccion)).toBe(50n * URC);
  });

  it('confirmaciones simultáneas: solo una gana', async () => {
    const { u, id } = await conOrden();
    const respuestas = await Promise.all(
      Array.from({ length: 5 }, () =>
        b.confirmarRecarga(u.token, id, u.dispositivo),
      ),
    );
    expect(respuestas.map((r) => r.status)).toEqual(Array(5).fill(202));
    expect(await b.filasDeOrden(id)).toHaveLength(1);
    await b.worker().procesarPendientes();
    expect(cadena.acunaciones).toBe(1);
    expect(cadena.saldos.get(u.direccion)).toBe(50n * URC);
  });

  it('workers simultáneos no toman el mismo trabajo', async () => {
    const { u, id } = await conOrden();
    await b.confirmarRecarga(u.token, id, u.dispositivo).expect(202);
    await Promise.all(
      Array.from({ length: 4 }, () => b.worker().procesarPendientes()),
    );
    expect(cadena.acunaciones).toBe(1);
    expect((await b.filaOrden(id)).estado).toBe('completada');
  });

  it('respuesta perdida: el nodo acuñó y el reintento no acuña de nuevo', async () => {
    const { u, id } = await conOrden();
    await b.confirmarRecarga(u.token, id, u.dispositivo).expect(202);

    cadena.perderRespuesta = true;
    await expect(b.worker().procesarPendientes()).resolves.toBe(0);
    expect((await b.filaOrden(id)).estado).toBe('procesando');
    expect(cadena.saldos.get(u.direccion)).toBe(50n * URC);

    await b.vencerEspera(id);
    await expect(b.worker().procesarPendientes()).resolves.toBe(1);
    expect(await b.filasDeOrden(id)).toMatchObject([
      { estado: 'confirmado', trabajo: 'terminado', intentos: 1 },
    ]);
    expect(cadena.saldos.get(u.direccion)).toBe(50n * URC);
    const saldo = await b.saldo(u.token).expect(200);
    expect(saldo.body.saldoDisponible).toBe('50.00');
    const { rows } = await e.bd.query(
      `SELECT 1 FROM registros_auditoria WHERE accion = 'billetera.conciliacion' AND actor_id = $1`,
      [u.id],
    );
    expect(rows).toEqual([]);
  });

  it('corte del proceso tras tomar el trabajo: al vencer la reserva otro lo retoma', async () => {
    const { u, id } = await conOrden();
    await b.confirmarRecarga(u.token, id, u.dispositivo).expect(202);
    await e.bd.query(
      `UPDATE trabajos_onchain SET proximo_intento_en = now() + interval '5 minutes'
       WHERE movimiento_id = (SELECT id FROM movimientos_billetera WHERE clave_idempotencia = $1)`,
      [`recarga:${id}`],
    );
    await b.worker().procesarPendientes();
    expect(cadena.acunaciones).toBe(0);
    await b.vencerEspera(id);
    await b.worker().procesarPendientes();
    expect((await b.filaOrden(id)).estado).toBe('completada');
  });

  describe('con el rol de la API', () => {
    it.each([
      ['monto', `monto = 500`],
      ['usuario_id', `usuario_id = gen_random_uuid()`],
      ['billetera_id', `billetera_id = gen_random_uuid()`],
      ['expira_en', `expira_en = now() + interval '1 day'`],
    ])('UPDATE de %s de una orden: rechazado', async (_, asignacion) => {
      const { id } = await conOrden();
      await expect(
        api.query(`UPDATE ordenes_recarga SET ${asignacion} WHERE id = $1`, [
          id,
        ]),
      ).rejects.toMatchObject(SIN_PERMISO);
    });

    it.each(['ordenes_recarga', 'trabajos_onchain'])(
      'DELETE y TRUNCATE de %s: rechazados',
      async (tabla) => {
        await expect(api.query(`DELETE FROM ${tabla}`)).rejects.toMatchObject(
          SIN_PERMISO,
        );
        await expect(api.query(`TRUNCATE ${tabla}`)).rejects.toMatchObject(
          SIN_PERMISO,
        );
      },
    );

    it.each([
      ['monto fuera de rango', 501, 'pendiente'],
      ['monto bajo', 9.99, 'pendiente'],
      ['estado desconocido', 50, 'regalada'],
      ['completada sin hash', 50, 'completada'],
    ])('INSERT con %s: la BD lo rechaza', async (_, monto, estado) => {
      const { u } = await conOrden();
      await expect(
        api.query(
          `INSERT INTO ordenes_recarga (usuario_id, billetera_id, monto, estado, expira_en) VALUES ($1, $2, $3, $4, now())`,
          [u.id, u.billetera, monto, estado],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });
});
