import { MotorFacialRekognition } from './motor-facial-rekognition.js';
import { MotorFacialSimulado } from './motor-facial-simulado.js';
import { RekognitionService } from './rekognition.service.js';

afterEach(() => vi.unstubAllEnvs());

describe('RekognitionService', () => {
  it('REKOGNITION_SIMULADO=true usa el motor simulado', () => {
    vi.stubEnv('REKOGNITION_SIMULADO', 'true');
    vi.stubEnv('NODE_ENV', 'development');
    expect(new RekognitionService().motor).toBeInstanceOf(MotorFacialSimulado);
  });

  it('sin la bandera usa Rekognition con la colección configurada', () => {
    vi.stubEnv('REKOGNITION_SIMULADO', '');
    vi.stubEnv('REKOGNITION_COLECCION_ROSTROS', 'uniride-rostros-prueba');
    expect(new RekognitionService().motor).toBeInstanceOf(
      MotorFacialRekognition,
    );
  });

  it('sin colección ni bandera falla claro', () => {
    vi.stubEnv('REKOGNITION_SIMULADO', '');
    vi.stubEnv('REKOGNITION_COLECCION_ROSTROS', '');
    expect(() => new RekognitionService().motor).toThrow(
      'REKOGNITION_COLECCION_ROSTROS',
    );
  });

  it('REKOGNITION_SIMULADO=true en producción detiene el arranque (A-01)', () => {
    vi.stubEnv('REKOGNITION_SIMULADO', 'true');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => new RekognitionService().onModuleInit()).toThrow(
      'prohibido en producción',
    );
  });

  it('en producción también falla el primer uso, no solo el arranque', () => {
    vi.stubEnv('REKOGNITION_SIMULADO', 'true');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => new RekognitionService().motor).toThrow();
  });

  it('en producción sin bandera arranca con Rekognition real', () => {
    vi.stubEnv('REKOGNITION_SIMULADO', 'false');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('REKOGNITION_COLECCION_ROSTROS', 'uniride-rostros-prueba');
    const servicio = new RekognitionService();
    expect(() => servicio.onModuleInit()).not.toThrow();
    expect(servicio.motor).toBeInstanceOf(MotorFacialRekognition);
  });

  it('el motor se puede reemplazar en pruebas', () => {
    const servicio = new RekognitionService();
    const falso = new MotorFacialSimulado();
    servicio.motor = falso;
    expect(servicio.motor).toBe(falso);
  });
});
