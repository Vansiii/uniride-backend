import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { FirmaDispositivoGuard } from '../comun/firma-dispositivo.guard.js';
import { IdentidadVerificadaGuard } from '../comun/identidad.guard.js';
import type { PrismaService } from '../comun/prisma.service.js';
import { BilleteraController } from './billetera.controller.js';
import type { BilleteraService } from './billetera.service.js';
import { CuentaActivaGuard } from './cuenta-activa.guard.js';
import { SaldoController } from './saldo.controller.js';

const USUARIO = '11111111-1111-4111-8111-111111111111';
const contexto = {
  switchToHttp: () => ({ getRequest: () => ({ usuario: { id: USUARIO } }) }),
} as unknown as ExecutionContext;

describe('CA-4 · guards de la billetera', () => {
  it('todo el controlador exige cuenta activa e identidad, y cada método la firma después (Nest corre los de la clase antes)', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, BilleteraController)).toEqual([
      CuentaActivaGuard,
      IdentidadVerificadaGuard,
    ]);
    for (const metodo of [
      BilleteraController.prototype.crear,
      BilleteraController.prototype.mia,
    ])
      expect(Reflect.getMetadata(GUARDS_METADATA, metodo)).toEqual([
        FirmaDispositivoGuard,
      ]);
  });

  it('HU-14: saldo y movimientos exigen cuenta activa e identidad, sin firma de dispositivo', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, SaldoController)).toEqual([
      CuentaActivaGuard,
      IdentidadVerificadaGuard,
    ]);
    for (const metodo of [
      SaldoController.prototype.saldo,
      SaldoController.prototype.listar,
    ])
      expect(Reflect.getMetadata(GUARDS_METADATA, metodo)).toBeUndefined();
  });

  it.each([
    ['sin fila', null],
    ['no_verificada', { estado: 'no_verificada' }],
    ['en_revision (pendiente)', { estado: 'en_revision' }],
    ['rechazada', { estado: 'rechazada' }],
    ['bloqueada_temporal', { estado: 'bloqueada_temporal' }],
  ])('la identidad %s recibe 403 IDENTIDAD_NO_VERIFICADA', async (_, fila) => {
    const guard = new IdentidadVerificadaGuard({
      identidad: { findUnique: vi.fn().mockResolvedValue(fila) },
    } as unknown as PrismaService);
    await expect(guard.canActivate(contexto)).rejects.toMatchObject({
      status: 403,
      codigo: 'IDENTIDAD_NO_VERIFICADA',
    });
  });

  it('CuentaActivaGuard consulta al usuario del token', async () => {
    const exigirCuentaActiva = vi.fn().mockResolvedValue(undefined);
    const guard = new CuentaActivaGuard({
      exigirCuentaActiva,
    } as unknown as BilleteraService);
    await expect(guard.canActivate(contexto)).resolves.toBe(true);
    expect(exigirCuentaActiva).toHaveBeenCalledWith(USUARIO);
  });
});
