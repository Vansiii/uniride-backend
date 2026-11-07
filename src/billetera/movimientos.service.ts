import { Injectable } from '@nestjs/common';
import {
  BlockchainService,
  urcAUnidades,
} from '../blockchain/blockchain.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService, type Transaccion } from '../comun/prisma.service.js';
import { BilleteraService } from './billetera.service.js';
import type {
  ConsultaMovimientosDto,
  EstadoMovimiento,
  MovimientoDto,
  PaginaMovimientosDto,
  TipoMovimiento,
} from './dto/saldo.dto.js';

export interface NuevoMovimiento {
  billeteraId: string;
  tipo: TipoMovimiento;
  /** En URC, con hasta 2 decimales: "15.00". */
  monto: string;
  claveIdempotencia: string;
  reservaId?: string;
  metadatos?: object;
}

/** Montos en unidades mínimas del token. `contable` puede ser negativo si el libro no cuadra. */
export interface ResumenLibro {
  contable: bigint;
  bloqueado: bigint;
  pendientes: number;
  confirmados: number;
}

/** Hasta 2 decimales: la columna redondearía en silencio. */
const MONTO_VALIDO = /^\d+(\.\d{1,2})?$/;

/** Libro mayor de la billetera (RN-1). */
@Injectable()
export class MovimientosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billeteras: BilleteraService,
    private readonly blockchain: BlockchainService,
  ) {}

  /**
   * Nace `pendiente` (`ssd.md` §10). Con una clave repetida no inserta y devuelve el movimiento original si es la
   * misma operación; con otra billetera, tipo, monto o reserva falla (A-09). `ON CONFLICT DO NOTHING` no aborta la
   * transacción `tx` de quien llama, a diferencia de capturar el P2002.
   */
  async registrar(
    nuevo: NuevoMovimiento,
    tx: Transaccion | PrismaService = this.prisma,
  ) {
    if (!MONTO_VALIDO.test(nuevo.monto))
      throw new ErrorNegocio(
        400,
        'MONTO_INVALIDO',
        'billetera.recarga.monto_invalido',
      );
    const { count } = await tx.movimientoBilletera.createMany({
      data: [nuevo],
      skipDuplicates: true,
    });
    const movimiento = await tx.movimientoBilletera.findUniqueOrThrow({
      where: { claveIdempotencia: nuevo.claveIdempotencia },
    });
    if (
      count === 0 &&
      (movimiento.billeteraId !== nuevo.billeteraId ||
        movimiento.tipo !== nuevo.tipo ||
        !movimiento.monto.equals(nuevo.monto) ||
        movimiento.reservaId !== (nuevo.reservaId ?? null))
    )
      throw new ErrorNegocio(
        409,
        'CLAVE_IDEMPOTENCIA_EN_CONFLICTO',
        'billetera.movimiento.clave_en_conflicto',
      );
    return { movimiento, creado: count === 1 };
  }

  /** Lo único que cambia de un movimiento ya escrito; la BD exige `hashTx` para confirmarlo (RN-3) y rechaza cambiar uno confirmado o fallido. */
  actualizarEstado(
    id: string,
    estado: EstadoMovimiento,
    hashTx?: string,
    tx: Transaccion | PrismaService = this.prisma,
  ) {
    return tx.movimientoBilletera.update({
      where: { id },
      data: { estado, hashTx },
    });
  }

  /** Siempre la billetera del token: el historial no recibe ningún id de billetera (A-10). */
  async listar(
    usuarioId: string,
    { pagina, limite, tipo }: ConsultaMovimientosDto,
  ): Promise<PaginaMovimientosDto> {
    const { id } = await this.billeteras.exigir(usuarioId);
    const where = { billeteraId: id, tipo: tipo && { in: tipo } };
    const [total, filas] = await Promise.all([
      this.prisma.movimientoBilletera.count({ where }),
      this.prisma.movimientoBilletera.findMany({
        where,
        orderBy: [{ creadoEn: 'desc' }, { id: 'desc' }],
        skip: (pagina - 1) * limite,
        take: limite,
      }),
    ]);
    const items: MovimientoDto[] = filas.map((f) => ({
      id: f.id,
      tipo: f.tipo as TipoMovimiento,
      monto: f.monto.toFixed(2),
      estado: f.estado as EstadoMovimiento,
      hashTx: f.hashTx,
      exploradorUrl: f.hashTx
        ? this.blockchain.cadena.exploradorTxUrl(f.hashTx)
        : null,
      creadoEn: f.creadoEn,
    }));
    return { items, total, pagina, paginas: Math.ceil(total / limite) };
  }

  /**
   * Contable: recarga, liberación y reembolso suman; bloqueo resta. Un bloqueo sigue retenido mientras su reserva no
   * tenga liberación ni reembolso confirmados, en cualquier billetera: la liberación se acredita al conductor.
   */
  async resumen(billeteraId: string): Promise<ResumenLibro> {
    const [fila] = await this.prisma.$queryRaw<
      {
        contable: string;
        bloqueado: string;
        pendientes: number;
        confirmados: number;
      }[]
    >`
      SELECT
        COALESCE(SUM(CASE m.tipo WHEN 'bloqueo_reserva' THEN -m.monto ELSE m.monto END)
          FILTER (WHERE m.estado = 'confirmado'), 0)::text AS contable,
        COALESCE(SUM(m.monto) FILTER (
          WHERE m.estado = 'confirmado' AND m.tipo = 'bloqueo_reserva' AND NOT EXISTS (
            SELECT 1 FROM movimientos_billetera r
            WHERE r.reserva_id = m.reserva_id
              AND r.estado = 'confirmado'
              AND r.tipo IN ('liberacion_viaje', 'reembolso_reserva')
          )
        ), 0)::text AS bloqueado,
        COUNT(*) FILTER (WHERE m.estado = 'pendiente')::int AS pendientes,
        COUNT(*) FILTER (WHERE m.estado = 'confirmado')::int AS confirmados
      FROM movimientos_billetera m
      WHERE m.billetera_id = ${billeteraId}::uuid`;
    return {
      contable: urcAUnidades(fila.contable),
      bloqueado: urcAUnidades(fila.bloqueado),
      pendientes: fila.pendientes,
      confirmados: fila.confirmados,
    };
  }
}
