import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService } from '../comun/prisma.service.js';
import { EstadoViaje, Prisma } from '../generated/prisma/client.js';
import type {
  DetalleViajeDto,
  LimitesViajeDto,
  MiViajeDto,
  PublicarViajeDto,
  ViajePublicadoDto,
} from './dto/viaje.dto.js';

const MINUTO_MS = 60_000;
const HORA_MS = 60 * MINUTO_MS;
/** RN-5. */
const ANTICIPACION_MINIMA_MINUTOS = 15;
const ANTICIPACION_MAXIMA_DIAS = 7;
/** CA-5: con exactamente este margen entre salidas ya no se solapan. */
const MARGEN_SOLAPE_MS = 2 * HORA_MS;
/** CA-3. */
const PRECIO_MINIMO_URC = 1;
/** Mientras el viaje no terminó ni se canceló, ocupa al conductor (CA-5). */
const ESTADOS_ACTIVOS = [
  EstadoViaje.publicado,
  EstadoViaje.reservado,
  EstadoViaje.en_curso,
];
// ponytail: tope fijo sin paginar; paginar cuando un conductor pueda acumular más.
const MAXIMO_MIS_VIAJES = 100;

@Injectable()
export class ViajesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  limites(organizacionId: string): Promise<LimitesViajeDto> {
    return this.prisma.enOrganizacion(organizacionId, async (tx) => {
      const { precioMaximoUrc } = await tx.organizacion.findUniqueOrThrow({
        where: { id: organizacionId },
        select: { precioMaximoUrc: true },
      });
      return {
        precioMinimo: PRECIO_MINIMO_URC,
        precioMaximo: Number(precioMaximoUrc),
      };
    });
  }

  async publicar(
    conductorId: string,
    organizacionId: string,
    dto: PublicarViajeDto,
  ): Promise<ViajePublicadoDto> {
    const vehiculo = await this.prisma.vehiculo.findUnique({
      where: { propietarioId: conductorId },
      select: { id: true, capacidad: true },
    });
    if (!vehiculo)
      throw new ErrorNegocio(
        403,
        'CONDUCTOR_SIN_VEHICULO',
        'viajes.publicar.requisito_incompleto',
      );
    if (dto.cuposTotales > vehiculo.capacidad)
      throw new ErrorNegocio(
        400,
        'CUPOS_EXCEDEN_CAPACIDAD',
        'viajes.publicar.cupos_exceden_capacidad',
        { maximo: vehiculo.capacidad },
      );

    const salida = new Date(dto.fechaHoraSalida);
    const faltanMs = salida.getTime() - Date.now();
    if (
      !(faltanMs >= ANTICIPACION_MINIMA_MINUTOS * MINUTO_MS) ||
      faltanMs > ANTICIPACION_MAXIMA_DIAS * 24 * HORA_MS
    )
      throw new ErrorNegocio(
        400,
        'HORARIO_INVALIDO',
        'viajes.publicar.horario_invalido',
        {
          minimoMinutos: ANTICIPACION_MINIMA_MINUTOS,
          maximoDias: ANTICIPACION_MAXIMA_DIAS,
        },
      );

    return this.prisma.enOrganizacion(organizacionId, async (tx) => {
      const { precioMaximoUrc } = await tx.organizacion.findUniqueOrThrow({
        where: { id: organizacionId },
        select: { precioMaximoUrc: true },
      });
      const precio = new Prisma.Decimal(dto.precioPorAsiento);
      if (precio.lt(PRECIO_MINIMO_URC) || precio.gt(precioMaximoUrc))
        throw new ErrorNegocio(
          400,
          'PRECIO_FUERA_DE_RANGO',
          'viajes.publicar.precio_invalido',
          { minimo: PRECIO_MINIMO_URC, maximo: Number(precioMaximoUrc) },
        );

      // Dos publicaciones simultáneas del mismo conductor no pasan juntas la comprobación de solape.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${conductorId}, 0))`;
      // El conductor es la misma persona en todas sus organizaciones (HU-07): RLS se abre solo para esta lectura,
      // limitada a sus propios viajes; si no, un viaje en otra organización no se vería y se solaparía.
      await tx.$executeRaw`SELECT set_config('app.super_admin', 'true', true)`;
      const solapado = await tx.viaje.findFirst({
        where: {
          conductorId,
          estado: { in: ESTADOS_ACTIVOS },
          fechaHoraSalida: {
            gt: new Date(salida.getTime() - MARGEN_SOLAPE_MS),
            lt: new Date(salida.getTime() + MARGEN_SOLAPE_MS),
          },
        },
        select: { fechaHoraSalida: true },
      });
      await tx.$executeRaw`SELECT set_config('app.super_admin', '', true)`;
      // Es su propio viaje, aunque esté en otra organización: solo se le dice a él cuándo sale.
      if (solapado)
        throw new ErrorNegocio(
          409,
          'VIAJE_SOLAPADO',
          'viajes.publicar.viaje_solapado',
          {
            margenHoras: MARGEN_SOLAPE_MS / HORA_MS,
            salidaExistente: solapado.fechaHoraSalida.toISOString(),
          },
        );

      const viaje = await tx.viaje.create({
        data: {
          organizacionId,
          conductorId,
          vehiculoId: vehiculo.id,
          origenNombre: dto.origenNombre,
          origenLat: dto.origenLat,
          origenLng: dto.origenLng,
          destinoNombre: dto.destinoNombre,
          destinoLat: dto.destinoLat,
          destinoLng: dto.destinoLng,
          fechaHoraSalida: salida,
          cuposTotales: dto.cuposTotales,
          cuposDisponibles: dto.cuposTotales,
          precioPorAsiento: precio,
        },
        select: { id: true, estado: true, cuposDisponibles: true },
      });
      await this.auditoria.registrar(
        {
          accion: 'viaje.publicacion',
          entidad: 'viaje',
          entidadId: viaje.id,
          resultado: 'ok',
          actorId: conductorId,
          organizacionId,
        },
        tx,
      );
      return viaje;
    });
  }

  /** Los viajes son de quien los publica: lista los suyos en todas sus organizaciones, siempre filtrados por conductor. */
  async misViajes(conductorId: string): Promise<MiViajeDto[]> {
    const viajes = await this.prisma.comoSuperAdmin((tx) =>
      tx.viaje.findMany({
        where: { conductorId },
        orderBy: { fechaHoraSalida: 'desc' },
        take: MAXIMO_MIS_VIAJES,
        select: {
          id: true,
          origenNombre: true,
          destinoNombre: true,
          fechaHoraSalida: true,
          cuposDisponibles: true,
          precioPorAsiento: true,
          estado: true,
        },
      }),
    );
    return viajes.map((v) => ({
      ...v,
      precioPorAsiento: Number(v.precioPorAsiento),
    }));
  }

  /** Un viaje de otra organización responde igual que uno que no existe (A-13). */
  async detalle(
    organizacionId: string,
    viajeId: string,
  ): Promise<DetalleViajeDto> {
    const viaje = await this.prisma.enOrganizacion(organizacionId, (tx) =>
      tx.viaje.findFirst({
        where: { id: viajeId, organizacionId },
        select: {
          id: true,
          origenNombre: true,
          origenLat: true,
          origenLng: true,
          destinoNombre: true,
          destinoLat: true,
          destinoLng: true,
          fechaHoraSalida: true,
          cuposDisponibles: true,
          precioPorAsiento: true,
          estado: true,
          conductor: { select: { nombreCompleto: true } },
          // Lo mínimo para reconocer el auto: nunca la foto ni su clave (D-20).
          vehiculo: {
            select: { placa: true, marca: true, modelo: true, color: true },
          },
        },
      }),
    );
    if (!viaje)
      throw new ErrorNegocio(
        404,
        'VIAJE_NO_ENCONTRADO',
        'viajes.detalle.no_encontrado',
      );
    return {
      id: viaje.id,
      origen: {
        nombre: viaje.origenNombre,
        lat: Number(viaje.origenLat),
        lng: Number(viaje.origenLng),
      },
      destino: {
        nombre: viaje.destinoNombre,
        lat: Number(viaje.destinoLat),
        lng: Number(viaje.destinoLng),
      },
      fechaHoraSalida: viaje.fechaHoraSalida,
      conductor: { nombre: viaje.conductor.nombreCompleto },
      vehiculo: viaje.vehiculo,
      cuposDisponibles: viaje.cuposDisponibles,
      precioPorAsiento: Number(viaje.precioPorAsiento),
      estado: viaje.estado,
    };
  }
}
