import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AccionAsistenteDto {
  @ApiProperty({
    description: 'Ruta de navegación destino',
    example: '/buscar',
  })
  ruta!: string;

  @ApiPropertyOptional({
    description: 'Parámetros para la pantalla de destino',
    example: { destino: 'UAGRM', hora: '07:00' },
  })
  params?: Record<string, string>;

  @ApiProperty({
    description: 'Texto para el botón de acción',
    example: 'Ir a buscar',
  })
  etiquetaBoton!: string;
}

export class RespuestaAsistenteDto {
  @ApiProperty({
    description: 'Modo de respuesta: acción directa o guía explicativa',
    enum: ['accion', 'guia'],
  })
  modo!: 'accion' | 'guia';

  @ApiProperty({
    description: 'Mensaje explicativo o resumen para el usuario',
    example:
      'El saldo queda en garantía al reservar y solo se libera al conductor cuando confirmas la bajada.',
  })
  mensaje!: string;

  @ApiPropertyOptional({
    description: 'Acción de navegación sugerida',
    type: AccionAsistenteDto,
  })
  accion?: AccionAsistenteDto;

  @ApiPropertyOptional({
    description: 'Pasos explicativos para la tarjeta de guía',
    example: [
      'Reservas tu asiento con saldo en garantía',
      'Escaneas el código QR al subir',
      'Al bajar, el sistema libera el pago al conductor',
    ],
    type: [String],
  })
  pasos?: string[];
}
