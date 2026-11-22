import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService, type Transaccion } from '../comun/prisma.service.js';
import { INTENTOS_MAXIMOS } from './analisis-riesgo.js';
import { UMBRAL_ALERTA, type Factor } from './cifras-par.js';
import {
  ORIGENES,
  type AlertaDto,
  type AlertasRespuestaDto,
  type AnalisisIaDto,
  type BloqueoVigenteDto,
  type DecidirAlertaDto,
  type Decision,
  type DesempenoDto,
  type FiltroAlertasDto,
  type Origen,
  type PersonaAlertaDto,
} from './dto/alertas.dto.js';
import { ModeloRiesgoService } from './modelo-riesgo.service.js';

/** PB-11: de dónde sale la alerta. */
export const origenDe = (patron: string): Origen =>
  patron === 'comportamiento_atipico'
    ? 'modelo'
    : patron === 'anillo_colusion'
      ? 'anillo'
      : 'reglas';

interface FilaAuditoria {
  id: string;
  creado_en: Date;
  detalle: {
    patron: string;
    personas: string[];
    reservaId?: string;
    cantidad?: number;
    distanciaM?: number;
    minutos?: number;
    bloqueoHasta?: string;
    tipo?: string;
    hasta?: string;
    /** PB-11. */
    factores?: Factor[];
    puntaje?: number;
    viajesInternos?: number;
    proporcion?: number;
    aristas?: { a: string; b: string; viajes: number }[];
  };
  /** PB-10: primer análisis válido y cantidad de intentos fallidos. */
  analisis?:
    | (Omit<AnalisisIaDto, 'analizadoEn' | 'origenPuntaje'> & {
        analizado_en: string;
        origenPuntaje?: 'modelo' | 'estimado';
        factores?: Factor[];
      })
    | null;
  fallos?: number;
  /** PB-11: última decisión del administrador. */
  decision?: {
    decision: Decision;
    nota?: string;
    autor: string | null;
    en: string;
  } | null;
}

/**
 * HU-26: solo lectura de lo que HU-25 dejó en la auditoría. Todo corre dentro de `enOrganizacion`, así que RLS deja ver
 * solo la organización activa (A-13); el filtro explícito es una segunda barrera. No hay ninguna acción que escriba o
 * levante un bloqueo (CA-8). Las alertas no traen coordenadas (HU-25 RN-10), y de las personas solo sale el nombre.
 * PB-11: la única escritura es la decisión del administrador, que va a la auditoría y no toca bloqueos (CA-12).
 */
@Injectable()
export class AlertasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly modeloRiesgo: ModeloRiesgoService,
  ) {}

  async listar(
    organizacionId: string,
    actorId: string,
    filtro: FiltroAlertasDto,
  ): Promise<AlertasRespuestaDto> {
    const limite = filtro.limite;
    const respuesta = await this.prisma.enOrganizacion(
      organizacionId,
      async (tx) => {
        const antes = filtro.antes ? new Date(filtro.antes) : null;
        const patron = filtro.patron ?? null;
        const filas = await tx.$queryRaw<FilaAuditoria[]>`
        SELECT a.id, a.creado_en, a.detalle,
          (SELECT x.detalle || jsonb_build_object('analizado_en', x.creado_en) FROM registros_auditoria x
            WHERE x.accion = 'fraude.analisis_ia' AND x.entidad_id = a.id::text AND x.resultado = 'ok'
            ORDER BY x.creado_en LIMIT 1) AS analisis,
          (SELECT count(*)::int FROM registros_auditoria x
            WHERE x.accion = 'fraude.analisis_ia' AND x.entidad_id = a.id::text AND x.resultado = 'fallo') AS fallos,
          (SELECT x.detalle || jsonb_build_object('autor', u.nombre_completo, 'en', x.creado_en)
            FROM registros_auditoria x LEFT JOIN usuarios u ON u.id = x.actor_id
            WHERE x.accion = 'fraude.decision' AND x.entidad_id = a.id::text
            ORDER BY x.creado_en DESC, x.id DESC LIMIT 1) AS decision
        FROM registros_auditoria a
        WHERE a.organizacion_id = ${organizacionId}::uuid AND a.accion = 'fraude.alerta'
          AND (${patron}::text IS NULL OR a.detalle->>'patron' = ${patron}::text)
          AND (${antes}::timestamptz IS NULL OR a.creado_en < ${antes}::timestamptz)
        ORDER BY a.creado_en DESC, a.id DESC
        LIMIT ${limite + 1}`;
        const hayMas = filas.length > limite;
        const pagina = filas.slice(0, limite);
        const nombres = await this.personas(tx, pagina);
        const alertas: AlertaDto[] = pagina.map((f) => {
          const personas = nombres(f);
          return {
            id: f.id,
            creadoEn: f.creado_en,
            patron: f.detalle.patron,
            origen: origenDe(f.detalle.patron),
            personas,
            factores: f.analisis?.factores ?? f.detalle.factores,
            puntajeModelo: f.detalle.puntaje,
            grafo: grafoDe(f, personas),
            decision: f.decision
              ? {
                  valor: f.decision.decision,
                  nota: f.decision.nota,
                  autor: f.decision.autor ?? 'Persona sin nombre',
                  en: new Date(f.decision.en),
                }
              : undefined,
            cantidad: f.detalle.cantidad,
            distanciaM: f.detalle.distanciaM,
            minutos: f.detalle.minutos,
            bloqueoHasta: f.detalle.bloqueoHasta
              ? new Date(f.detalle.bloqueoHasta)
              : undefined,
            ...analisisDe(f),
          };
        });
        return {
          alertas,
          siguiente: hayMas
            ? pagina[pagina.length - 1].creado_en.toISOString()
            : undefined,
        };
      },
    );
    await this.registrarConsulta(organizacionId, actorId, 'alertas');
    return respuesta;
  }

  /** Bloqueos que siguen vigentes; si un mismo bloqueo se extendió (HU-25 CA-9) rige el de fin mayor. */
  async bloqueosVigentes(
    organizacionId: string,
    actorId: string,
  ): Promise<BloqueoVigenteDto[]> {
    const bloqueos = await this.prisma.enOrganizacion(
      organizacionId,
      async (tx) => {
        const filas = await tx.$queryRaw<FilaAuditoria[]>`
        SELECT id, creado_en, detalle FROM registros_auditoria
        WHERE organizacion_id = ${organizacionId}::uuid AND accion = 'fraude.bloqueo'
          AND (detalle->>'hasta')::timestamptz > now()
        ORDER BY creado_en DESC, id DESC`;
        const nombres = await this.personas(tx, filas);
        const porClave = new Map<string, BloqueoVigenteDto>();
        for (const f of filas) {
          const hasta = new Date(f.detalle.hasta as string);
          const clave = `${f.detalle.tipo}:${[...f.detalle.personas].sort().join(',')}`;
          const previo = porClave.get(clave);
          if (!previo || previo.hasta < hasta)
            porClave.set(clave, {
              tipo: f.detalle.tipo as string,
              patron: f.detalle.patron,
              personas: nombres(f),
              hasta,
            });
        }
        return [...porClave.values()].sort(
          (a, b) => a.hasta.getTime() - b.hasta.getTime(),
        );
      },
    );
    await this.registrarConsulta(organizacionId, actorId, 'bloqueos');
    return bloqueos;
  }

  /**
   * PB-11 RN-8: registra la decisión del administrador. Solo escribe en la auditoría: nunca crea, levanta ni acorta un
   * bloqueo (CA-12). Una alerta de otra organización responde 404, igual que una inexistente (CA-13).
   */
  async decidir(
    organizacionId: string,
    actorId: string,
    alertaId: string,
    dto: DecidirAlertaDto,
  ): Promise<void> {
    await this.prisma.enOrganizacion(organizacionId, async (tx) => {
      const [alerta] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM registros_auditoria
        WHERE id = ${alertaId}::uuid AND accion = 'fraude.alerta'
          AND organizacion_id = ${organizacionId}::uuid`;
      if (!alerta)
        throw new ErrorNegocio(
          404,
          'ALERTA_NO_ENCONTRADA',
          'comun.errores.no_encontrado',
        );
      const nota = dto.nota?.trim();
      await this.auditoria.registrar(
        {
          accion: 'fraude.decision',
          entidad: 'registro_auditoria',
          entidadId: alertaId,
          resultado: 'ok',
          actorId,
          organizacionId,
          detalle: { decision: dto.decision, ...(nota && { nota }) },
        },
        tx,
      );
    });
  }

  /** PB-11 CA-10: estado del modelo, precisión por origen con las decisiones y validación simulada (CA-11). */
  async desempeno(
    organizacionId: string,
    actorId: string,
  ): Promise<DesempenoDto> {
    const respuesta = await this.prisma.enOrganizacion(
      organizacionId,
      async (tx) => {
        const estado = await this.modeloRiesgo.estado(tx, organizacionId);
        const filas = await tx.$queryRaw<
          {
            patron: string;
            decision: Decision | null;
            n: number;
          }[]
        >`
          SELECT o.patron, o.decision, count(*)::int AS n
          FROM (
            SELECT a.detalle->>'patron' AS patron,
              (SELECT d.detalle->>'decision' FROM registros_auditoria d
                WHERE d.accion = 'fraude.decision' AND d.entidad_id = a.id::text
                ORDER BY d.creado_en DESC, d.id DESC LIMIT 1) AS decision
            FROM registros_auditoria a
            WHERE a.accion = 'fraude.alerta' AND a.organizacion_id = ${organizacionId}::uuid
          ) o
          GROUP BY o.patron, o.decision`;
        const porOrigen = ORIGENES.map((origen) => {
          const propias = filas.filter((f) => origenDe(f.patron) === origen);
          const suma = (d: Decision | 'todas') =>
            propias
              .filter((f) => d === 'todas' || f.decision === d)
              .reduce((s, f) => s + f.n, 0);
          const confirmadas = suma('confirmado');
          const falsosPositivos = suma('falso_positivo');
          const decididas = confirmadas + falsosPositivos;
          return {
            origen,
            alertas: suma('todas'),
            confirmadas,
            falsosPositivos,
            precision: decididas
              ? Math.round((confirmadas / decididas) * 1000) / 1000
              : null,
          };
        });
        const ok = estado.ok;
        const sinDatos =
          estado.sinDatos && (!ok || estado.sinDatos.creado_en > ok.creado_en)
            ? { pares: estado.sinDatos.pares, minimo: estado.sinDatos.minimo }
            : null;
        return {
          modelo: ok
            ? {
                version: ok.version,
                entrenadoEn: ok.creado_en,
                pares: ok.pares,
                histograma: ok.histograma,
                umbral: UMBRAL_ALERTA,
              }
            : null,
          sinDatos,
          porOrigen,
        };
      },
    );
    await this.registrarConsulta(organizacionId, actorId, 'desempeno');
    const v = this.modeloRiesgo.validacion();
    return {
      ...respuesta,
      validacion: {
        auc: v.auc,
        deteccion: v.deteccion,
        falsasAlarmas: v.falsasAlarmas,
        deteccionUmbral: v.deteccionUmbral,
        falsasAlarmasUmbral: v.falsasAlarmasUmbral,
        roc: v.roc,
        escenarios: v.escenarios,
      },
    };
  }

  /**
   * Nombre y rol (RN-4): conductor si es el del viaje de la reserva que originó la alerta, si no pasajero. Las alertas
   * del modelo y de anillos (PB-11) no salen de una reserva: sus personas son «miembro».
   */
  private async personas(tx: Transaccion, filas: FilaAuditoria[]) {
    const ids = [...new Set(filas.flatMap((f) => f.detalle.personas))];
    const reservas = [
      ...new Set(filas.flatMap((f) => f.detalle.reservaId ?? [])),
    ];
    const usuarios = ids.length
      ? await tx.usuario.findMany({
          where: { id: { in: ids } },
          select: { id: true, nombreCompleto: true },
        })
      : [];
    const conductores = reservas.length
      ? await tx.$queryRaw<{ id: string; conductor_id: string }[]>`
          SELECT r.id, v.conductor_id FROM reservas r JOIN viajes v ON v.id = r.viaje_id
          WHERE r.id = ANY(${reservas}::uuid[])`
      : [];
    const nombre = new Map(usuarios.map((u) => [u.id, u.nombreCompleto]));
    const conductor = new Map(conductores.map((c) => [c.id, c.conductor_id]));
    return (f: FilaAuditoria): PersonaAlertaDto[] =>
      f.detalle.personas.map((id) => ({
        nombre: nombre.get(id) ?? 'Persona sin nombre',
        rol: !f.detalle.reservaId
          ? 'miembro'
          : conductor.get(f.detalle.reservaId) === id
            ? 'conductor'
            : 'pasajero',
      }));
  }

  /** CA-10. */
  private registrarConsulta(
    organizacionId: string,
    actorId: string,
    que: 'alertas' | 'bloqueos' | 'desempeno',
  ) {
    return this.auditoria.registrar({
      accion:
        que === 'desempeno'
          ? 'fraude.desempeno.consultado'
          : `fraude.${que}.consultadas`,
      entidad: 'organizacion',
      entidadId: organizacionId,
      resultado: 'ok',
      actorId,
      organizacionId,
    });
  }
}

/** PB-10: estado y, si existe, el análisis de IA de la alerta (solo los campos validados). */
function analisisDe(
  f: FilaAuditoria,
): Pick<AlertaDto, 'estadoAnalisis' | 'analisis'> {
  const a = f.analisis;
  if (a)
    return {
      estadoAnalisis: 'listo',
      analisis: {
        riesgo: a.riesgo,
        puntaje: a.puntaje,
        motivos: a.motivos,
        recomendacion: a.recomendacion,
        proveedor: a.proveedor,
        origenPuntaje: a.origenPuntaje ?? 'estimado',
        analizadoEn: new Date(a.analizado_en),
      },
    };
  return {
    estadoAnalisis:
      (f.fallos ?? 0) >= INTENTOS_MAXIMOS ? 'sin_analisis' : 'pendiente',
  };
}

/** PB-11 CA-7: el grupo del anillo con nombres e índices; nunca ids. */
function grafoDe(
  f: FilaAuditoria,
  personas: PersonaAlertaDto[],
): AlertaDto['grafo'] {
  const d = f.detalle;
  if (d.patron !== 'anillo_colusion' || !d.aristas) return undefined;
  const indice = new Map(d.personas.map((id, i) => [id, i]));
  return {
    nodos: personas.map((p) => p.nombre),
    aristas: d.aristas.flatMap((x) =>
      indice.has(x.a) && indice.has(x.b)
        ? [{ a: indice.get(x.a)!, b: indice.get(x.b)!, viajes: x.viajes }]
        : [],
    ),
    viajesInternos: d.viajesInternos ?? 0,
    proporcion: d.proporcion ?? 0,
  };
}
