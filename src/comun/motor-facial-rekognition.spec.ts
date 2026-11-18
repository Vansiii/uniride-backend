import {
  CompareFacesCommand,
  CreateFaceLivenessSessionCommand,
  DeleteFacesCommand,
  GetFaceLivenessSessionResultsCommand,
  IndexFacesCommand,
  RekognitionClient,
  SearchFacesByImageCommand,
} from '@aws-sdk/client-rekognition';
import { MotorFacialRekognition } from './motor-facial-rekognition.js';

const COLECCION = 'coleccion-de-prueba';
const IMG = Buffer.from([0xff, 0xd8, 0xff, 1]);
const REF = Buffer.from([0xff, 0xd8, 0xff, 2]);

const sinRostro = () =>
  Object.assign(new Error('There are no faces in the image'), {
    name: 'InvalidParameterException',
  });

function crear(respuesta: unknown) {
  const enviar = vi
    .spyOn(RekognitionClient.prototype, 'send')
    .mockImplementation(async () => {
      if (respuesta instanceof Error) throw respuesta;
      return respuesta as never;
    });
  return { motor: new MotorFacialRekognition(COLECCION), enviar };
}
const comando = (enviar: ReturnType<typeof crear>['enviar']) =>
  enviar.mock.calls[0][0] as unknown as { input: Record<string, unknown> };

afterEach(() => vi.restoreAllMocks());

describe('MotorFacialRekognition', () => {
  it('crea la sesión de liveness y devuelve su id', async () => {
    const { motor, enviar } = crear({ SessionId: 'abc' });
    await expect(motor.crearSesionLiveness()).resolves.toBe('abc');
    expect(comando(enviar)).toBeInstanceOf(CreateFaceLivenessSessionCommand);
  });

  it('sin SessionId falla', async () => {
    const { motor } = crear({});
    await expect(motor.crearSesionLiveness()).rejects.toThrow();
  });

  it('lee el resultado de liveness: SUCCEEDED, confianza e imagen de referencia', async () => {
    const { motor, enviar } = crear({
      Status: 'SUCCEEDED',
      Confidence: 91.5,
      ReferenceImage: { Bytes: new Uint8Array(REF) },
    });
    const r = await motor.obtenerResultadoLiveness('s1');
    expect(r).toMatchObject({ exitosa: true, confianza: 91.5 });
    expect(r.imagenReferencia?.equals(REF)).toBe(true);
    expect(comando(enviar)).toBeInstanceOf(
      GetFaceLivenessSessionResultsCommand,
    );
    expect(comando(enviar).input).toEqual({ SessionId: 's1' });
  });

  it('cualquier estado distinto de SUCCEEDED no es exitoso', async () => {
    const { motor } = crear({ Status: 'FAILED' });
    expect(await motor.obtenerResultadoLiveness('s1')).toEqual({
      exitosa: false,
      confianza: 0,
      imagenReferencia: undefined,
    });
  });

  it('compara el carnet contra la referencia y devuelve la similitud', async () => {
    const { motor, enviar } = crear({
      SourceImageFace: {},
      FaceMatches: [{ Similarity: 97.2 }],
    });
    await expect(motor.compararRostros(REF, IMG)).resolves.toBe(97.2);
    expect(comando(enviar)).toBeInstanceOf(CompareFacesCommand);
    expect(comando(enviar).input).toMatchObject({
      SourceImage: { Bytes: IMG },
      TargetImage: { Bytes: REF },
    });
  });

  it('sin coincidencias la similitud es 0; sin rostro en el carnet, null', async () => {
    expect(
      await crear({
        SourceImageFace: {},
        FaceMatches: [],
      }).motor.compararRostros(REF, IMG),
    ).toBe(0);
    expect(await crear({}).motor.compararRostros(REF, IMG)).toBeNull();
    expect(await crear(sinRostro()).motor.compararRostros(REF, IMG)).toBeNull();
  });

  it('otros errores de CompareFaces se propagan (el servicio responde 503)', async () => {
    const { motor } = crear(new Error('ThrottlingException'));
    await expect(motor.compararRostros(REF, IMG)).rejects.toThrow();
  });

  it('busca en la colección con umbral 90 y detecta solo rostros de otra cuenta', async () => {
    const { motor, enviar } = crear({
      FaceMatches: [{ Face: { ExternalImageId: 'otro' } }],
    });
    await expect(motor.buscarRostroDuplicado(IMG, 'yo')).resolves.toBe(true);
    expect(comando(enviar)).toBeInstanceOf(SearchFacesByImageCommand);
    expect(comando(enviar).input).toMatchObject({
      CollectionId: COLECCION,
      FaceMatchThreshold: 90,
    });
    expect(
      await crear({
        FaceMatches: [{ Face: { ExternalImageId: 'yo' } }],
      }).motor.buscarRostroDuplicado(IMG, 'yo'),
    ).toBe(false);
    expect(await crear({}).motor.buscarRostroDuplicado(IMG, 'yo')).toBe(false);
    expect(
      await crear(sinRostro()).motor.buscarRostroDuplicado(IMG, 'yo'),
    ).toBe(false);
  });

  it('un error al buscar se propaga: nunca se asume "sin duplicado"', async () => {
    const { motor } = crear(new Error('AccessDeniedException'));
    await expect(motor.buscarRostroDuplicado(IMG, 'yo')).rejects.toThrow();
  });

  it('indexa con ExternalImageId = usuario y devuelve el FaceId', async () => {
    const { motor, enviar } = crear({
      FaceRecords: [{ Face: { FaceId: 'face-1' } }],
    });
    await expect(motor.indexarRostro(IMG, 'u1')).resolves.toBe('face-1');
    expect(comando(enviar)).toBeInstanceOf(IndexFacesCommand);
    expect(comando(enviar).input).toMatchObject({
      CollectionId: COLECCION,
      ExternalImageId: 'u1',
      MaxFaces: 1,
    });
  });

  it('si no se indexó ningún rostro, falla', async () => {
    const { motor } = crear({ FaceRecords: [] });
    await expect(motor.indexarRostro(IMG, 'u1')).rejects.toThrow();
  });

  it('desindexa por FaceId', async () => {
    const { motor, enviar } = crear({});
    await motor.desindexarRostro('face-1');
    expect(comando(enviar)).toBeInstanceOf(DeleteFacesCommand);
    expect(comando(enviar).input).toEqual({
      CollectionId: COLECCION,
      FaceIds: ['face-1'],
    });
  });
});
