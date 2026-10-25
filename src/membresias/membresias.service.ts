import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService } from '../comun/prisma.service.js';
import { t } from '../i18n/t.js';
import { CorreosService } from '../notificaciones/correos.service.js';
import type {
  DecisionDto,
  DecisionRespuestaDto,
  SolicitudDto,
} from './dto/membresia.dto.js';

const noEncontrada = () =>
  new ErrorNegocio(404, 'NO_ENCONTRADO', 'comun.errores.no_encontrado');

@Injectable()
export class MembresiasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly correos: CorreosService,
  ) {}

  /** CA-1: solicitudes de la organización activa, de la más antigua a la más reciente. Otro `id` responde como inexistente (A-13). */
  listar(
    organizacionId: string,
    id: string,
    estado: 'pendiente',
  ): Promise<SolicitudDto[]> {
    if (id !== organizacionId) throw noEncontrada();
    return this.prisma.enOrganizacion(organizacionId, async (tx) => {
      const filas = await tx.membresia.findMany({
        where: { organizacionId, estado },
        orderBy: [{ creadoEn: 'asc' }, { id: 'asc' }],
        include: {
          usuario: { select: { nombreCompleto: true, correo: true } },
        },
      });
      return filas.map((m) => ({
        id: m.id,
        nombreCompleto: m.usuario.nombreCompleto,
        correoInstitucional: m.correoInstitucional ?? m.usuario.correo,
        creadoEn: m.creadoEn,
      }));
    });
  }

  /** CA-2 a CA-5: decide una solicitud pendiente; decisión, auditoría y correo en cola van en la misma transacción. */
  async decidir(
    organizacionId: string,
    id: string,
    actorId: string,
    dto: DecisionDto,
  ): Promise<DecisionRespuestaDto> {
    // Un id mal formado responde igual que uno inexistente (A-13).
    if (!isUUID(id)) throw noEncontrada();
    const estado = dto.decision === 'aprobar' ? 'aprobada' : 'rechazada';
    const motivo = (dto.decision === 'rechazar' && dto.motivo) || null;
    const resultado = await this.prisma.enOrganizacion(
      organizacionId,
      async (tx) => {
        // El update condicional es el candado: de dos decisiones simultáneas solo vale la primera (CA-5, RN-2).
        const { count } = await tx.membresia.updateMany({
          where: { id, organizacionId, estado: 'pendiente' },
          data: {
            estado,
            decididoPor: actorId,
            decididoEn: new Date(),
            motivo,
          },
        });
        const m = await tx.membresia.findFirst({
          where: { id, organizacionId },
          include: { usuario: true, organizacion: true },
        });
        // RLS oculta las de otra organización: misma respuesta que una inexistente (CA-6).
        if (!m) throw noEncontrada();
        if (count === 0) {
          await this.auditoria.registrar(
            {
              accion: 'membresia.decision',
              entidad: 'membresia',
              entidadId: id,
              resultado: 'fallo',
              actorId,
              organizacionId,
              detalle: { decision: dto.decision, motivo: 'ya_decidida' },
            },
            tx,
          );
          return null;
        }
        if (estado === 'aprobada')
          await tx.usuario.updateMany({
            where: { id: m.usuarioId, ultimaOrganizacionId: null },
            data: { ultimaOrganizacionId: organizacionId },
          });
        await this.auditoria.registrar(
          {
            accion: 'membresia.decision',
            entidad: 'membresia',
            entidadId: id,
            resultado: 'ok',
            actorId,
            organizacionId,
            detalle: { decision: dto.decision, motivo },
          },
          tx,
        );
        // Si el envío falla, la decisión ya quedó: el worker reintenta.
        await this.correos.encolar(tx, {
          destinatario: m.correoInstitucional ?? m.usuario.correo,
          plantilla:
            estado === 'aprobada'
              ? 'membresia_aprobada'
              : 'membresia_rechazada',
          datos: {
            nombre: m.usuario.nombreCompleto,
            organizacion: m.organizacion.nombre,
            motivo: motivo
              ? t('notificaciones.membresia_rechazada.motivo').replace(
                  '{motivo}',
                  () => motivo,
                )
              : '',
          },
          referenciaTipo: 'membresia',
          referenciaId: id,
        });
        return { id, estado };
      },
    );
    if (!resultado)
      throw new ErrorNegocio(
        409,
        'MEMBRESIA_YA_DECIDIDA',
        'membresias.decision.ya_decidida',
      );
    return resultado;
  }
}
