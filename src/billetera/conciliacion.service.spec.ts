import { Logger } from '@nestjs/common';
import type { AuditoriaService } from '../auditoria/auditoria.service.js';
import type { BlockchainService } from '../blockchain/blockchain.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import type { BilleteraService } from './billetera.service.js';
import { ConciliacionService } from './conciliacion.service.js';
import type { MovimientosService } from './movimientos.service.js';

const URC = 10n ** 18n;
const FILA = { id: 'b1', direccion: '0xabc' };

function crear(
  o: {
    lectura?: { saldo: bigint; real: boolean } | Error;
    contable?: bigint;
    bloqueado?: bigint;
    pendientes?: number;
  } = {},
) {
  const lectura = o.lectura ?? { saldo: 100n * URC, real: true };
  const blockchain = {
    leerSaldoConCache:
      lectura instanceof Error
        ? vi.fn().mockRejectedValue(lectura)
        : vi.fn().mockResolvedValue(lectura),
  };
  const movimientos = {
    resumen: vi.fn().mockResolvedValue({
      contable: o.contable ?? 100n * URC,
      bloqueado: o.bloqueado ?? 0n,
      pendientes: o.pendientes ?? 0,
    }),
  };
  const billeteras = { exigir: vi.fn().mockResolvedValue(FILA) };
  const auditoria = { registrar: vi.fn().mockResolvedValue(undefined) };
  const servicio = new ConciliacionService(
    billeteras as unknown as BilleteraService,
    movimientos as unknown as MovimientosService,
    blockchain as unknown as BlockchainService,
    auditoria as unknown as AuditoriaService,
  );
  return { servicio, blockchain, movimientos, billeteras, auditoria };
}

describe('CA-4 · ConciliacionService', () => {
  let aviso: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    aviso = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => aviso.mockRestore());

  it('lee de la billetera del usuario y desglosa: disponible = cadena; total = cadena + bloqueado', async () => {
    const c = crear({
      lectura: { saldo: 135n * URC, real: true },
      contable: 135n * URC,
      bloqueado: 15n * URC,
    });
    await expect(c.servicio.saldo('u1')).resolves.toEqual({
      saldoTotal: '150.00',
      saldoDisponible: '135.00',
      saldoBloqueadoEscrow: '15.00',
      moneda: 'URC',
      enLinea: true,
    });
    expect(c.billeteras.exigir).toHaveBeenCalledWith('u1');
    expect(c.blockchain.leerSaldoConCache).toHaveBeenCalledWith(FILA.direccion);
    expect(c.movimientos.resumen).toHaveBeenCalledWith(FILA.id);
    expect(c.auditoria.registrar).not.toHaveBeenCalled();
  });

  it('sin billetera deja pasar el 404 y no toca la cadena (CA-6)', async () => {
    const c = crear();
    const error = new ErrorNegocio(404, 'BILLETERA_NO_ENCONTRADA', 'clave');
    c.billeteras.exigir.mockRejectedValue(error);
    await expect(c.servicio.saldo('u1')).rejects.toBe(error);
    expect(c.blockchain.leerSaldoConCache).not.toHaveBeenCalled();
  });

  it('una diferencia en lectura real se audita sin cambiar la respuesta', async () => {
    const c = crear({
      lectura: { saldo: 90n * URC, real: true },
      contable: 100n * URC,
    });
    const r = await c.servicio.saldo('u1');
    expect(r).toMatchObject({ saldoDisponible: '90.00', enLinea: true });
    expect(c.auditoria.registrar).toHaveBeenCalledWith({
      accion: 'billetera.conciliacion',
      entidad: 'billetera',
      entidadId: FILA.id,
      resultado: 'fallo',
      actorId: 'u1',
      detalle: { saldoCadena: '90.0', saldoContable: '100.0' },
    });
    expect(aviso).toHaveBeenCalledWith(expect.stringContaining(FILA.id));
  });

  it('compara en unidades mínimas: una diferencia menor a un centavo también se reporta', async () => {
    const c = crear({
      lectura: { saldo: 100n * URC + 1n, real: true },
      contable: 100n * URC,
    });
    await c.servicio.saldo('u1');
    expect(c.auditoria.registrar).toHaveBeenCalledOnce();
  });

  it.each([
    ['del caché', { lectura: { saldo: 90n * URC, real: false } }],
    [
      'con movimientos pendientes',
      { lectura: { saldo: 90n * URC, real: true }, pendientes: 1 },
    ],
    ['con el nodo caído', { lectura: new Error('caído') }],
  ])('%s no concilia', async (_, opciones) => {
    const c = crear(opciones);
    await c.servicio.saldo('u1');
    expect(c.auditoria.registrar).not.toHaveBeenCalled();
  });

  it('si la auditoría falla la respuesta no cambia', async () => {
    const c = crear({
      lectura: { saldo: 90n * URC, real: true },
      contable: 100n * URC,
    });
    c.auditoria.registrar.mockRejectedValue(new Error('bd'));
    await expect(c.servicio.saldo('u1')).resolves.toMatchObject({
      saldoDisponible: '90.00',
      enLinea: true,
    });
  });

  it('sin nodo responde el libro con enLinea false y sin la URL del nodo en el log', async () => {
    const c = crear({
      lectura: Object.assign(new Error('fallo en https://nodo.test/clave'), {
        code: 'SERVER_ERROR',
      }),
      contable: 135n * URC,
      bloqueado: 15n * URC,
    });
    await expect(c.servicio.saldo('u1')).resolves.toEqual({
      saldoTotal: '150.00',
      saldoDisponible: '135.00',
      saldoBloqueadoEscrow: '15.00',
      moneda: 'URC',
      enLinea: false,
    });
    expect(aviso).toHaveBeenCalledWith('Saldo sin nodo (SERVER_ERROR)');
  });

  it('sin nodo, un libro negativo se muestra como 0.00', async () => {
    const c = crear({ lectura: new Error('caído'), contable: -5n * URC });
    await expect(c.servicio.saldo('u1')).resolves.toMatchObject({
      saldoDisponible: '0.00',
      saldoTotal: '0.00',
    });
  });
});
