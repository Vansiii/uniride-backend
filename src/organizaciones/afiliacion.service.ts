import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService, type Transaccion } from '../comun/prisma.service.js';
import type { ModoAprobacion } from './dto/afiliacion.dto.js';

/** RN-4: dominios de correo públicos que ninguna organización puede reclamar. */
export const DOMINIOS_PUBLICOS = [
  'gmail.com',
  'hotmail.com',
  'outlook.com',
  'yahoo.com',
  'icloud.com',
];

// Nombre de host con al menos un punto; etiquetas de 1 a 63 caracteres y terminación alfabética.
const NOMBRE_HOST =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** RN-3: minúsculas, sin espacios ni `@` inicial; la coincidencia luego es exacta. */
export const normalizarDominio = (dominio: string) =>
  dominio.trim().replace(/^@/, '').toLowerCase();

/** Normaliza, quita repetidos y valida formato y RN-4 (CA-3, CA-6). */
export function validarDominios(dominios: string[]): string[] {
  const normalizados = [...new Set(dominios.map(normalizarDominio))];
  if (normalizados.length === 0)
    throw new ErrorNegocio(
      400,
      'MINIMO_UN_DOMINIO',
      'organizaciones.afiliacion.minimo_un_dominio',
    );
  const invalido = normalizados.find(
    (d) => !NOMBRE_HOST.test(d) || DOMINIOS_PUBLICOS.includes(d),
  );
  if (invalido !== undefined)
    throw new ErrorNegocio(
      400,
      'DOMINIO_INVALIDO',
      'organizaciones.afiliacion.dominio_invalido',
      { dominio: invalido },
    );
  return normalizados.sort();
}

const noEncontrada = () =>
  new ErrorNegocio(404, 'NO_ENCONTRADO', 'comun.errores.no_encontrado');

export interface Afiliacion {
  dominios: string[];
  modoAprobacion: ModoAprobacion;
}

@Injectable()
export class AfiliacionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /** `id` distinto de la organización activa responde igual que una inexistente (A-13). */
  obtener(organizacionId: string, id: string): Promise<Afiliacion> {
    if (id !== organizacionId) throw noEncontrada();
    return this.prisma.enOrganizacion(organizacionId, (tx) =>
      this.leer(tx, organizacionId),
    );
  }

  /** Reemplaza la lista completa y el modo en una transacción, con auditoría del antes y el después (CA-8). */
  async guardar(
    organizacionId: string,
    id: string,
    actorId: string,
    cambio: Afiliacion,
  ): Promise<Afiliacion> {
    if (id !== organizacionId) throw noEncontrada();
    const dominios = validarDominios(cambio.dominios);
    try {
      return await this.prisma.enOrganizacion(organizacionId, async (tx) => {
        const anterior = await this.leer(tx, organizacionId);
        const quitar = anterior.dominios.filter((d) => !dominios.includes(d));
        const agregar = dominios.filter((d) => !anterior.dominios.includes(d));
        // RN-7: quitar un dominio solo impide registros nuevos; las membresías no se tocan.
        await tx.dominioOrganizacion.deleteMany({
          where: { organizacionId, dominio: { in: quitar } },
        });
        // Sin skipDuplicates: un dominio de otra organización debe fallar con UNIQUE (CA-2).
        await tx.dominioOrganizacion.createMany({
          data: agregar.map((dominio) => ({ organizacionId, dominio })),
        });
        // RN-6: el modo solo rige para registros futuros; las pendientes siguen pendientes.
        await tx.organizacion.update({
          where: { id: organizacionId },
          data: { modoAprobacion: cambio.modoAprobacion },
        });
        const nuevo = { dominios, modoAprobacion: cambio.modoAprobacion };
        await this.auditoria.registrar(
          {
            accion: 'organizacion.afiliacion',
            entidad: 'organizacion',
            entidadId: organizacionId,
            resultado: 'ok',
            actorId,
            organizacionId,
            detalle: { anterior, nuevo },
          },
          tx,
        );
        return nuevo;
      });
    } catch (error) {
      // Choque con UNIQUE(dominio): también cubre dos organizaciones a la vez. No se dice de quién es.
      if ((error as { code?: string }).code === 'P2002') {
        await this.auditoria.registrar({
          accion: 'organizacion.afiliacion',
          entidad: 'organizacion',
          entidadId: organizacionId,
          resultado: 'fallo',
          actorId,
          organizacionId,
          detalle: { motivo: 'dominio_no_disponible' },
        });
        throw new ErrorNegocio(
          409,
          'DOMINIO_NO_DISPONIBLE',
          'organizaciones.afiliacion.dominio_no_disponible',
        );
      }
      throw error;
    }
  }

  private async leer(
    tx: Transaccion,
    organizacionId: string,
  ): Promise<Afiliacion> {
    const org = await tx.organizacion.findUnique({
      where: { id: organizacionId },
      include: { dominios: { orderBy: { dominio: 'asc' } } },
    });
    if (!org) throw noEncontrada();
    return {
      dominios: org.dominios.map((d) => d.dominio),
      modoAprobacion: org.modoAprobacion as ModoAprobacion,
    };
  }
}
