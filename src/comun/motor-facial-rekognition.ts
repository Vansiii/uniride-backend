import {
  CompareFacesCommand,
  CreateFaceLivenessSessionCommand,
  DeleteFacesCommand,
  GetFaceLivenessSessionResultsCommand,
  IndexFacesCommand,
  RekognitionClient,
  SearchFacesByImageCommand,
} from '@aws-sdk/client-rekognition';
import {
  SIMILITUD_MINIMA,
  type MotorFacial,
  type ResultadoLiveness,
} from './motor-facial.js';

/** AWS Rekognition (plan HU-08 §3). La colección privada de UniRide viene de `REKOGNITION_COLECCION_ROSTROS`. */
export class MotorFacialRekognition implements MotorFacial {
  private readonly cliente = new RekognitionClient({
    region: process.env.AWS_REGION,
  });

  constructor(private readonly coleccion: string) {}

  async crearSesionLiveness(): Promise<string> {
    const r = await this.cliente.send(new CreateFaceLivenessSessionCommand({}));
    if (!r.SessionId) throw new Error('Rekognition no devolvió la sesión');
    return r.SessionId;
  }

  async obtenerResultadoLiveness(sesionId: string): Promise<ResultadoLiveness> {
    const r = await this.cliente.send(
      new GetFaceLivenessSessionResultsCommand({ SessionId: sesionId }),
    );
    return {
      exitosa: r.Status === 'SUCCEEDED',
      confianza: r.Confidence ?? 0,
      imagenReferencia: r.ReferenceImage?.Bytes
        ? Buffer.from(r.ReferenceImage.Bytes)
        : undefined,
    };
  }

  async compararRostros(
    referencia: Buffer,
    carnet: Buffer,
  ): Promise<number | null> {
    try {
      const r = await this.cliente.send(
        new CompareFacesCommand({
          SourceImage: { Bytes: carnet },
          TargetImage: { Bytes: referencia },
          SimilarityThreshold: 0,
          QualityFilter: 'AUTO',
        }),
      );
      if (!r.SourceImageFace) return null;
      return r.FaceMatches?.[0]?.Similarity ?? 0;
    } catch (error) {
      if (sinRostro(error)) return null;
      throw error;
    }
  }

  async buscarRostroDuplicado(
    imagen: Buffer,
    usuarioId: string,
  ): Promise<boolean> {
    try {
      const r = await this.cliente.send(
        new SearchFacesByImageCommand({
          CollectionId: this.coleccion,
          Image: { Bytes: imagen },
          FaceMatchThreshold: SIMILITUD_MINIMA,
          MaxFaces: 10,
          QualityFilter: 'AUTO',
        }),
      );
      return (r.FaceMatches ?? []).some(
        (m) => m.Face?.ExternalImageId !== usuarioId,
      );
    } catch (error) {
      if (sinRostro(error)) return false;
      throw error;
    }
  }

  async indexarRostro(imagen: Buffer, usuarioId: string): Promise<string> {
    const r = await this.cliente.send(
      new IndexFacesCommand({
        CollectionId: this.coleccion,
        Image: { Bytes: imagen },
        ExternalImageId: usuarioId,
        MaxFaces: 1,
        QualityFilter: 'AUTO',
      }),
    );
    const faceId = r.FaceRecords?.[0]?.Face?.FaceId;
    if (!faceId) throw new Error('Rekognition no indexó el rostro');
    return faceId;
  }

  async desindexarRostro(faceId: string): Promise<void> {
    await this.cliente.send(
      new DeleteFacesCommand({
        CollectionId: this.coleccion,
        FaceIds: [faceId],
      }),
    );
  }
}

/** Rekognition responde `InvalidParameterException` cuando la imagen no tiene un rostro detectable. */
const sinRostro = (error: unknown) =>
  (error as { name?: string } | null)?.name === 'InvalidParameterException';
