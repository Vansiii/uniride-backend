import type { BlockchainService } from '../blockchain/blockchain.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import type { PrismaService } from '../comun/prisma.service.js';
import type { BilleteraService } from './billetera.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { MovimientosService } from './movimientos.service.js';

const URC = 10n ** 18n;
const NUEVO = {
  billeteraId: 'b1',
  tipo: 'recarga' as const,
  monto: '10.00',
  claveIdempotencia: 'clave-1',
};

function crear() {
  const movimientoBilletera = {
    createMany: vi.fn().mockResolvedValue({ count: 1 }),
    findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'm1' }),
    update: vi.fn().mockResolvedValue({ id: 'm1' }),
    count: vi.fn().mockResolvedValue(0),
    findMany: vi.fn().mockResolvedValue([]),
  };
  const prisma = { movimientoBilletera, $queryRaw: vi.fn() };
  const billeteras = { exigir: vi.fn().mockResolvedValue({ id: 'b1' }) };
  const cadena = {
    exploradorTxUrl: vi.fn((hash: string) => `https://explorador/tx/${hash}`),
  };
  const servicio = new MovimientosService(
    prisma as unknown as PrismaService,
    billeteras as unknown as BilleteraService,
    { cadena } as unknown as BlockchainService,
  );
  return { servicio, prisma, movimientoBilletera, billeteras };
}

describe('MovimientosService', () => {
  describe('registrar', () => {
    it('inserta sin error ante duplicado y devuelve la fila de esa clave', async () => {
      const c = crear();
      const r = await c.servicio.registrar(NUEVO);
      expect(r).toEqual({ movimiento: { id: 'm1' }, creado: true });
      expect(c.movimientoBilletera.createMany).toHaveBeenCalledWith({
        data: [NUEVO],
        skipDuplicates: true,
      });
      expect(c.movimientoBilletera.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { claveIdempotencia: 'clave-1' },
      });
    });

    const original = {
      id: 'm1',
      billeteraId: 'b1',
      tipo: 'recarga',
      monto: new Prisma.Decimal('10.00'),
      reservaId: null,
    };

    it('con clave repetida y los mismos datos devuelve creado false', async () => {
      const c = crear();
      c.movimientoBilletera.createMany.mockResolvedValue({ count: 0 });
      c.movimientoBilletera.findUniqueOrThrow.mockResolvedValue(original);
      const r = await c.servicio.registrar({ ...NUEVO, monto: '10' });
      expect(r).toEqual({ movimiento: original, creado: false });
    });

    it.each([
      ['otra billetera', { billeteraId: 'b2' }],
      ['otro tipo', { tipo: 'reembolso_reserva' as const }],
      ['otro monto', { monto: '10.01' }],
      ['otra reserva', { reservaId: 'r2' }],
    ])('con clave repetida y %s falla', async (_, cambio) => {
      const c = crear();
      c.movimientoBilletera.createMany.mockResolvedValue({ count: 0 });
      c.movimientoBilletera.findUniqueOrThrow.mockResolvedValue(original);
      await expect(
        c.servicio.registrar({ ...NUEVO, ...cambio }),
      ).rejects.toMatchObject({
        codigo: 'CLAVE_IDEMPOTENCIA_EN_CONFLICTO',
        status: 409,
      });
    });

    it.each(['10.005', '-1', 'abc', '1e3', ''])(
      'rechaza el monto %j sin tocar la BD',
      async (monto) => {
        const c = crear();
        await expect(
          c.servicio.registrar({ ...NUEVO, monto }),
        ).rejects.toMatchObject({ codigo: 'MONTO_INVALIDO', status: 400 });
        expect(c.movimientoBilletera.createMany).not.toHaveBeenCalled();
      },
    );

    it('usa la transacción de quien llama', async () => {
      const c = crear();
      const tx = {
        movimientoBilletera: {
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'm2' }),
        },
      };
      const r = await c.servicio.registrar(NUEVO, tx as never);
      expect(r.movimiento.id).toBe('m2');
      expect(c.movimientoBilletera.createMany).not.toHaveBeenCalled();
    });
  });

  it('actualizarEstado solo escribe estado y hash', async () => {
    const c = crear();
    await c.servicio.actualizarEstado('m1', 'confirmado', '0xhash');
    expect(c.movimientoBilletera.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { estado: 'confirmado', hashTx: '0xhash' },
    });
  });

  describe('listar', () => {
    const fila = (o: object) => ({
      id: 'm1',
      tipo: 'recarga',
      monto: { toFixed: () => '10.00' },
      estado: 'confirmado',
      hashTx: '0xhash',
      reservaId: null,
      claveIdempotencia: 'secreta',
      metadatos: { interno: true },
      creadoEn: new Date('2026-11-06T12:00:00Z'),
      ...o,
    });

    it('filtra por la billetera del usuario y calcula salto y páginas', async () => {
      const c = crear();
      c.movimientoBilletera.count.mockResolvedValue(45);
      const r = await c.servicio.listar('u1', {
        pagina: 3,
        limite: 20,
        tipo: ['recarga'],
      });
      expect(c.billeteras.exigir).toHaveBeenCalledWith('u1');
      const where = { billeteraId: 'b1', tipo: { in: ['recarga'] } };
      expect(c.movimientoBilletera.count).toHaveBeenCalledWith({ where });
      expect(c.movimientoBilletera.findMany).toHaveBeenCalledWith({
        where,
        orderBy: [{ creadoEn: 'desc' }, { id: 'desc' }],
        skip: 40,
        take: 20,
      });
      expect(r).toEqual({ items: [], total: 45, pagina: 3, paginas: 3 });
    });

    it('expone solo lo público: ni clave de idempotencia ni metadatos', async () => {
      const c = crear();
      c.movimientoBilletera.findMany.mockResolvedValue([fila({})]);
      const r = await c.servicio.listar('u1', { pagina: 1, limite: 20 });
      expect(r.items[0]).toEqual({
        id: 'm1',
        tipo: 'recarga',
        monto: '10.00',
        estado: 'confirmado',
        hashTx: '0xhash',
        exploradorUrl: 'https://explorador/tx/0xhash',
        creadoEn: new Date('2026-11-06T12:00:00Z'),
      });
    });

    it('sin hash no hay enlace', async () => {
      const c = crear();
      c.movimientoBilletera.findMany.mockResolvedValue([
        fila({ hashTx: null, estado: 'pendiente' }),
      ]);
      const r = await c.servicio.listar('u1', { pagina: 1, limite: 20 });
      expect(r.items[0].exploradorUrl).toBeNull();
    });

    it('sin billetera deja pasar el 404 (CA-6)', async () => {
      const c = crear();
      const error = new ErrorNegocio(404, 'BILLETERA_NO_ENCONTRADA', 'clave');
      c.billeteras.exigir.mockRejectedValue(error);
      await expect(
        c.servicio.listar('u1', { pagina: 1, limite: 20 }),
      ).rejects.toBe(error);
    });
  });

  it('resumen pasa los montos del libro a unidades mínimas, también si es negativo', async () => {
    const c = crear();
    c.prisma.$queryRaw.mockResolvedValue([
      { contable: '-5.50', bloqueado: '15.00', pendientes: 2, confirmados: 4 },
    ]);
    await expect(c.servicio.resumen('b1')).resolves.toEqual({
      contable: (-55n * URC) / 10n,
      bloqueado: 15n * URC,
      pendientes: 2,
      confirmados: 4,
    });
  });
});
