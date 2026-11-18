import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { PrismaService, type Transaccion } from '../comun/prisma.service.js';
import { distanciaM } from '../presencia/geo.js';
import {
  BLOQUEO_CUENTA_MS,
  BLOQUEO_PAR_MS,
  DIA_MS,
  SIN_DESPLAZAMIENTO_PARA_BLOQUEO,
  VENTANA_FALLIDAS_MS,
  VENTANA_SIN_DESPLAZAMIENTO_MS,
  ordenarPar,
  p1ViajesRepetidos,
  p2SinDesplazamiento,
  p3VerificacionesFallidas,
} from './patrones.js';

type Patron =
  'viajes_repetidos' | 'sin_desplazamiento' | 'verificaciones_fallidas';

const LOTE = 20;

interface ReservaEvaluada {
  id: string;
  estado: string;
  organizacion_id: string;
  pasajero_id: string;
  conductor_id: string;
  salida: Date;
}

interface Involucrada {
  id: string;
  organizacion_id: string;
}

export interface ResumenAnomalias {
  evaluadas: number;
  fallidas: number;
}

/**
 * HU-25 RN-1: evalúa las reservas `pagada` (P-1, P-2) y `verificacion_fallida` (P-3) en segundo plano. Nunca toca el
 * pago ni el estado del viaje: solo escribe alertas (auditoría) y bloqueos. Si falla, la transacción se revierte y el
 * siguiente tic reintenta (CA-11).
 */
@Injectable()
export class AnomaliasService implements OnModuleInit, OnModuleDestroy {
  private readonly registro = new Logger(AnomaliasService.name);
  private temporizador?: NodeJS.Timeout;
  private ocupado = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    const ms = Number(process.env.ANOMALIAS_INTERVALO_MS) || 30_000;
    this.temporizador = setInterval(() => void this.tic(), ms);
  }

  onModuleDestroy(): void {
    if (this.temporizador) clearInterval(this.temporizador);
  }

  private async tic(): Promise<void> {
    if (this.ocupado) return;
    this.ocupado = true;
    try {
      await this.evaluarPendientes();
    } catch (error) {
      this.registro.error('Error en el tic de anomalías', error);
    } finally {
      this.ocupado = false;
    }
  }

  /** Se invoca a mano en las pruebas con una fecha arbitraria. */
  async evaluarPendientes(ahora: Date = new Date()): Promise<ResumenAnomalias> {
    const resumen: ResumenAnomalias = { evaluadas: 0, fallidas: 0 };
    const pendientes = await this.prisma.comoSuperAdmin(
      (tx) =>
        tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM reservas
        WHERE estado IN ('pagada', 'verificacion_fallida') AND anomalias_evaluadas_en IS NULL
        ORDER BY actualizado_en LIMIT ${LOTE}`,
    );
    for (const { id } of pendientes) {
      try {
        const hecha = await this.prisma.comoSuperAdmin((tx) =>
          this.evaluarReserva(tx, id, ahora),
        );
        if (hecha) resumen.evaluadas++;
      } catch (error) {
        resumen.fallidas++;
        this.registro.error(`Anomalías: no se evaluó la reserva ${id}`);
        // CA-11: la falla queda en auditoría; la reserva sigue sin marcar y se reintenta.
        await this.auditoria
          .registrar({
            accion: 'fraude.evaluacion',
            entidad: 'reserva',
            entidadId: id,
            resultado: 'fallo',
            detalle: { motivo: (error as Error).name },
          })
          .catch(() => undefined);
      }
    }
    return resumen;
  }

  private async evaluarReserva(
    tx: Transaccion,
    id: string,
    ahora: Date,
  ): Promise<boolean> {
    // SKIP LOCKED: dos procesos a la vez no evalúan la misma reserva (CA-10).
    const [r] = await tx.$queryRaw<ReservaEvaluada[]>`
      SELECT r.id, r.estado, r.organizacion_id, r.pasajero_id, v.conductor_id, v.fecha_hora_salida AS salida
      FROM reservas r JOIN viajes v ON v.id = r.viaje_id
      WHERE r.id = ${id}::uuid AND r.anomalias_evaluadas_en IS NULL
        AND r.estado IN ('pagada', 'verificacion_fallida')
      FOR UPDATE OF r SKIP LOCKED`;
    if (!r) return false;

    if (r.estado === 'pagada') {
      await this.p1(tx, r, ahora);
      await this.p2(tx, r, ahora);
    } else {
      for (const persona of [r.pasajero_id, r.conductor_id])
        await this.p3(tx, r, persona, ahora);
    }
    // UPDATE crudo: la API solo puede cambiar esta columna y no debe tocar `actualizado_en`.
    await tx.$executeRaw`UPDATE reservas SET anomalias_evaluadas_en = ${ahora} WHERE id = ${id}::uuid`;
    return true;
  }

  // Solo cuentan la reserva evaluada y las que el tic ya evaluó: el patrón salta al llegar la tercera, no con cada una.
  private async p1(tx: Transaccion, r: ReservaEvaluada, ahora: Date) {
    const delPar = await tx.$queryRaw<(Involucrada & { salida: Date })[]>`
      SELECT r2.id, r2.organizacion_id, v.fecha_hora_salida AS salida
      FROM reservas r2 JOIN viajes v ON v.id = r2.viaje_id
      WHERE r2.estado = 'pagada' AND v.conductor_id = ${r.conductor_id}::uuid AND r2.pasajero_id = ${r.pasajero_id}::uuid
        AND v.fecha_hora_salida > ${new Date(r.salida.getTime() - DIA_MS)}
        AND v.fecha_hora_salida < ${new Date(r.salida.getTime() + DIA_MS)}
        AND (r2.id = ${r.id}::uuid OR r2.anomalias_evaluadas_en IS NOT NULL)`;
    if (
      !p1ViajesRepetidos(
        delPar.map((f) => f.salida),
        r.salida,
      )
    )
      return;
    await this.alertarYBloquear(tx, r, ahora, {
      patron: 'viajes_repetidos',
      involucradas: delPar,
      tipo: 'par',
      cantidad: delPar.length,
    });
  }

  private async p2(tx: Transaccion, r: ReservaEvaluada, ahora: Date) {
    const pruebas = await tx.$queryRaw<
      { tipo: string; lat: number; lng: number; en: Date }[]
    >`
      SELECT tipo, pasajero_lat AS lat, pasajero_lng AS lng, creado_en AS en FROM pruebas_presencia
      WHERE reserva_id = ${r.id}::uuid AND resultado = 'aceptada' AND pasajero_lat IS NOT NULL AND pasajero_lng IS NOT NULL`;
    const abordaje = pruebas.find((p) => p.tipo === 'abordaje');
    const bajada = pruebas.find((p) => p.tipo === 'bajada');
    if (!abordaje || !bajada) return; // sin posición, P-2 no se evalúa
    const cifras = p2SinDesplazamiento(
      distanciaM(abordaje, bajada),
      bajada.en.getTime() - abordaje.en.getTime(),
    );
    if (!cifras) return;
    const par = JSON.stringify(ordenarPar(r.conductor_id, r.pasajero_id));
    // RN-3: la segunda del mismo par en 7 días bloquea; se cuentan las alertas anteriores.
    const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM registros_auditoria
      WHERE accion = 'fraude.alerta' AND detalle->>'patron' = 'sin_desplazamiento'
        AND detalle->'personas' = ${par}::jsonb
        AND detalle->>'reservaId' <> ${r.id}
        AND creado_en > ${new Date(ahora.getTime() - VENTANA_SIN_DESPLAZAMIENTO_MS)}`;
    await this.alertarYBloquear(tx, r, ahora, {
      patron: 'sin_desplazamiento',
      involucradas: [r],
      tipo: n + 1 >= SIN_DESPLAZAMIENTO_PARA_BLOQUEO ? 'par' : null,
      ...cifras,
    });
  }

  private async p3(
    tx: Transaccion,
    r: ReservaEvaluada,
    persona: string,
    ahora: Date,
  ) {
    const fallidas = await tx.$queryRaw<(Involucrada & { en: Date })[]>`
      SELECT r2.id, r2.organizacion_id, p.creado_en AS en
      FROM reservas r2 JOIN viajes v ON v.id = r2.viaje_id
      JOIN pruebas_presencia p ON p.reserva_id = r2.id AND p.tipo = 'bajada' AND p.resultado = 'aceptada'
      WHERE r2.estado = 'verificacion_fallida' AND (r2.pasajero_id = ${persona}::uuid OR v.conductor_id = ${persona}::uuid)
        AND p.creado_en > ${new Date(ahora.getTime() - VENTANA_FALLIDAS_MS)}
        AND (r2.id = ${r.id}::uuid OR r2.anomalias_evaluadas_en IS NOT NULL)`;
    const cantidad = p3VerificacionesFallidas(
      fallidas.map((f) => f.en),
      ahora,
    );
    if (!cantidad) return;
    await this.alertarYBloquear(tx, r, ahora, {
      patron: 'verificaciones_fallidas',
      involucradas: fallidas,
      tipo: 'cuenta',
      cantidad,
      persona,
    });
  }

  /**
   * CA-13/CA-14: una alerta por organización de las reservas involucradas, con cifras y sin coordenadas.
   * CA-9: extender es insertar otro bloqueo; rige el de fin mayor.
   */
  private async alertarYBloquear(
    tx: Transaccion,
    r: ReservaEvaluada,
    ahora: Date,
    a: {
      patron: Patron;
      involucradas: Involucrada[];
      tipo: 'par' | 'cuenta' | null;
      cantidad?: number;
      distanciaM?: number;
      minutos?: number;
      persona?: string;
    },
  ) {
    const personas = a.persona
      ? [a.persona]
      : ordenarPar(r.conductor_id, r.pasajero_id);
    const vence = a.tipo
      ? new Date(
          ahora.getTime() +
            (a.tipo === 'par' ? BLOQUEO_PAR_MS : BLOQUEO_CUENTA_MS),
        )
      : null;
    if (a.tipo === 'par') {
      const [u, p] = ordenarPar(r.conductor_id, r.pasajero_id);
      await tx.$executeRaw`
        INSERT INTO bloqueos_preventivos (tipo, usuario_id, usuario_par_id, patron, reserva_id, vence_en)
        VALUES ('par', ${u}::uuid, ${p}::uuid, ${a.patron}, ${r.id}::uuid, ${vence})
        ON CONFLICT DO NOTHING`;
    } else if (a.tipo === 'cuenta') {
      await tx.$executeRaw`
        INSERT INTO bloqueos_preventivos (tipo, usuario_id, patron, reserva_id, vence_en)
        VALUES ('cuenta', ${a.persona}::uuid, ${a.patron}, ${r.id}::uuid, ${vence})
        ON CONFLICT DO NOTHING`;
    }
    const organizaciones = [
      ...new Set(a.involucradas.map((i) => i.organizacion_id)),
    ];
    for (const organizacionId of organizaciones) {
      const base = {
        patron: a.patron,
        personas,
        reservaId: r.id,
        reservas: a.involucradas
          .filter((i) => i.organizacion_id === organizacionId)
          .map((i) => i.id),
        cantidad: a.cantidad,
        distanciaM: a.distanciaM,
        minutos: a.minutos,
      };
      await this.auditoria.registrar(
        {
          accion: 'fraude.alerta',
          entidad: 'reserva',
          entidadId: r.id,
          resultado: 'ok',
          organizacionId,
          detalle: { ...base, bloqueoHasta: vence?.toISOString() },
        },
        tx,
      );
      if (vence)
        await this.auditoria.registrar(
          {
            accion: 'fraude.bloqueo',
            entidad: 'reserva',
            entidadId: r.id,
            resultado: 'ok',
            organizacionId,
            detalle: {
              ...base,
              tipo: a.tipo,
              desde: ahora.toISOString(),
              hasta: vence.toISOString(),
            },
          },
          tx,
        );
    }
  }
}
