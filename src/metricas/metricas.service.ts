import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { PrismaService } from '../comun/prisma.service.js';
import type { Periodo, ResumenDto } from './dto/resumen.dto.js';
import { agregarPagadas, co2Kg } from './metricas.sql.js';

const DIAS: Record<Periodo, number | null> = { '7d': 7, '30d': 30, todo: null };

/** HU-32: cifras de la organización activa (RLS + filtro explícito, A-13). Solo lectura. */
@Injectable()
export class MetricasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async resumen(
    organizacionId: string,
    actorId: string,
    periodo: Periodo,
    ahora = new Date(),
  ): Promise<ResumenDto> {
    const dias = DIAS[periodo];
    const desde =
      dias === null ? null : new Date(ahora.getTime() - dias * 864e5);
    const { agregado, miembrosActivos } = await this.prisma.enOrganizacion(
      organizacionId,
      async (tx) => ({
        agregado: await agregarPagadas(tx, organizacionId, desde),
        miembrosActivos: await tx.membresia.count({
          where: { organizacionId, estado: 'aprobada' },
        }),
      }),
    );
    await this.auditoria.registrar({
      accion: 'organizacion.resumen.consultado',
      entidad: 'organizacion',
      entidadId: organizacionId,
      resultado: 'ok',
      actorId,
      organizacionId,
    });
    return {
      periodo,
      viajesPagados: agregado.viajesPagados,
      miembrosActivos,
      pasajeros: agregado.pasajeros,
      co2Kg: co2Kg(agregado.distanciaKm),
    };
  }
}
