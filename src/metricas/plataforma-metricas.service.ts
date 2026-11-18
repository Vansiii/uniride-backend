import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { PrismaService } from '../comun/prisma.service.js';
import type { MetricasPlataformaDto } from './dto/plataforma.dto.js';
import type { Periodo } from './dto/resumen.dto.js';
import { agregarPorOrganizacion, co2Kg } from './metricas.sql.js';

const DIAS: Record<Periodo, number | null> = { '7d': 7, '30d': 30, todo: null };

/**
 * HU-33: lectura global con `comoSuperAdmin` (RN-5). Consulta fija, sin parámetros de organización, sin escritura y
 * solo agregados. El total global se suma de las mismas filas de la tabla (CA-3).
 */
@Injectable()
export class PlataformaMetricasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async metricas(
    actorId: string,
    periodo: Periodo,
    ahora = new Date(),
  ): Promise<MetricasPlataformaDto> {
    const dias = DIAS[periodo];
    const desde =
      dias === null ? null : new Date(ahora.getTime() - dias * 864e5);
    const { agregados, organizaciones, miembros, fallidas } =
      await this.prisma.comoSuperAdmin(async (tx) => ({
        agregados: await agregarPorOrganizacion(tx, null, desde),
        organizaciones: await tx.organizacion.findMany({
          select: { id: true, nombre: true },
          orderBy: { nombre: 'asc' },
        }),
        miembros: await tx.membresia.groupBy({
          by: ['organizacionId'],
          where: { estado: 'aprobada' },
          _count: { _all: true },
        }),
        fallidas: await tx.reserva.count({
          where: {
            estado: { in: ['verificacion_fallida', 'expirada'] },
            ...(desde && { actualizadoEn: { gte: desde } }),
          },
        }),
      }));
    const miembrosDe = new Map(
      miembros.map((m) => [m.organizacionId, m._count._all]),
    );
    const agregadoDe = new Map(agregados.map((a) => [a.organizacionId, a]));
    const filas = organizaciones.map((o) => {
      const a = agregadoDe.get(o.id);
      return {
        organizacionId: o.id,
        nombre: o.nombre,
        viajesPagados: a?.viajesPagados ?? 0,
        miembrosActivos: miembrosDe.get(o.id) ?? 0,
        pasajeros: a?.pasajeros ?? 0,
        distanciaKm: a?.distanciaKm ?? 0,
      };
    });
    const suma = (f: (x: (typeof filas)[number]) => number) =>
      filas.reduce((n, x) => n + f(x), 0);
    await this.auditoria.registrar({
      accion: 'plataforma.metricas.consultadas',
      entidad: 'plataforma',
      resultado: 'ok',
      actorId,
    });
    return {
      periodo,
      global: {
        organizacionesActivas: filas.filter((f) => f.miembrosActivos > 0)
          .length,
        miembrosActivos: suma((f) => f.miembrosActivos),
        viajesPagados: suma((f) => f.viajesPagados),
        pasajeros: suma((f) => f.pasajeros),
        co2Kg: co2Kg(suma((f) => f.distanciaKm)),
        fallidasOExpiradas: fallidas,
      },
      porOrganizacion: filas.map((f) => ({
        organizacionId: f.organizacionId,
        nombre: f.nombre,
        viajesPagados: f.viajesPagados,
        miembrosActivos: f.miembrosActivos,
        co2Kg: co2Kg(f.distanciaKm),
        sinActividad: f.viajesPagados === 0,
      })),
    };
  }
}
