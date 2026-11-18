import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService, type Transaccion } from '../comun/prisma.service.js';
import type {
  CalificarDto,
  EstadoCalificacionDto,
} from './dto/calificacion.dto.js';

/** CA-4: plazo para calificar desde el pago. */
export const PLAZO_MS = 7 * 24 * 3_600_000;

const sinPermiso = () =>
  new ErrorNegocio(403, 'NO_PARTICIPANTE', 'comun.errores.no_autorizado');
const conflicto = (codigo: string, clave: string) =>
  new ErrorNegocio(409, codigo, clave);

/**
 * HU-21. Todo corre en `enOrganizacion`: una reserva de otra organización no aparece y se trata igual que una ajena
 * (403, sin revelar que existe; A-13). El destinatario lo deduce el servidor; el cliente no lo decide (A-08).
 */
@Injectable()
export class CalificacionesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /** La reserva, quién es quién y cuándo se pagó; 403 si quien pregunta no es parte. */
  private async contexto(tx: Transaccion, reservaId: string, actorId: string) {
    const reserva = await tx.reserva.findUnique({
      where: { id: reservaId },
      select: {
        id: true,
        estado: true,
        pasajeroId: true,
        pasajero: { select: { nombreCompleto: true } },
        viaje: {
          select: {
            conductorId: true,
            conductor: { select: { nombreCompleto: true } },
          },
        },
      },
    });
    if (!reserva) throw sinPermiso();
    const esPasajero = reserva.pasajeroId === actorId;
    if (!esPasajero && reserva.viaje.conductorId !== actorId)
      throw sinPermiso();
    const pago =
      reserva.estado === 'pagada'
        ? await tx.movimientoBilletera.findFirst({
            where: { reservaId, tipo: 'liberacion_viaje' },
            orderBy: { creadoEn: 'asc' },
            select: { creadoEn: true },
          })
        : null;
    return {
      destinatarioId: esPasajero
        ? reserva.viaje.conductorId
        : reserva.pasajeroId,
      destinatario: esPasajero
        ? reserva.viaje.conductor.nombreCompleto
        : reserva.pasajero.nombreCompleto,
      plazoHasta: pago ? new Date(pago.creadoEn.getTime() + PLAZO_MS) : null,
    };
  }

  async calificar(
    organizacionId: string,
    actorId: string,
    reservaId: string,
    dto: CalificarDto,
    ahora = new Date(),
  ): Promise<{ id: string }> {
    const id = await this.prisma.enOrganizacion(organizacionId, async (tx) => {
      const c = await this.contexto(tx, reservaId, actorId);
      if (dto.destinatarioId && dto.destinatarioId !== c.destinatarioId)
        throw sinPermiso();
      if (!c.plazoHasta)
        throw conflicto('RESERVA_NO_PAGADA', 'calificaciones.crear.no_pagada');
      if (ahora.getTime() > c.plazoHasta.getTime())
        throw conflicto('PLAZO_VENCIDO', 'calificaciones.crear.plazo_vencido');
      // Dos envíos a la vez: el índice único deja pasar uno solo; el otro cae en ON CONFLICT (CA-3, CA-12).
      const filas = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO calificaciones (organizacion_id, reserva_id, autor_id, destinatario_id, estrellas, comentario)
        VALUES (${organizacionId}::uuid, ${reservaId}::uuid, ${actorId}::uuid, ${c.destinatarioId}::uuid, ${dto.estrellas}, ${dto.comentario?.trim() || null})
        ON CONFLICT (reserva_id, autor_id) DO NOTHING
        RETURNING id`;
      if (!filas[0])
        throw conflicto('YA_CALIFICADA', 'calificaciones.crear.ya_calificada');
      return filas[0].id;
    });
    await this.auditoria.registrar({
      accion: 'calificacion.creada',
      entidad: 'calificacion',
      entidadId: id,
      resultado: 'ok',
      actorId,
      organizacionId,
    });
    return { id };
  }

  async estado(
    organizacionId: string,
    actorId: string,
    reservaId: string,
    ahora = new Date(),
  ): Promise<EstadoCalificacionDto> {
    return this.prisma.enOrganizacion(organizacionId, async (tx) => {
      const c = await this.contexto(tx, reservaId, actorId);
      const [mia, recibida] = await Promise.all([
        tx.calificacion.findUnique({
          where: { reservaId_autorId: { reservaId, autorId: actorId } },
          select: { id: true },
        }),
        tx.calificacion.findUnique({
          where: {
            reservaId_autorId: { reservaId, autorId: c.destinatarioId },
          },
          select: { estrellas: true, comentario: true },
        }),
      ]);
      const vencido =
        !!c.plazoHasta && ahora.getTime() > c.plazoHasta.getTime();
      return {
        puedoCalificar: !!c.plazoHasta && !vencido && !mia,
        plazoHasta: c.plazoHasta,
        destinatario: c.destinatario,
        // Calificación ciega (CA-7, RN-6): solo si ya califiqué o venció el plazo.
        ...(recibida && (mia || vencido) ? { recibida } : {}),
      };
    });
  }
}
