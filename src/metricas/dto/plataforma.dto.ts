import { ApiProperty } from '@nestjs/swagger';
import { PERIODOS, type Periodo } from './resumen.dto.js';

export class MetricasGlobalesDto {
  @ApiProperty() organizacionesActivas!: number;
  @ApiProperty() miembrosActivos!: number;
  @ApiProperty() viajesPagados!: number;
  @ApiProperty() pasajeros!: number;
  @ApiProperty({ description: 'Estimado: distancia en línea recta × 0,12.' })
  co2Kg!: number;
  @ApiProperty() fallidasOExpiradas!: number;
}

export class MetricasOrganizacionDto {
  @ApiProperty() organizacionId!: string;
  @ApiProperty() nombre!: string;
  @ApiProperty() viajesPagados!: number;
  @ApiProperty() miembrosActivos!: number;
  @ApiProperty() co2Kg!: number;
  @ApiProperty({ description: 'Sin viajes pagados en el período.' })
  sinActividad!: boolean;
}

/** Solo agregados: ninguna persona, correo ni viaje individual (CA-8). */
export class MetricasPlataformaDto {
  @ApiProperty({ enum: PERIODOS }) periodo!: Periodo;
  @ApiProperty({ type: MetricasGlobalesDto }) global!: MetricasGlobalesDto;
  @ApiProperty({ type: [MetricasOrganizacionDto] })
  porOrganizacion!: MetricasOrganizacionDto[];
}
