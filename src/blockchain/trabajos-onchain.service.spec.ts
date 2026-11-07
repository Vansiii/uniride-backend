import type { AuditoriaService } from '../auditoria/auditoria.service.js';
import type { MovimientosService } from '../billetera/movimientos.service.js';
import type { PrismaService } from '../comun/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { BlockchainService } from './blockchain.service.js';
import { TrabajosOnchainService } from './trabajos-onchain.service.js';

const HASH = `0x${'ab'.repeat(32)}`;
const URC = 10n ** 18n;

function crear(intentos = 0) {
  const tx = {
    trabajoOnchain: { update: vi.fn() },
    ordenRecarga: { update: vi.fn() },
  };
  const prisma = {
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ id: 't1', movimiento_id: 'm1', intentos }])
      .mockResolvedValue([]),
    $transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    movimientoBilletera: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: 'm1',
        monto: new Prisma.Decimal('50.00'),
        claveIdempotencia: 'recarga:orden-1',
        billetera: { direccion: '0xabc', usuarioId: 'u1' },
      }),
    },
  };
  const cadena = {
    acunarRecarga: vi.fn().mockRejectedValue(
      Object.assign(new Error('caído https://nodo.test/clave-rpc'), {
        code: 'SERVER_ERROR',
      }),
    ),
  };
  const movimientos = { actualizarEstado: vi.fn() };
  const auditoria = { registrar: vi.fn() };
  const servicio = new TrabajosOnchainService(
    prisma as unknown as PrismaService,
    { cadena } as unknown as BlockchainService,
    movimientos as unknown as MovimientosService,
    auditoria as unknown as AuditoriaService,
  );
  return { servicio, prisma, tx, cadena, movimientos, auditoria };
}

const datosDeFalla = (c: ReturnType<typeof crear>) =>
  c.tx.trabajoOnchain.update.mock.calls[0][0].data;

describe('TrabajosOnchainService', () => {
  it('con el recibo marca movimiento, orden y trabajo en la misma transacción', async () => {
    const c = crear();
    c.cadena.acunarRecarga.mockResolvedValue(HASH);
    await expect(c.servicio.procesarPendientes()).resolves.toBe(1);
    expect(c.cadena.acunarRecarga.mock.calls[0].slice(0, 2)).toEqual([
      '0xabc',
      50n * URC,
    ]);
    expect(c.movimientos.actualizarEstado).toHaveBeenCalledWith(
      'm1',
      'confirmado',
      HASH,
      c.tx,
    );
    expect(c.tx.ordenRecarga.update.mock.calls[0][0]).toMatchObject({
      where: { id: 'orden-1' },
      data: { estado: 'completada', hashTx: HASH },
    });
    expect(c.tx.trabajoOnchain.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { estado: 'terminado', ultimoError: null },
    });
  });

  it('una falla suma un intento y reprograma, sin marcar nada como fallido', async () => {
    const c = crear(1);
    const antes = Date.now();
    await expect(c.servicio.procesarPendientes()).resolves.toBe(0);
    const datos = datosDeFalla(c);
    expect(datos.intentos).toBe(2);
    expect(datos.estado).toBeUndefined();
    expect(datos.proximoIntentoEn.getTime()).toBeGreaterThanOrEqual(
      antes + 4 * 60_000,
    );
    expect(c.movimientos.actualizarEstado).not.toHaveBeenCalled();
    expect(c.tx.ordenRecarga.update).not.toHaveBeenCalled();
  });

  it('si la BD falla tras acuñar, suma un intento y sigue con el resto del lote', async () => {
    const c = crear(4);
    c.cadena.acunarRecarga.mockResolvedValue(HASH);
    c.prisma.$transaction.mockImplementationOnce(() =>
      Promise.reject(new Error('BD caída')),
    );
    await expect(c.servicio.procesarPendientes()).resolves.toBe(0);
    expect(datosDeFalla(c).intentos).toBe(5);
    expect(c.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'billetera.recarga.atascada' }),
      c.tx,
    );
    expect(c.prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('el error guardado no lleva la URL del nodo', async () => {
    const c = crear();
    await c.servicio.procesarPendientes();
    expect(datosDeFalla(c).ultimoError).toBe('SERVER_ERROR');
  });

  it('la espera crece hasta 1 h como máximo', async () => {
    const c = crear(9);
    const antes = Date.now();
    await c.servicio.procesarPendientes();
    const espera = datosDeFalla(c).proximoIntentoEn.getTime() - antes;
    expect(espera).toBeGreaterThanOrEqual(60 * 60_000);
    expect(espera).toBeLessThan(61 * 60_000);
  });

  it.each([
    [3, 0],
    [4, 1],
    [5, 0],
    [20, 0],
  ])(
    'con %i intentos previos registra %i alertas: una sola vez, al quinto',
    async (previos, alertas) => {
      const c = crear(previos);
      await c.servicio.procesarPendientes();
      expect(c.auditoria.registrar).toHaveBeenCalledTimes(alertas);
      if (alertas)
        expect(c.auditoria.registrar).toHaveBeenCalledWith(
          {
            accion: 'billetera.recarga.atascada',
            entidad: 'orden_recarga',
            entidadId: 'orden-1',
            resultado: 'fallo',
            actorId: 'u1',
            detalle: { intentos: 5, motivo: 'SERVER_ERROR' },
          },
          c.tx,
        );
    },
  );

  it('sin trabajos vencidos no llama a la cadena', async () => {
    const c = crear();
    c.prisma.$queryRaw.mockReset().mockResolvedValue([]);
    await expect(c.servicio.procesarPendientes()).resolves.toBe(0);
    expect(c.cadena.acunarRecarga).not.toHaveBeenCalled();
  });
});
