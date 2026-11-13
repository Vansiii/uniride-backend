import { ErrorBloqueoPermanente } from './blockchain.service.js';
import type { AuditoriaService } from '../auditoria/auditoria.service.js';
import type { MovimientosService } from '../billetera/movimientos.service.js';
import type { PrismaService } from '../comun/prisma.service.js';
import { id } from 'ethers';
import { Prisma } from '../generated/prisma/client.js';
import type { EstadoViajeService } from '../viajes/estado-viaje.service.js';
import type { BlockchainService } from './blockchain.service.js';
import { TrabajosOnchainService } from './trabajos-onchain.service.js';

vi.mock('../billetera/custodia.js', () => ({
  descifrarLlave: vi.fn(() => 'llave-privada-del-pasajero'),
}));

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
    { recalcular: vi.fn() } as unknown as EstadoViajeService,
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

describe('TrabajosOnchainService · bloquear_reserva (HU-19)', () => {
  const CONDUCTOR = '0xC0nductor';
  const PAGADOR = '0xPasajero';

  function crearReserva(
    o: {
      intentos?: number;
      estadoReserva?: string;
      billetera?: string | null;
    } = {},
  ) {
    const tx = {
      trabajoOnchain: { update: vi.fn() },
      reserva: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          viajeId: 'v1',
          organizacionId: 'o1',
        }),
      },
      $executeRaw: vi.fn().mockResolvedValue(1),
    };
    const prisma = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: 't1',
            movimiento_id: 'm1',
            operacion: 'bloquear_reserva',
            intentos: o.intentos ?? 0,
          },
        ])
        .mockResolvedValue([]),
      $transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
      comoSuperAdmin: vi.fn(),
      trabajoOnchain: { update: vi.fn() },
      billetera: {
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ llaveCustodiaRef: 'cifrada' }),
      },
      movimientoBilletera: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'm1',
          billeteraId: 'b1',
          reservaId: 'r1',
          monto: new Prisma.Decimal('10.50'),
          claveIdempotencia: 'reserva:r1',
          billetera: { direccion: PAGADOR, usuarioId: 'u1' },
        }),
      },
    };
    // La primera llamada lee la reserva con su viaje y conductor; las siguientes escriben con `tx`.
    prisma.comoSuperAdmin
      .mockImplementationOnce(() =>
        Promise.resolve({
          estado: o.estadoReserva ?? 'pendiente',
          viajeId: 'v1',
          organizacionId: 'o1',
          viaje: {
            conductor: {
              billetera: o.billetera === null ? null : { direccion: CONDUCTOR },
            },
          },
        }),
      )
      .mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx));
    const cadena = {
      estadoReservaEscrow: vi.fn().mockResolvedValue({ estado: 'ninguno' }),
      bloquearReserva: vi.fn().mockResolvedValue(HASH),
      hashDeBloqueo: vi.fn().mockResolvedValue(HASH),
    };
    const movimientos = { actualizarEstado: vi.fn() };
    const auditoria = { registrar: vi.fn() };
    const estadoViaje = { recalcular: vi.fn() };
    const servicio = new TrabajosOnchainService(
      prisma as unknown as PrismaService,
      { cadena } as unknown as BlockchainService,
      movimientos as unknown as MovimientosService,
      auditoria as unknown as AuditoriaService,
      estadoViaje as unknown as EstadoViajeService,
    );
    return {
      servicio,
      prisma,
      tx,
      cadena,
      movimientos,
      auditoria,
      estadoViaje,
    };
  }
  type Caso = ReturnType<typeof crearReserva>;
  const nodoCaido = () =>
    Object.assign(new Error('caído https://nodo.test/clave-rpc'), {
      code: 'SERVER_ERROR',
    });
  const acciones = (c: Caso) =>
    c.auditoria.registrar.mock.calls.map((l) => l[0].accion);

  it('éxito: firma con la llave custodiada, confirma movimiento y reserva, avanza el viaje y termina el trabajo', async () => {
    const c = crearReserva();
    await expect(c.servicio.procesarPendientes()).resolves.toBe(1);

    expect(c.cadena.bloquearReserva).toHaveBeenCalledWith({
      idReserva: id('r1'),
      llavePagador: 'llave-privada-del-pasajero',
      conductor: CONDUCTOR,
      monto: 10n * URC + URC / 2n,
    });
    expect(c.movimientos.actualizarEstado).toHaveBeenCalledWith(
      'm1',
      'confirmado',
      HASH,
      c.tx,
    );
    expect(c.tx.reserva.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', estado: 'pendiente' },
      data: { estado: 'confirmada' },
    });
    expect(c.estadoViaje.recalcular).toHaveBeenCalledWith(c.tx, 'v1');
    expect(c.tx.trabajoOnchain.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { estado: 'terminado', ultimoError: null },
    });
    expect(acciones(c)).toEqual(['reserva.confirmada']);
  });

  it('la llave del pasajero no llega a la auditoría, al registro ni a la BD', async () => {
    const c = crearReserva();
    await c.servicio.procesarPendientes();
    const escrito = JSON.stringify([
      c.auditoria.registrar.mock.calls,
      c.tx.trabajoOnchain.update.mock.calls,
      c.movimientos.actualizarEstado.mock.calls,
    ]);
    expect(escrito).not.toContain('llave-privada-del-pasajero');
  });

  it('nodo caído: suma un intento y reprograma; no confirma, no anula ni toca el asiento', async () => {
    const c = crearReserva({ intentos: 1 });
    c.cadena.bloquearReserva.mockRejectedValue(nodoCaido());
    const antes = Date.now();
    await expect(c.servicio.procesarPendientes()).resolves.toBe(0);

    const datos = c.tx.trabajoOnchain.update.mock.calls[0][0].data;
    expect(datos.intentos).toBe(2);
    expect(datos.ultimoError).toBe('SERVER_ERROR');
    expect(datos.proximoIntentoEn.getTime()).toBeGreaterThanOrEqual(
      antes + 4 * 60_000,
    );
    expect(c.movimientos.actualizarEstado).not.toHaveBeenCalled();
    expect(c.tx.reserva.updateMany).not.toHaveBeenCalled();
    expect(c.tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('el nodo que falla al consultar el escrow también se reintenta', async () => {
    const c = crearReserva();
    c.cadena.estadoReservaEscrow.mockRejectedValue(nodoCaido());
    await expect(c.servicio.procesarPendientes()).resolves.toBe(0);
    expect(c.cadena.bloquearReserva).not.toHaveBeenCalled();
    expect(c.tx.trabajoOnchain.update.mock.calls[0][0].data.intentos).toBe(1);
  });

  it.each([
    [3, 0],
    [4, 1],
    [5, 0],
  ])(
    'con %i intentos previos registra %i alertas reserva.bloqueo.atascado (RN-7)',
    async (previos, alertas) => {
      const c = crearReserva({ intentos: previos });
      c.cadena.bloquearReserva.mockRejectedValue(nodoCaido());
      await c.servicio.procesarPendientes();
      expect(acciones(c)).toEqual(alertas ? ['reserva.bloqueo.atascado'] : []);
      if (alertas)
        expect(c.auditoria.registrar).toHaveBeenCalledWith(
          {
            accion: 'reserva.bloqueo.atascado',
            entidad: 'reserva',
            entidadId: 'r1',
            resultado: 'fallo',
            actorId: 'u1',
            detalle: { intentos: 5, motivo: 'SERVER_ERROR' },
          },
          c.tx,
        );
    },
  );

  it('falla permanente: movimiento fallido, reserva fallida con su motivo, asiento devuelto y trabajo terminado', async () => {
    const c = crearReserva();
    c.cadena.bloquearReserva.mockRejectedValue(
      new ErrorBloqueoPermanente('ERC20InsufficientBalance'),
    );
    await expect(c.servicio.procesarPendientes()).resolves.toBe(1);

    expect(c.movimientos.actualizarEstado).toHaveBeenCalledWith(
      'm1',
      'fallido',
      undefined,
      c.tx,
    );
    expect(c.tx.reserva.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', estado: 'pendiente' },
      data: { estado: 'fallida', motivo: 'ERC20InsufficientBalance' },
    });
    expect(c.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect((c.tx.$executeRaw.mock.calls[0][0] as string[]).join('')).toContain(
      'cupos_disponibles + 1',
    );
    expect(c.estadoViaje.recalcular).not.toHaveBeenCalled();
    expect(c.tx.trabajoOnchain.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { estado: 'terminado', ultimoError: 'ERC20InsufficientBalance' },
    });
    expect(acciones(c)).toEqual(['reserva.fallida']);
  });

  it('si la reserva ya no estaba pendiente al anularla, no devuelve el asiento otra vez', async () => {
    const c = crearReserva();
    c.cadena.bloquearReserva.mockRejectedValue(
      new ErrorBloqueoPermanente('DatosInvalidos'),
    );
    c.tx.reserva.updateMany.mockResolvedValue({ count: 0 });
    await c.servicio.procesarPendientes();
    expect(c.tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('ya bloqueada en el escrow (respuesta perdida): recupera el hash y no firma ni envía otra vez', async () => {
    const c = crearReserva();
    c.cadena.estadoReservaEscrow.mockResolvedValue({
      estado: 'bloqueada',
      pagador: PAGADOR.toLowerCase(),
      conductor: CONDUCTOR,
      monto: 10n * URC + URC / 2n,
    });
    await expect(c.servicio.procesarPendientes()).resolves.toBe(1);
    expect(c.cadena.bloquearReserva).not.toHaveBeenCalled();
    expect(c.cadena.hashDeBloqueo).toHaveBeenCalledWith(id('r1'));
    expect(c.movimientos.actualizarEstado).toHaveBeenCalledWith(
      'm1',
      'confirmado',
      HASH,
      c.tx,
    );
  });

  it('ya bloqueada con otros datos: falla permanente, nunca se confirma', async () => {
    const c = crearReserva();
    c.cadena.estadoReservaEscrow.mockResolvedValue({
      estado: 'bloqueada',
      pagador: PAGADOR,
      conductor: CONDUCTOR,
      monto: 1n,
    });
    await expect(c.servicio.procesarPendientes()).resolves.toBe(1);
    expect(c.cadena.hashDeBloqueo).not.toHaveBeenCalled();
    expect(acciones(c)).toEqual(['reserva.fallida']);
  });

  it('una reserva que ya no está pendiente se termina sin llamar a la cadena', async () => {
    const c = crearReserva({ estadoReserva: 'fallida' });
    await expect(c.servicio.procesarPendientes()).resolves.toBe(1);
    expect(c.cadena.estadoReservaEscrow).not.toHaveBeenCalled();
    expect(c.prisma.trabajoOnchain.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { estado: 'terminado', ultimoError: null },
    });
  });

  it('un conductor sin billetera se reintenta, sin tocar la cadena', async () => {
    const c = crearReserva({ billetera: null });
    await expect(c.servicio.procesarPendientes()).resolves.toBe(0);
    expect(c.cadena.estadoReservaEscrow).not.toHaveBeenCalled();
    expect(c.tx.trabajoOnchain.update.mock.calls[0][0].data.intentos).toBe(1);
  });
});
