import { Injectable, Logger } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import {
  BlockchainService,
  formatearUrc,
  unidadesAUrc,
} from '../blockchain/blockchain.service.js';
import { BilleteraService, tipoDeError } from './billetera.service.js';
import type { SaldoDto } from './dto/saldo.dto.js';
import { MovimientosService } from './movimientos.service.js';

/** Plan HU-14 §3. La falla del nodo nunca llega al usuario como error: responde el libro con `enLinea: false`. */
@Injectable()
export class ConciliacionService {
  private readonly registro = new Logger(ConciliacionService.name);

  constructor(
    private readonly billeteras: BilleteraService,
    private readonly movimientos: MovimientosService,
    private readonly blockchain: BlockchainService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async saldo(usuarioId: string): Promise<SaldoDto> {
    const billetera = await this.billeteras.exigir(usuarioId);
    const lectura = await this.blockchain
      .leerSaldoConCache(billetera.direccion)
      .catch((error: unknown) => {
        this.registro.warn(`Saldo sin nodo (${tipoDeError(error)})`);
        return null;
      });
    const { contable, bloqueado, pendientes } = await this.movimientos.resumen(
      billetera.id,
    );

    // Con pendientes el libro y la cadena pueden diferir sin que nada ande mal; del caché ya se comparó al leerlo.
    if (lectura?.real && pendientes === 0 && lectura.saldo !== contable)
      await this.reportarDiferencia(
        usuarioId,
        billetera.id,
        lectura.saldo,
        contable,
      );

    const disponible = lectura ? lectura.saldo : contable > 0n ? contable : 0n;
    return {
      saldoTotal: formatearUrc(disponible + bloqueado),
      saldoDisponible: formatearUrc(disponible),
      saldoBloqueadoEscrow: formatearUrc(bloqueado),
      moneda: 'URC',
      enLinea: lectura !== null,
    };
  }

  /** Art. 4.6: toda diferencia se reporta, sin cambiar la respuesta aunque la auditoría falle. */
  private async reportarDiferencia(
    usuarioId: string,
    billeteraId: string,
    cadena: bigint,
    contable: bigint,
  ): Promise<void> {
    this.registro.warn(`Diferencia BD y cadena en la billetera ${billeteraId}`);
    await this.auditoria
      .registrar({
        accion: 'billetera.conciliacion',
        entidad: 'billetera',
        entidadId: billeteraId,
        resultado: 'fallo',
        actorId: usuarioId,
        detalle: {
          saldoCadena: unidadesAUrc(cadena),
          saldoContable: unidadesAUrc(contable),
        },
      })
      .catch(() =>
        this.registro.warn('No se pudo auditar la diferencia de saldo'),
      );
  }
}
