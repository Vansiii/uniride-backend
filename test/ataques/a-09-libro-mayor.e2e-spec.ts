import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { MovimientosService } from '../../src/billetera/movimientos.service.js';
import { PrismaService } from '../../src/comun/prisma.service.js';
import {
  DOMINIO,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import { ayudasBilletera, HASH } from '../billetera/ayudas-billetera.js';

/** A-09 (cobro indebido, saldo inconsistente): el libro mayor no se reescribe ni se cobra dos veces, ni con el rol de la API. */
describe('A-09 · libro mayor inmutable (e2e)', () => {
  let e: Entorno;
  /** El rol con el que corre la API. `e.bd` es el dueño. */
  let api: pg.Client;
  let billeteraId: string;
  let servicio: MovimientosService;
  const b = ayudasBilletera(() => e);
  const SIN_PERMISO = { code: '42501' };

  beforeAll(async () => {
    e = await prepararEntorno();
    b.preparar();
    api = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await api.connect();
    const usuario = await e.crearUsuario(`a09${DOMINIO}`);
    ({ billetera: billeteraId } = await b.billetera(usuario));
    servicio = e.app.get(MovimientosService, { strict: false });
  });
  afterAll(async () => {
    await api.end();
    await e.cerrar();
  });

  const nuevo = (claveIdempotencia = randomUUID()) => ({
    billeteraId,
    tipo: 'recarga' as const,
    monto: '50.00',
    claveIdempotencia,
  });
  const cuenta = async (clave: string) =>
    (
      await e.bd.query(
        `SELECT count(*)::int AS n FROM movimientos_billetera WHERE clave_idempotencia = $1`,
        [clave],
      )
    ).rows[0].n as number;

  describe('clave_idempotencia repetida', () => {
    it('el servicio no registra dos veces y devuelve el original', async () => {
      const clave = randomUUID();
      const primero = await servicio.registrar(nuevo(clave));
      const repetido = await servicio.registrar({
        ...nuevo(clave),
        monto: '9999.00',
      });
      expect(primero.creado).toBe(true);
      expect(repetido.creado).toBe(false);
      expect(repetido.movimiento.id).toBe(primero.movimiento.id);
      expect(repetido.movimiento.monto.toFixed(2)).toBe('50.00');
      expect(await cuenta(clave)).toBe(1);
    });

    it('peticiones simultáneas: solo una inserta', async () => {
      const clave = randomUUID();
      const r = await Promise.all(
        Array.from({ length: 5 }, () => servicio.registrar(nuevo(clave))),
      );
      expect(r.filter((x) => x.creado).length).toBe(1);
      expect(new Set(r.map((x) => x.movimiento.id)).size).toBe(1);
      expect(await cuenta(clave)).toBe(1);
    });

    it('la repetición no aborta la transacción de quien llama', async () => {
      const clave = randomUUID();
      await servicio.registrar(nuevo(clave));
      const otra = randomUUID();
      await e.app
        .get(PrismaService, { strict: false })
        .$transaction(async (tx) => {
          await servicio.registrar(nuevo(clave), tx);
          await servicio.registrar(nuevo(otra), tx);
        });
      expect(await cuenta(otra)).toBe(1);
    });

    it('la BD la rechaza con el rol de la API aunque se salte el servicio', async () => {
      const clave = randomUUID();
      const insertar = () =>
        api.query(
          `INSERT INTO movimientos_billetera (billetera_id, tipo, monto, clave_idempotencia) VALUES ($1, 'recarga', 1, $2)`,
          [billeteraId, clave],
        );
      await insertar();
      await expect(insertar()).rejects.toMatchObject({ code: '23505' });
    });
  });

  describe('la fila escrita no cambia', () => {
    let id: string;
    beforeEach(async () => {
      ({
        movimiento: { id },
      } = await servicio.registrar(nuevo()));
    });

    it.each([
      ['monto', `monto = 1`],
      ['tipo', `tipo = 'liberacion_viaje'`],
      ['billetera_id', `billetera_id = gen_random_uuid()`],
      ['clave_idempotencia', `clave_idempotencia = 'otra'`],
      ['creado_en', `creado_en = now() - interval '1 day'`],
      ['reserva_id', `reserva_id = gen_random_uuid()`],
      ['metadatos', `metadatos = '{}'`],
    ])('UPDATE de %s: rechazado al rol de la API', async (_, asignacion) => {
      await expect(
        api.query(
          `UPDATE movimientos_billetera SET ${asignacion} WHERE id = $1`,
          [id],
        ),
      ).rejects.toMatchObject(SIN_PERMISO);
    });

    it.each([
      ['monto', `monto = 1`],
      ['clave_idempotencia', `clave_idempotencia = 'otra'`],
      ['metadatos', `metadatos = '{"a": 1}'`],
    ])(
      'UPDATE de %s: el trigger frena hasta al dueño',
      async (_, asignacion) => {
        await expect(
          e.bd.query(
            `UPDATE movimientos_billetera SET ${asignacion} WHERE id = $1`,
            [id],
          ),
        ).rejects.toThrow('solo inserción');
      },
    );

    it('DELETE y TRUNCATE: rechazados al rol de la API', async () => {
      await expect(
        api.query(`DELETE FROM movimientos_billetera WHERE id = $1`, [id]),
      ).rejects.toMatchObject(SIN_PERMISO);
      await expect(
        api.query(`TRUNCATE movimientos_billetera`),
      ).rejects.toMatchObject(SIN_PERMISO);
      const { rows } = await e.bd.query(
        `SELECT monto FROM movimientos_billetera WHERE id = $1`,
        [id],
      );
      expect(rows[0].monto).toBe('50.00');
    });

    it('solo avanza estado y hash_tx, con el rol de la API', async () => {
      const { rowCount } = await api.query(
        `UPDATE movimientos_billetera SET estado = 'confirmado', hash_tx = $2 WHERE id = $1`,
        [id, HASH],
      );
      expect(rowCount).toBe(1);
    });

    it('sin hash no se confirma; con hash mal formado tampoco', async () => {
      await expect(
        servicio.actualizarEstado(id, 'confirmado'),
      ).rejects.toThrow();
      await expect(
        api.query(
          `UPDATE movimientos_billetera SET estado = 'confirmado', hash_tx = 'x' WHERE id = $1`,
          [id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  it.each([
    ['monto 0', '0', 'recarga'],
    ['monto negativo', '-5', 'recarga'],
    ['tipo desconocido', '5', 'regalo'],
    ['bloqueo sin reserva', '5', 'bloqueo_reserva'],
  ])('%s: la BD lo rechaza', async (_, monto, tipo) => {
    await expect(
      api.query(
        `INSERT INTO movimientos_billetera (billetera_id, tipo, monto, clave_idempotencia) VALUES ($1, $2, $3, $4)`,
        [billeteraId, tipo, monto, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
