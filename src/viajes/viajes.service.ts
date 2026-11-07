import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService } from '../comun/prisma.service.js';
import { EstadoViaje, Prisma } from '../generated/prisma/client.js';
import type {
  BuscarViajesDto,
  DetalleViajeDto,
  LimitesViajeDto,
  MiViajeDto,
  PublicarViajeDto,
  ViajeEncontradoDto,
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
/** HU-18, RN-1 y RN-2. */
const RADIO_BUSQUEDA_KM = 1;
const VENTANA_BUSQUEDA_MS = 30 * MINUTO_MS;
// ponytail: tope fijo sin paginar; 1 km y una hora ya acotan mucho. Paginar si una zona llega a llenarlo.
const MAXIMO_RESULTADOS = 50;

/** RN-4 de HU-18: a otros miembros no se les da el nombre completo. */
const nombreDePila = (nombreCompleto: string) =>
  nombreCompleto.trim().split(/\s+/)[0];

interface FilaBusqueda {
  id: string;
  origen_nombre: string;
  distancia_km: number;
  destino_nombre: string;
  fecha_hora_salida: Date;
  cupos_disponibles: number;
  precio_por_asiento: Prisma.Decimal;
  nombre_completo: string;
  miembro_desde: Date;
  verificado: boolean;
  placa: string;
  marca: string;
  modelo: string;
  color: string;
}

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

    if (dto.origenLat === dto.destinoLat && dto.origenLng === dto.destinoLng)
      throw new ErrorNegocio(
        400,
        'LUGARES_IGUALES',
        'viajes.publicar.lugares_iguales',
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
          // Publicado cuya salida ya pasó: nadie reservó y no ocupa al conductor (no hay cómo cancelarlo ni expirarlo aún).
          NOT: {
            estado: EstadoViaje.publicado,
            fechaHoraSalida: { lte: new Date() },
          },
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

  /**
   * HU-18: viajes de la organización activa con salida a 1 km y ± 30 min del pedido, con cupos y aún sin salir.
   * Solo proyección pública: nunca foto, documento ni correo (D-20).
   */
  async buscar(
    organizacionId: string,
    { origenLat: lat, origenLng: lng, horaSalida }: BuscarViajesDto,
  ): Promise<ViajeEncontradoDto[]> {
    if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180))
      throw new ErrorNegocio(
        400,
        'COORDENADAS_INVALIDAS',
        'comun.errores.coordenadas_invalidas',
      );

    const hora = new Date(horaSalida).getTime();
    const ahora = Date.now();
    // Ningún viaje sale fuera de este rango; además, un año extremo no llega a PostgreSQL.
    if (
      hora + VENTANA_BUSQUEDA_MS <= ahora ||
      hora - VENTANA_BUSQUEDA_MS >
        ahora + ANTICIPACION_MAXIMA_DIAS * 24 * HORA_MS
    )
      return [];
    const desde = new Date(hora - VENTANA_BUSQUEDA_MS);
    const hasta = new Date(hora + VENTANA_BUSQUEDA_MS);

    const filas = await this.prisma.enOrganizacion(
      organizacionId,
      (tx) => tx.$queryRaw<FilaBusqueda[]>`
        SELECT v.id, v.origen_nombre, d.km::float8 AS distancia_km, v.destino_nombre, v.fecha_hora_salida,
               v.cupos_disponibles, v.precio_por_asiento, u.nombre_completo, u.creado_en AS miembro_desde,
               COALESCE(i.estado = 'verificada', false) AS verificado, a.placa, a.marca, a.modelo, a.color
        FROM viajes v
        JOIN usuarios u ON u.id = v.conductor_id
        JOIN vehiculos a ON a.id = v.vehiculo_id
        LEFT JOIN identidades i ON i.usuario_id = v.conductor_id
        -- Haversine. El redondeo puede dejar el argumento apenas fuera de [-1, 1], y acos fallaría.
        CROSS JOIN LATERAL (
          SELECT 6371 * acos(GREATEST(-1, LEAST(1,
            cos(radians(${lat}::float8)) * cos(radians(v.origen_lat)) *
            cos(radians(v.origen_lng) - radians(${lng}::float8)) +
            sin(radians(${lat}::float8)) * sin(radians(v.origen_lat))
          ))) AS km
        ) d
        WHERE v.organizacion_id = ${organizacionId}::uuid
          AND v.estado IN ('publicado', 'reservado')
          AND v.cupos_disponibles > 0
          AND v.fecha_hora_salida BETWEEN ${desde}::timestamptz AND ${hasta}::timestamptz
          AND v.fecha_hora_salida > now()
          AND u.suspendida_en IS NULL
          AND d.km <= ${RADIO_BUSQUEDA_KM}
        ORDER BY v.fecha_hora_salida, d.km
        LIMIT ${MAXIMO_RESULTADOS}`,
    );
    return filas.map((f) => ({
      id: f.id,
      origenNombre: f.origen_nombre,
      distanciaKm: Math.round(f.distancia_km * 100) / 100,
      destinoNombre: f.destino_nombre,
      fechaHoraSalida: f.fecha_hora_salida,
      cuposDisponibles: f.cupos_disponibles,
      precioPorAsiento: Number(f.precio_por_asiento),
      conductor: {
        nombre: nombreDePila(f.nombre_completo),
        verificado: f.verificado,
        // ponytail: sin reseñas hasta HU-21 (D-17); entonces se leen de su tabla.
        calificacionPromedio: null,
        esNuevo: true,
        miembroDesde: f.miembro_desde,
      },
      vehiculo: {
        placa: f.placa,
        marca: f.marca,
        modelo: f.modelo,
        color: f.color,
      },
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
      conductor: { nombre: nombreDePila(viaje.conductor.nombreCompleto) },
      vehiculo: viaje.vehiculo,
      cuposDisponibles: viaje.cuposDisponibles,
      precioPorAsiento: Number(viaje.precioPorAsiento),
      estado: viaje.estado,
    };
  }
}
