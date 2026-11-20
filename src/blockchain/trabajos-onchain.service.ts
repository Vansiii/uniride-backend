import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { id } from 'ethers';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { tipoDeError } from '../billetera/billetera.service.js';
import { descifrarLlave } from '../billetera/custodia.js';
import { MovimientosService } from '../billetera/movimientos.service.js';
import { PrismaService } from '../comun/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PushService } from '../notificaciones/push.service.js';
import { EstadoViajeService } from '../viajes/estado-viaje.service.js';
import {
  BlockchainService,
  ErrorBloqueoPermanente,
  urcAUnidades,
} from './blockchain.service.js';

export const PREFIJO_CLAVE_RECARGA = 'recarga:';
const primerNombre = (nombre: string) => nombre.trim().split(' ')[0];
const CADA_MS = 5_000;
const LOTE = 10;
const ALERTA_EN_INTENTO = 5;
const ESPERA_MAXIMA_MIN = 60;

interface Trabajo {
  id: string;
  movimiento_id: string;
  operacion?: string;
  intentos: number;
}

/** Lo que identifica en la auditoría la entidad de un trabajo atascado. */
interface Objetivo {
  accion: string;
  entidad: string;
  entidadId: string;
  organizacionId?: string;
}

type MovimientoDeTrabajo = Prisma.MovimientoBilleteraGetPayload<{
  include: { billetera: { select: { direccion: true; usuarioId: true } } };
}>;

/**
 * Worker de la cola on-chain (D-10). La transacción no queda abierta mientras se espera a la cadena: tomar un trabajo
 * lo reserva 5 min, y si el proceso se corta otro lo retoma. Repetir es seguro porque el contrato no acuña dos veces
 * la misma orden ni bloquea dos veces la misma reserva. Nunca descarta un trabajo: el movimiento sigue `pendiente`
 * hasta que la cadena responda (RN-6, HU-19 RN-7). Despacha por `operacion`: `acunar_recarga`, `bloquear_reserva` o `liberar_reserva` (HU-24).
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
    private readonly estadoViaje: EstadoViajeService,
    private readonly push: PushService,
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
      const movimiento = await this.cargarMovimiento(trabajo.movimiento_id);
      const termino =
        trabajo.operacion === 'bloquear_reserva'
          ? await this.bloquearReserva(trabajo, movimiento)
          : trabajo.operacion === 'liberar_reserva'
            ? await this.liberarReserva(trabajo, movimiento)
            : trabajo.operacion === 'reembolsar_reserva'
              ? await this.reembolsarReserva(trabajo, movimiento)
              : await this.acunarRecarga(trabajo, movimiento);
      if (termino) terminados++;
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
      RETURNING id, movimiento_id, operacion, intentos`;
    return trabajo;
  }

  private cargarMovimiento(movimientoId: string) {
    return this.prisma.movimientoBilletera.findUniqueOrThrow({
      where: { id: movimientoId },
      include: {
        billetera: { select: { direccion: true, usuarioId: true } },
      },
    });
  }

  private async acunarRecarga(
    trabajo: Trabajo,
    movimiento: MovimientoDeTrabajo,
  ): Promise<boolean> {
    const ordenId = movimiento.claveIdempotencia.slice(
      PREFIJO_CLAVE_RECARGA.length,
    );
    const { usuarioId, direccion } = movimiento.billetera;
    const objetivo: Objetivo = {
      accion: 'billetera.recarga.atascada',
      entidad: 'orden_recarga',
      entidadId: ordenId,
    };

    // Con la cadena o con la BD: cualquier falla suma un intento y llega a la alerta. Si ya se acuñó, el reintento no
    // acuña otra vez y solo repite el registro.
    try {
      const hashTx = await this.blockchain.cadena.acunarRecarga(
        direccion,
        urcAUnidades(movimiento.monto.toFixed(2)),
        id(ordenId),
      );
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
    } catch (error) {
      await this.registrarFalla(trabajo, objetivo, usuarioId, error);
      return false;
    }
  }

  /**
   * HU-19: deja el pasaje en el escrow con el permit firmado por la llave custodiada del pasajero, que se descifra
   * aquí, solo para firmar. Éxito: movimiento y reserva `confirmada` y el viaje `reservado`. Falla permanente
   * (sin saldo, datos inválidos): la reserva queda `fallida` y el asiento vuelve a estar libre. Otra falla: reintento.
   */
  private async bloquearReserva(
    trabajo: Trabajo,
    movimiento: MovimientoDeTrabajo,
  ): Promise<boolean> {
    const reservaId = movimiento.reservaId as string;
    const { usuarioId, direccion } = movimiento.billetera;
    const objetivo: Objetivo = {
      accion: 'reserva.bloqueo.atascado',
      entidad: 'reserva',
      entidadId: reservaId,
    };
    try {
      const reserva = await this.prisma.comoSuperAdmin((tx) =>
        tx.reserva.findUniqueOrThrow({
          where: { id: reservaId },
          select: {
            estado: true,
            viajeId: true,
            organizacionId: true,
            pasajero: { select: { nombreCompleto: true } },
            viaje: {
              select: {
                conductorId: true,
                destinoNombre: true,
                conductor: {
                  select: { billetera: { select: { direccion: true } } },
                },
              },
            },
          },
        }),
      );
      // Una reserva que ya no está pendiente no se bloquea (p. ej. otro worker la resolvió).
      if (reserva.estado !== 'pendiente') return await this.terminar(trabajo);
      const conductor = reserva.viaje.conductor.billetera?.direccion;
      if (!conductor) throw new Error('CONDUCTOR_SIN_BILLETERA');

      const cadena = this.blockchain.cadena;
      const idReserva = id(reservaId);
      const monto = urcAUnidades(movimiento.monto.toFixed(2));
      let hashTx: string;
      const previo = await cadena.estadoReservaEscrow(idReserva);
      if (previo.estado !== 'ninguno') {
        // Un intento anterior bloqueó pero perdió la respuesta: se recupera su hash, sin firmar otra vez.
        if (
          previo.pagador.toLowerCase() !== direccion.toLowerCase() ||
          previo.conductor.toLowerCase() !== conductor.toLowerCase() ||
          previo.monto !== monto
        )
          throw new ErrorBloqueoPermanente('ReservaExistente');
        hashTx = await cadena.hashDeBloqueo(idReserva);
      } else {
        const { llaveCustodiaRef } =
          await this.prisma.billetera.findUniqueOrThrow({
            where: { id: movimiento.billeteraId },
            select: { llaveCustodiaRef: true },
          });
        hashTx = await cadena.bloquearReserva({
          idReserva,
          llavePagador: descifrarLlave(llaveCustodiaRef, direccion),
          conductor,
          monto,
        });
      }

      await this.prisma.comoSuperAdmin(async (tx) => {
        await this.movimientos.actualizarEstado(
          movimiento.id,
          'confirmado',
          hashTx,
          tx,
        );
        const { count } = await tx.reserva.updateMany({
          where: { id: reservaId, estado: 'pendiente' },
          data: { estado: 'confirmada' },
        });
        await this.estadoViaje.recalcular(tx, reserva.viajeId);
        // PB-09: solo quien la confirmó avisa, una vez.
        if (count > 0) {
          const destino = reserva.viaje.destinoNombre;
          await this.push.encolar(tx, usuarioId, 'reserva_confirmada', {
            destino,
            monto: movimiento.monto.toFixed(2),
            ruta: `/reserva/${reservaId}`,
          });
          await this.push.encolar(
            tx,
            reserva.viaje.conductorId,
            'nuevo_pasajero',
            {
              destino,
              pasajero: primerNombre(reserva.pasajero.nombreCompleto),
              ruta: `/viajes/${reserva.viajeId}`,
            },
          );
        }
        await tx.trabajoOnchain.update({
          where: { id: trabajo.id },
          data: { estado: 'terminado', ultimoError: null },
        });
        await this.auditoria.registrar(
          {
            accion: 'reserva.confirmada',
            entidad: 'reserva',
            entidadId: reservaId,
            resultado: 'ok',
            actorId: usuarioId,
            organizacionId: reserva.organizacionId,
            detalle: { monto: movimiento.monto.toFixed(2), hashTx },
          },
          tx,
        );
      });
      return true;
    } catch (error) {
      if (error instanceof ErrorBloqueoPermanente) {
        await this.anularReserva(trabajo, movimiento, error.motivo);
        return true;
      }
      await this.registrarFalla(trabajo, objetivo, usuarioId, error);
      return false;
    }
  }

  /** CA-12: el bloqueo es imposible. Nada se descontó: el movimiento falla, la reserva no se completa y el asiento se libera. */
  private async anularReserva(
    trabajo: Trabajo,
    movimiento: MovimientoDeTrabajo,
    motivo: string,
  ): Promise<void> {
    const reservaId = movimiento.reservaId as string;
    await this.prisma.comoSuperAdmin(async (tx) => {
      await this.movimientos.actualizarEstado(
        movimiento.id,
        'fallido',
        undefined,
        tx,
      );
      const { count } = await tx.reserva.updateMany({
        where: { id: reservaId, estado: 'pendiente' },
        data: { estado: 'fallida', motivo },
      });
      const reserva = await tx.reserva.findUniqueOrThrow({
        where: { id: reservaId },
        select: { viajeId: true, organizacionId: true },
      });
      // Solo si esta llamada la anuló: el asiento se devuelve una vez.
      if (count > 0)
        await tx.$executeRaw`
          UPDATE viajes SET cupos_disponibles = cupos_disponibles + 1
          WHERE id = ${reserva.viajeId}::uuid AND cupos_disponibles < cupos_totales`;
      await tx.trabajoOnchain.update({
        where: { id: trabajo.id },
        data: { estado: 'terminado', ultimoError: motivo },
      });
      await this.auditoria.registrar(
        {
          accion: 'reserva.fallida',
          entidad: 'reserva',
          entidadId: reservaId,
          resultado: 'fallo',
          actorId: movimiento.billetera.usuarioId,
          organizacionId: reserva.organizacionId,
          detalle: { motivo },
        },
        tx,
      );
    });
  }

  /**
   * HU-24: paga al conductor desde el escrow con la cuenta verificadora. A-09 en el servidor: solo una reserva
   * `verificada`, y el escrow debe tenerla bloqueada para ese conductor y ese monto. Respuesta perdida o dos workers: el
   * escrow ya dice `liberada` y se recupera el hash, sin enviar otra vez (CA-4). Éxito: movimiento `confirmado`,
   * reserva `pagada`, viaje recalculado (CA-10) y auditoría `pago.liberado` (RN-6). Red caída: reintento (CA-6).
   */
  private async liberarReserva(
    trabajo: Trabajo,
    movimiento: MovimientoDeTrabajo,
  ): Promise<boolean> {
    const reservaId = movimiento.reservaId as string;
    const { usuarioId, direccion } = movimiento.billetera;
    const monto = movimiento.monto.toFixed(2);
    const objetivo: Objetivo = {
      accion: 'pago.liberacion.atascada',
      entidad: 'reserva',
      entidadId: reservaId,
    };
    try {
      const reserva = await this.prisma.comoSuperAdmin((tx) =>
        tx.reserva.findUniqueOrThrow({
          where: { id: reservaId },
          select: {
            estado: true,
            viajeId: true,
            organizacionId: true,
            viaje: { select: { destinoNombre: true } },
          },
        }),
      );
      // La alerta de RN-5 tras 5 intentos la ve la organización del viaje.
      objetivo.organizacionId = reserva.organizacionId;
      const cerrar = (accion: string, detalle: Record<string, unknown>) =>
        this.cerrarSinPago(trabajo, movimiento, reserva.organizacionId, {
          accion,
          detalle,
        });
      // Otro worker ya la cerró: nada que hacer.
      if (reserva.estado === 'pagada') return await this.terminar(trabajo);
      if (reserva.estado !== 'verificada')
        return await cerrar('pago.rechazado', { estado: reserva.estado });

      const cadena = this.blockchain.cadena;
      const idReserva = id(reservaId);
      const escrow = await cadena.estadoReservaEscrow(idReserva);
      const coincide =
        escrow.conductor.toLowerCase() === direccion.toLowerCase() &&
        escrow.monto === urcAUnidades(monto);
      let hashTx: string;
      if (escrow.estado === 'liberada' && coincide)
        hashTx = await cadena.hashDeLiberacion(idReserva);
      else if (escrow.estado === 'bloqueada' && coincide)
        hashTx = await cadena.liberarReserva(
          idReserva,
          (movimiento.metadatos as { hashPrueba: string }).hashPrueba,
        );
      // Reembolsada, nunca bloqueada o para otro conductor: reintentar no lo arregla y pagar sería A-09.
      else
        return await cerrar('pago.liberacion.imposible', {
          estadoEscrow: escrow.estado,
          coincide,
        });

      await this.prisma.comoSuperAdmin(async (tx) => {
        await this.movimientos.actualizarEstado(
          movimiento.id,
          'confirmado',
          hashTx,
          tx,
        );
        const { count } = await tx.reserva.updateMany({
          where: { id: reservaId, estado: 'verificada' },
          data: { estado: 'pagada' },
        });
        await this.estadoViaje.recalcular(tx, reserva.viajeId);
        // PB-09: la billetera del movimiento es la del conductor.
        if (count > 0)
          await this.push.encolar(tx, usuarioId, 'pago_recibido', {
            monto,
            destino: reserva.viaje.destinoNombre,
            ruta: '/movimientos',
          });
        await tx.trabajoOnchain.update({
          where: { id: trabajo.id },
          data: { estado: 'terminado', ultimoError: null },
        });
        await this.auditoria.registrar(
          {
            accion: 'pago.liberado',
            entidad: 'reserva',
            entidadId: reservaId,
            resultado: 'ok',
            actorId: usuarioId,
            organizacionId: reserva.organizacionId,
            detalle: { conductorId: usuarioId, monto, hashTx },
          },
          tx,
        );
      });
      return true;
    } catch (error) {
      await this.registrarFalla(trabajo, objetivo, usuarioId, error);
      return false;
    }
  }

  /**
   * HU-20: procesa la devolución del pasaje desde el escrow con la cuenta verificadora (ROL_VERIFICADOR). Idempotente:
   * si el escrow ya dice `reembolsada` recupera el hash sin enviar otra vez (CA-10). Éxito: movimientos `confirmado`
   * (pasajero y, si aplica 50/50, compensación al conductor) y auditoría `reembolso.confirmado`. Red caída: reintento (CA-17).
   */
  private async reembolsarReserva(
    trabajo: Trabajo,
    movimiento: MovimientoDeTrabajo,
  ): Promise<boolean> {
    const reservaId = movimiento.reservaId as string;
    const { usuarioId, direccion } = movimiento.billetera;
    const metadatos = (movimiento.metadatos ?? {}) as {
      porcentajePasajeroBps?: number;
      montoConductor?: string;
      motivo?: string;
    };
    const porcentajePasajeroBps = metadatos.porcentajePasajeroBps ?? 10_000;
    const objetivo: Objetivo = {
      accion: 'reembolso.atascado',
      entidad: 'reserva',
      entidadId: reservaId,
    };
    try {
      const reserva = await this.prisma.comoSuperAdmin((tx) =>
        tx.reserva.findUniqueOrThrow({
          where: { id: reservaId },
          select: {
            estado: true,
            monto: true,
            viajeId: true,
            organizacionId: true,
          },
        }),
      );
      objetivo.organizacionId = reserva.organizacionId;
      const cerrar = (accion: string, detalle: Record<string, unknown>) =>
        this.cerrarSinPago(trabajo, movimiento, reserva.organizacionId, {
          accion,
          detalle,
        });

      if (movimiento.estado === 'confirmado')
        return await this.terminar(trabajo);
      if (
        reserva.estado !== 'cancelada' &&
        reserva.estado !== 'expirada' &&
        reserva.estado !== 'verificacion_fallida'
      )
        return await cerrar('reembolso.rechazado', { estado: reserva.estado });

      const cadena = this.blockchain.cadena;
      const idReserva = id(reservaId);
      const escrow = await cadena.estadoReservaEscrow(idReserva);
      const coincide =
        escrow.pagador.toLowerCase() === direccion.toLowerCase() &&
        escrow.monto === urcAUnidades(reserva.monto.toFixed(2));

      let hashTx: string;
      if (escrow.estado === 'reembolsada' && coincide)
        hashTx = await cadena.hashDeReembolso(idReserva);
      else if (escrow.estado === 'bloqueada' && coincide)
        hashTx = await cadena.reembolsarReserva(
          idReserva,
          porcentajePasajeroBps,
        );
      else
        return await cerrar('reembolso.imposible', {
          estadoEscrow: escrow.estado,
          coincide,
        });

      await this.prisma.comoSuperAdmin(async (tx) => {
        await this.movimientos.actualizarEstado(
          movimiento.id,
          'confirmado',
          hashTx,
          tx,
        );
        const compensacion = await tx.movimientoBilletera.findFirst({
          where: {
            reservaId,
            tipo: 'compensacion_cancelacion',
            estado: 'pendiente',
          },
        });
        if (compensacion) {
          await this.movimientos.actualizarEstado(
            compensacion.id,
            'confirmado',
            hashTx,
            tx,
          );
        }
        await tx.trabajoOnchain.update({
          where: { id: trabajo.id },
          data: { estado: 'terminado', ultimoError: null },
        });
        await this.auditoria.registrar(
          {
            accion: 'reembolso.confirmado',
            entidad: 'reserva',
            entidadId: reservaId,
            resultado: 'ok',
            actorId: usuarioId,
            organizacionId: reserva.organizacionId,
            detalle: {
              pasajeroId: usuarioId,
              monto: movimiento.monto.toFixed(2),
              porcentajePasajeroBps,
              hashTx,
            },
          },
          tx,
        );
      });
      return true;
    } catch (error) {
      await this.registrarFalla(trabajo, objetivo, usuarioId, error);
      return false;
    }
  }

  private async terminar(trabajo: Trabajo): Promise<true> {
    await this.prisma.trabajoOnchain.update({
      where: { id: trabajo.id },
      data: { estado: 'terminado', ultimoError: null },
    });
    return true;
  }

  /** Liberación o reembolso que no debe hacerse: el movimiento falla sin hash, el trabajo termina y queda la alerta. */
  private async cerrarSinPago(
    trabajo: Trabajo,
    movimiento: MovimientoDeTrabajo,
    organizacionId: string,
    alerta: { accion: string; detalle: Record<string, unknown> },
  ): Promise<true> {
    await this.prisma.comoSuperAdmin(async (tx) => {
      await this.movimientos.actualizarEstado(
        movimiento.id,
        'fallido',
        undefined,
        tx,
      );
      if (trabajo.operacion === 'reembolsar_reserva' && movimiento.reservaId) {
        const compensacion = await tx.movimientoBilletera?.findFirst({
          where: {
            reservaId: movimiento.reservaId,
            tipo: 'compensacion_cancelacion',
            estado: 'pendiente',
          },
        });
        if (compensacion) {
          await this.movimientos.actualizarEstado(
            compensacion.id,
            'fallido',
            undefined,
            tx,
          );
        }
      }
      await tx.trabajoOnchain.update({
        where: { id: trabajo.id },
        data: { estado: 'terminado', ultimoError: alerta.accion },
      });
      await this.auditoria.registrar(
        {
          accion: alerta.accion,
          entidad: 'reserva',
          entidadId: movimiento.reservaId as string,
          resultado: 'fallo',
          actorId: movimiento.billetera.usuarioId,
          organizacionId,
          detalle: alerta.detalle,
        },
        tx,
      );
    });
    return true;
  }

  /** Espera creciente hasta 1 h. Solo el tipo de error: el mensaje de ethers lleva la URL del nodo. */
  private async registrarFalla(
    trabajo: Trabajo,
    objetivo: Objetivo,
    usuarioId: string,
    error: unknown,
  ): Promise<void> {
    const intentos = trabajo.intentos + 1;
    const motivo = tipoDeError(error);
    this.registro.warn(
      `${objetivo.entidad} ${objetivo.entidadId}, intento ${intentos} (${motivo})`,
    );
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
            accion: objetivo.accion,
            entidad: objetivo.entidad,
            entidadId: objetivo.entidadId,
            resultado: 'fallo',
            actorId: usuarioId,
            organizacionId: objetivo.organizacionId,
            detalle: { intentos, motivo },
          },
          tx,
        );
    });
  }
}
