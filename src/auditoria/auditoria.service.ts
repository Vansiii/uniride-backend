import { Injectable } from '@nestjs/common';
import { PrismaService } from '../comun/prisma.service.js';

export interface EventoAuditoria {
  accion: string;
  entidad: string;
  entidadId?: string;
  resultado: 'ok' | 'fallo';
  actorId?: string;
  organizacionId?: string;
  detalle?: Record<string, unknown>;
}

/** Registro de solo inserción. Nunca pasar secretos ni datos sensibles en `detalle`. */
@Injectable()
export class AuditoriaService {
  constructor(private readonly prisma: PrismaService) {}

  async registrar(e: EventoAuditoria): Promise<void> {
    // createMany evita el RETURNING, que RLS no permitiría leer en filas sin organización.
    await this.prisma.registroAuditoria.createMany({
      data: [
        {
          accion: e.accion,
          entidad: e.entidad,
          entidadId: e.entidadId,
          resultado: e.resultado,
          actorId: e.actorId,
          organizacionId: e.organizacionId,
          detalle: e.detalle as object | undefined,
        },
      ],
    });
  }
}
