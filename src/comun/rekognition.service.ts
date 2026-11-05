import { Injectable, OnModuleInit } from '@nestjs/common';
import type { MotorFacial } from './motor-facial.js';
import { MotorFacialRekognition } from './motor-facial-rekognition.js';
import { MotorFacialSimulado } from './motor-facial-simulado.js';

/**
 * Elige el motor facial por entorno: `REKOGNITION_SIMULADO=true` usa el simulado (solo desarrollo); si no,
 * AWS Rekognition con la colección `REKOGNITION_COLECCION_ROSTROS`. El simulado en producción detiene el arranque (A-01).
 */
export function crearMotorFacial(): MotorFacial {
  const produccion = process.env.NODE_ENV === 'production';
  if (process.env.REKOGNITION_SIMULADO === 'true') {
    if (produccion)
      throw new Error('REKOGNITION_SIMULADO=true está prohibido en producción');
    return new MotorFacialSimulado();
  }
  const coleccion = process.env.REKOGNITION_COLECCION_ROSTROS;
  if (!coleccion)
    throw new Error('REKOGNITION_COLECCION_ROSTROS no está configurado');
  return new MotorFacialRekognition(coleccion);
}

@Injectable()
export class RekognitionService implements OnModuleInit {
  private actual?: MotorFacial;

  /** Una mala configuración detiene el arranque en producción; en otros entornos se elige al primer uso. */
  onModuleInit(): void {
    if (process.env.NODE_ENV === 'production')
      this.actual ??= crearMotorFacial();
  }

  get motor(): MotorFacial {
    return (this.actual ??= crearMotorFacial());
  }

  /** Reemplazable en pruebas. */
  set motor(motor: MotorFacial) {
    this.actual = motor;
  }
}
