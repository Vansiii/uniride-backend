import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { id } from 'ethers';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { tipoDeError } from '../billetera/billetera.service.js';
import { MovimientosService } from '../billetera/movimientos.service.js';
import { PrismaService } from '../comun/prisma.service.js';
import { BlockchainService, urcAUnidades } from './blockchain.service.js';

export const PREFIJO_CLAVE_RECARGA = 'recarga:';
const CADA_MS = 5_000;
const LOTE = 10;
const ALERTA_EN_INTENTO = 5;
const ESPERA_MAXIMA_MIN = 60;

interface Trabajo {
  id: string;
  movimiento_id: string;
  intentos: number;
}

/**
 * Worker de la cola on-chain (D-10). La transacción no queda abierta mientras se espera a la cadena: tomar un trabajo
 * lo reserva 5 min, y si el proceso se corta otro lo retoma. Repetir es seguro porque el contrato no acuña dos veces
 * la misma orden. Nunca descarta un trabajo: el movimiento sigue `pendiente` hasta que la cadena responda (RN-6).
 */
@Injectable()
export class TrabajosOnchainService implements OnModuleInit, OnModuleDestroy {
  private readonly registro = new Logger(TrabajosOnchainService.name);
  private temporizador?: NodeJS.Timeout;
  private ocupado = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly blockchain: BlockchainService,
    private readonly movimientos: MovimientosService,
    private readonly auditoria: AuditoriaService,
  ) {}

  onModuleInit(): void {
    // En pruebas se llama a `procesarPendientes()` a mano.
    if (process.env.NODE_ENV === 'test') return;
    this.temporizador = setInterval(() => void this.tic(), CADA_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.temporizador);
  }

  private async tic(): Promise<void> {
    if (this.ocupado) return;
    this.ocupado = true;
    try {
      await this.procesarPendientes();
    } catch (error) {
      this.registro.error(`Cola on-chain detenida (${tipoDeError(error)})`);
    } finally {
      this.ocupado = false;
    }
  }

  /** Procesa los trabajos vencidos de a uno, para no pisar el nonce del relayer; devuelve cuántos terminaron. */
  async procesarPendientes(): Promise<number> {
    let terminados = 0;
    for (let i = 0; i < LOTE; i++) {
      const trabajo = await this.tomar();
      if (!trabajo) break;
      if (await this.ejecutar(trabajo)) terminados++;
    }
    return terminados;
  }

  /** SKIP LOCKED: dos workers no toman el mismo trabajo. */
  private async tomar(): Promise<Trabajo | undefined> {
    const [trabajo] = await this.prisma.$queryRaw<Trabajo[]>`
      UPDATE trabajos_onchain SET proximo_intento_en = now() + interval '5 minutes'
      WHERE id = (
        SELECT id FROM trabajos_onchain
        WHERE estado = 'pendiente' AND proximo_intento_en <= now()
        ORDER BY proximo_intento_en LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      RETURNING id, movimiento_id, intentos`;
    return trabajo;
  }

  private async ejecutar(trabajo: Trabajo): Promise<boolean> {
    const movimiento = await this.prisma.movimientoBilletera.findUniqueOrThrow({
      where: { id: trabajo.movimiento_id },
      include: {
        billetera: { select: { direccion: true, usuarioId: true } },
      },
    });
    const ordenId = movimiento.claveIdempotencia.slice(
      PREFIJO_CLAVE_RECARGA.length,
    );
    const { usuarioId, direccion } = movimiento.billetera;

    let hashTx: string;
    try {
      hashTx = await this.blockchain.cadena.acunarRecarga(
        direccion,
        urcAUnidades(movimiento.monto.toFixed(2)),
        id(ordenId),
      );
    } catch (error) {
      await this.registrarFalla(trabajo, ordenId, usuarioId, error);
      return false;
    }

    await this.prisma.$transaction(async (tx) => {
      await this.movimientos.actualizarEstado(
        movimiento.id,
        'confirmado',
        hashTx,
        tx,
      );
      await tx.ordenRecarga.update({
        where: { id: ordenId },
        data: { estado: 'completada', hashTx, completadaEn: new Date() },
      });
      await tx.trabajoOnchain.update({
        where: { id: trabajo.id },
        data: { estado: 'terminado', ultimoError: null },
      });
      await this.auditoria.registrar(
        {
          accion: 'billetera.recarga.acreditada',
          entidad: 'orden_recarga',
          entidadId: ordenId,
          resultado: 'ok',
          actorId: usuarioId,
          detalle: { monto: movimiento.monto.toFixed(2), hashTx },
        },
        tx,
      );
    });
    return true;
  }

  /** Espera creciente hasta 1 h. Solo el tipo de error: el mensaje de ethers lleva la URL del nodo. */
  private async registrarFalla(
    trabajo: Trabajo,
    ordenId: string,
    usuarioId: string,
    error: unknown,
  ): Promise<void> {
    const intentos = trabajo.intentos + 1;
    const motivo = tipoDeError(error);
    this.registro.warn(`Recarga ${ordenId}, intento ${intentos} (${motivo})`);
    const minutos = Math.min(2 ** intentos, ESPERA_MAXIMA_MIN);
    await this.prisma.$transaction(async (tx) => {
      await tx.trabajoOnchain.update({
        where: { id: trabajo.id },
        data: {
          intentos,
          ultimoError: motivo,
          proximoIntentoEn: new Date(Date.now() + minutos * 60_000),
        },
      });
      // Se alerta una sola vez; se sigue reintentando (RN-6).
      if (intentos === ALERTA_EN_INTENTO)
        await this.auditoria.registrar(
          {
            accion: 'billetera.recarga.atascada',
            entidad: 'orden_recarga',
            entidadId: ordenId,
            resultado: 'fallo',
            actorId: usuarioId,
            detalle: { intentos, motivo },
          },
          tx,
        );
    });
  }
}
