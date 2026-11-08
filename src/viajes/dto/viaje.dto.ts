import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  Allow,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { recortar } from '../../comun/validaciones.js';
import { EstadoViaje } from '../../generated/prisma/client.js';

/** Los límites de negocio (cupos, precio, horario) los valida el servicio: cada uno responde con su propio `codigo`. */
export class PublicarViajeDto {
  @ApiProperty({ example: 'Plaza 24 de Septiembre', maxLength: 200 })
  @recortar()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  origenNombre!: string;

  @ApiProperty({ example: -17.783327, minimum: -90, maximum: 90 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  origenLat!: number;

  @ApiProperty({ example: -63.182129, minimum: -180, maximum: 180 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  origenLng!: number;

  @ApiProperty({ example: 'UAGRM, Módulos', maxLength: 200 })
  @recortar()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  destinoNombre!: string;

  @ApiProperty({ example: -17.775, minimum: -90, maximum: 90 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  destinoLat!: number;

  @ApiProperty({ example: -63.195, minimum: -180, maximum: 180 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  destinoLng!: number;

  @ApiProperty({
    example: '2026-11-10T11:30:00Z',
    description:
      'ISO 8601 con zona horaria. Entre 15 minutos y 7 días desde ahora.',
  })
  // Sin zona, la hora dependería del servidor.
  @IsISO8601({ strict: true })
  @Matches(/(Z|[+-]\d{2}:\d{2})$/)
  fechaHoraSalida!: string;

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    example: 3,
    description: 'Como máximo, la capacidad del vehículo del conductor.',
  })
  @IsInt()
  @Min(1)
  cuposTotales!: number;

  @ApiProperty({
    example: 10.5,
    description:
      'En URC, con hasta 2 decimales. Desde 1 hasta el tope de la organización.',
  })
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  precioPorAsiento!: number;
}

/** En la URL todo es texto, y `Number('')` daría 0: un punto válido. */
const aNumero = () =>
  Transform(({ value }) =>
    typeof value === 'string' && value.trim() ? Number(value) : Number.NaN,
  );

export class BuscarViajesDto {
  // `@Allow`: el servicio valida las coordenadas para responder con su propio `codigo`.
  @ApiProperty({ type: Number, example: -17.783, minimum: -90, maximum: 90 })
  @Allow()
  @aNumero()
  origenLat!: number;

  @ApiProperty({ type: Number, example: -63.182, minimum: -180, maximum: 180 })
  @Allow()
  @aNumero()
  origenLng!: number;

  @ApiProperty({
    example: '2026-11-03T07:30:00Z',
    description: 'ISO 8601 con zona horaria. Busca salidas a ± 30 minutos.',
  })
  // Más estricto que `fechaHoraSalida`: ISO 8601 admite formas (`T07Z`, semanas) que `Date` no entiende.
  @IsISO8601({ strict: true })
  @Matches(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/,
  )
  horaSalida!: string;
}

export class LimitesViajeDto {
  @ApiProperty({
    example: 1,
    description: 'Precio mínimo por asiento, en URC.',
  })
  precioMinimo!: number;
  @ApiProperty({
    example: 20,
    description: 'Tope por asiento de la organización activa, en URC.',
  })
  precioMaximo!: number;
}

export class ViajePublicadoDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty({ enum: EstadoViaje, example: 'publicado' })
  estado!: EstadoViaje;
  @ApiProperty({ type: 'integer' })
  cuposDisponibles!: number;
}

export class MiViajeDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty()
  origenNombre!: string;
  @ApiProperty()
  destinoNombre!: string;
  @ApiProperty({ type: String, format: 'date-time' })
  fechaHoraSalida!: Date;
  @ApiProperty({ type: 'integer' })
  cuposDisponibles!: number;
  @ApiProperty()
  precioPorAsiento!: number;
  @ApiProperty({ enum: EstadoViaje })
  estado!: EstadoViaje;
}

class LugarDto {
  @ApiProperty()
  nombre!: string;
  @ApiProperty()
  lat!: number;
  @ApiProperty()
  lng!: number;
}

class ConductorPublicoDto {
  @ApiProperty({ description: 'Nombre de pila (RN-4 de HU-18).' })
  nombre!: string;
}

class ConductorEncontradoDto extends ConductorPublicoDto {
  @ApiProperty()
  verificado!: boolean;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: '`null` mientras no haya reseñas (D-17).',
  })
  calificacionPromedio!: number | null;
  @ApiProperty({ description: 'Sin reseñas todavía (D-17).' })
  esNuevo!: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Antigüedad en la plataforma (RN-5).',
  })
  miembroDesde!: Date;
}

class VehiculoPublicoDto {
  @ApiProperty()
  placa!: string;
  @ApiProperty()
  marca!: string;
  @ApiProperty()
  modelo!: string;
  @ApiProperty()
  color!: string;
}

export class ViajeEncontradoDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty()
  origenNombre!: string;
  @ApiProperty({ description: 'Del punto buscado a la salida, en km.' })
  distanciaKm!: number;
  @ApiProperty()
  destinoNombre!: string;
  @ApiProperty({ type: String, format: 'date-time' })
  fechaHoraSalida!: Date;
  @ApiProperty({ type: 'integer' })
  cuposDisponibles!: number;
  @ApiProperty()
  precioPorAsiento!: number;
  @ApiProperty({ type: ConductorEncontradoDto })
  conductor!: ConductorEncontradoDto;
  @ApiProperty({ type: VehiculoPublicoDto })
  vehiculo!: VehiculoPublicoDto;
}

export class DetalleViajeDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty({ type: LugarDto })
  origen!: LugarDto;
  @ApiProperty({ type: LugarDto })
  destino!: LugarDto;
  @ApiProperty({ type: String, format: 'date-time' })
  fechaHoraSalida!: Date;
  @ApiProperty({ type: ConductorPublicoDto })
  conductor!: ConductorPublicoDto;
  @ApiProperty({ type: VehiculoPublicoDto })
  vehiculo!: VehiculoPublicoDto;
  @ApiProperty({ type: 'integer', description: 'Para mostrar «2 de 3».' })
  cuposTotales!: number;
  @ApiProperty({ type: 'integer' })
  cuposDisponibles!: number;
  @ApiProperty()
  precioPorAsiento!: number;
  @ApiProperty({ enum: EstadoViaje })
  estado!: EstadoViaje;
}
