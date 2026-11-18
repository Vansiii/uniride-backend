import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { PrismaService, type Transaccion } from '../comun/prisma.service.js';
import type {
  AlertaDto,
  AlertasRespuestaDto,
  BloqueoVigenteDto,
  FiltroAlertasDto,
  PersonaAlertaDto,
} from './dto/alertas.dto.js';

interface FilaAuditoria {
  id: string;
  creado_en: Date;
  detalle: {
    patron: string;
    personas: string[];
    reservaId: string;
    cantidad?: number;
    distanciaM?: number;
    minutos?: number;
    bloqueoHasta?: string;
    tipo?: string;
    hasta?: string;
  };
}

/**
 * HU-26: solo lectura de lo que HU-25 dejó en la auditoría. Todo corre dentro de `enOrganizacion`, así que RLS deja ver
 * solo la organización activa (A-13); el filtro explícito es una segunda barrera. No hay ninguna acción que escriba o
 * levante un bloqueo (CA-8). Las alertas no traen coordenadas (HU-25 RN-10), y de las personas solo sale el nombre.
 */
@Injectable()
export class AlertasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
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
        SELECT id, creado_en, detalle FROM registros_auditoria
        WHERE organizacion_id = ${organizacionId}::uuid AND accion = 'fraude.alerta'
          AND (${patron}::text IS NULL OR detalle->>'patron' = ${patron}::text)
          AND (${antes}::timestamptz IS NULL OR creado_en < ${antes}::timestamptz)
        ORDER BY creado_en DESC, id DESC
        LIMIT ${limite + 1}`;
        const hayMas = filas.length > limite;
        const pagina = filas.slice(0, limite);
        const nombres = await this.personas(tx, pagina);
        const alertas: AlertaDto[] = pagina.map((f) => ({
          id: f.id,
          creadoEn: f.creado_en,
          patron: f.detalle.patron,
          personas: nombres(f),
          cantidad: f.detalle.cantidad,
          distanciaM: f.detalle.distanciaM,
          minutos: f.detalle.minutos,
          bloqueoHasta: f.detalle.bloqueoHasta
            ? new Date(f.detalle.bloqueoHasta)
            : undefined,
        }));
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

  /** Nombre y rol (RN-4): conductor si es el del viaje de la reserva que originó la alerta, si no pasajero. */
  private async personas(tx: Transaccion, filas: FilaAuditoria[]) {
    const ids = [...new Set(filas.flatMap((f) => f.detalle.personas))];
    const reservas = [...new Set(filas.map((f) => f.detalle.reservaId))];
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
        rol:
          conductor.get(f.detalle.reservaId) === id ? 'conductor' : 'pasajero',
      }));
  }

  /** CA-10. */
  private registrarConsulta(
    organizacionId: string,
    actorId: string,
    que: 'alertas' | 'bloqueos',
  ) {
    return this.auditoria.registrar({
      accion: `fraude.${que}.consultadas`,
      entidad: 'organizacion',
      entidadId: organizacionId,
      resultado: 'ok',
      actorId,
      organizacionId,
    });
  }
}
