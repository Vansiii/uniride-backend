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
  let otraBilletera: string;
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
    ({ billetera: otraBilletera } = await b.billetera(
      await e.crearUsuario(`a09otra${DOMINIO}`),
    ));
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
        monto: '50.0',
      });
      expect(primero.creado).toBe(true);
      expect(repetido.creado).toBe(false);
      expect(repetido.movimiento.id).toBe(primero.movimiento.id);
      expect(repetido.movimiento.monto.toFixed(2)).toBe('50.00');
      expect(await cuenta(clave)).toBe(1);
    });

    it.each([
      ['otro monto', () => ({ monto: '9999.00' })],
      [
        'otro tipo',
        () => ({ tipo: 'liberacion_viaje' as const, reservaId: randomUUID() }),
      ],
      ['otra billetera', () => ({ billeteraId: otraBilletera })],
    ])('con %s falla y no cambia el original', async (_, cambio) => {
      const clave = randomUUID();
      await servicio.registrar(nuevo(clave));
      await expect(
        servicio.registrar({ ...nuevo(clave), ...cambio() }),
      ).rejects.toMatchObject({ codigo: 'CLAVE_IDEMPOTENCIA_EN_CONFLICTO' });
      const { rows } = await e.bd.query(
        `SELECT monto, tipo, billetera_id FROM movimientos_billetera WHERE clave_idempotencia = $1`,
        [clave],
      );
      expect(rows).toEqual([
        { monto: '50.00', tipo: 'recarga', billetera_id: billeteraId },
      ]);
    });

    it('un monto con más de 2 decimales se rechaza, sin redondear', async () => {
      const clave = randomUUID();
      await expect(
        servicio.registrar({ ...nuevo(clave), monto: '10.005' }),
      ).rejects.toMatchObject({ codigo: 'MONTO_INVALIDO' });
      expect(await cuenta(clave)).toBe(0);
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

    describe('lo confirmado queda congelado, con el rol de la API', () => {
      const actualizar = (asignacion: string, ...valores: string[]) =>
        api.query(
          `UPDATE movimientos_billetera SET ${asignacion} WHERE id = $1`,
          [id, ...valores],
        );
      const fila = async () =>
        (
          await e.bd.query(
            `SELECT estado, hash_tx FROM movimientos_billetera WHERE id = $1`,
            [id],
          )
        ).rows[0];
      beforeEach(() => actualizar(`estado = 'confirmado', hash_tx = $2`, HASH));

      it.each([
        ['revertir a pendiente', `estado = 'pendiente'`],
        ['pasar a fallido', `estado = 'fallido'`],
        ['borrarle el hash y revertir', `estado = 'pendiente', hash_tx = NULL`],
        ['cambiarle el hash', `hash_tx = '0x${'cd'.repeat(32)}'`],
      ])('%s: rechazado', async (_, asignacion) => {
        await expect(actualizar(asignacion)).rejects.toThrow(
          'un movimiento confirmado no cambia',
        );
        expect(await fila()).toEqual({ estado: 'confirmado', hash_tx: HASH });
      });

      it('tampoco por el servicio', async () => {
        await expect(
          servicio.actualizarEstado(id, 'fallido'),
        ).rejects.toThrow();
        expect(await fila()).toEqual({ estado: 'confirmado', hash_tx: HASH });
      });
    });

    it('pendiente pasa a fallido, y fallido es final: ni el servicio ni el rol de la API lo cambian', async () => {
      await expect(
        servicio.actualizarEstado(id, 'fallido'),
      ).resolves.toMatchObject({ estado: 'fallido' });
      await expect(
        servicio.actualizarEstado(id, 'pendiente'),
      ).rejects.toThrow();
      await expect(
        servicio.actualizarEstado(id, 'confirmado', HASH),
      ).rejects.toThrow();
      await expect(
        api.query(
          `UPDATE movimientos_billetera SET estado = 'confirmado', hash_tx = $2 WHERE id = $1`,
          [id, HASH],
        ),
      ).rejects.toThrow('un movimiento fallido no cambia');
      const { rows } = await e.bd.query(
        `SELECT estado, hash_tx FROM movimientos_billetera WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({ estado: 'fallido', hash_tx: null });
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
