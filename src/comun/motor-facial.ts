/** Resultado de `GetFaceLivenessSessionResults`: la decisión sobre los umbrales la toma el servicio de identidad. */
export interface ResultadoLiveness {
  /** `Status == SUCCEEDED`. */
  exitosa: boolean;
  /** 0 a 100. */
  confianza: number;
  /** Mejor cuadro de la prueba de vida, para compararlo con el carnet. */
  imagenReferencia?: Buffer;
}

/** Motor de reconocimiento facial (HU-08): AWS Rekognition en producción, simulado en desarrollo local. */
export interface MotorFacial {
  crearSesionLiveness(): Promise<string>;
  obtenerResultadoLiveness(sesionId: string): Promise<ResultadoLiveness>;
  /** Similitud 0 a 100 entre el rostro del carnet y el de referencia; `null` si el carnet no tiene un rostro legible. */
  compararRostros(referencia: Buffer, carnet: Buffer): Promise<number | null>;
  /** `true` si el rostro ya está indexado para una cuenta distinta de `usuarioId`. */
  buscarRostroDuplicado(imagen: Buffer, usuarioId: string): Promise<boolean>;
  /** Devuelve el `face_id` de la colección. */
  indexarRostro(imagen: Buffer, usuarioId: string): Promise<string>;
  desindexarRostro(faceId: string): Promise<void>;
}

/** Umbrales del plan (RN-1). */
export const CONFIANZA_MINIMA_LIVENESS = 85;
export const SIMILITUD_MINIMA = 90;
