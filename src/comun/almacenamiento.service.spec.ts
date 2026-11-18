import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import { AlmacenamientoService, cifradoS3 } from './almacenamiento.service.js';

const VARIABLES = [
  'S3_CIFRADO',
  'S3_KMS_LLAVE_ID',
  'S3_ENDPOINT',
  'S3_BUCKET_SENSIBLE',
  'NODE_ENV',
];
const CLAVE = 'vehiculos/0f0e0d0c-0b0a-4908-8706-050403020100';

describe('cifradoS3', () => {
  const antes = Object.fromEntries(VARIABLES.map((v) => [v, process.env[v]]));
  afterEach(() => {
    for (const [v, valor] of Object.entries(antes))
      if (valor === undefined) delete process.env[v];
      else process.env[v] = valor;
  });

  it('por defecto SSE-KMS; con S3_KMS_LLAVE_ID usa esa llave', () => {
    delete process.env.S3_CIFRADO;
    delete process.env.S3_KMS_LLAVE_ID;
    expect(cifradoS3()).toEqual({
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: undefined,
    });
    process.env.S3_CIFRADO = 'kms';
    process.env.S3_KMS_LLAVE_ID = 'alias/uniride-fotos';
    expect(cifradoS3()).toEqual({
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'alias/uniride-fotos',
    });
  });

  it('`s3` es SSE-S3; `ninguno` (MinIO sin KMS) solo fuera de producción', () => {
    process.env.S3_CIFRADO = 's3';
    expect(cifradoS3()).toEqual({ ServerSideEncryption: 'AES256' });
    process.env.S3_CIFRADO = 'ninguno';
    process.env.NODE_ENV = 'development';
    expect(cifradoS3()).toEqual({});
    process.env.NODE_ENV = 'production';
    expect(() => cifradoS3()).toThrow(/S3_CIFRADO/);
  });

  it('un valor desconocido no se interpreta como "sin cifrado"', () => {
    process.env.S3_CIFRADO = 'aes';
    expect(() => cifradoS3()).toThrow(/S3_CIFRADO/);
  });
});

describe('AlmacenamientoService con S3', () => {
  const antes = Object.fromEntries(VARIABLES.map((v) => [v, process.env[v]]));
  let enviar: ReturnType<typeof vi.spyOn>;
  let errores: string[];

  beforeEach(() => {
    process.env.S3_BUCKET_SENSIBLE = 'uniride-sensible';
    process.env.S3_CIFRADO = 'kms';
    process.env.S3_KMS_LLAVE_ID = 'alias/uniride-fotos';
    delete process.env.S3_ENDPOINT;
    enviar = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({} as never);
    errores = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => {
      errores.push(String(m));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [v, valor] of Object.entries(antes))
      if (valor === undefined) delete process.env[v];
      else process.env[v] = valor;
  });
  const crear = () => {
    const s = new AlmacenamientoService();
    s.onModuleInit();
    return s;
  };
  const comandos = () => enviar.mock.calls.map(([c]) => c);

  it('AWS: sube con SSE-KMS al bucket sensible, sin crear el bucket', async () => {
    await crear().subir(CLAVE, Buffer.from('x'), 'image/jpeg');
    const [put] = comandos();
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({
      Bucket: 'uniride-sensible',
      Key: CLAVE,
      ContentType: 'image/jpeg',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'alias/uniride-fotos',
    });
    expect(comandos()).toHaveLength(1);
  });

  it('MinIO: crea el bucket una sola vez, aunque ya exista', async () => {
    process.env.S3_ENDPOINT = 'http://localhost:9000';
    process.env.S3_CIFRADO = 'ninguno';
    enviar.mockImplementation(async (c: unknown) => {
      if (c instanceof CreateBucketCommand)
        throw Object.assign(new Error('ya existe'), {
          name: 'BucketAlreadyOwnedByYou',
        });
      return {};
    });
    const s = crear();
    await s.subir(CLAVE, Buffer.from('x'), 'image/png');
    await s.subir(CLAVE, Buffer.from('y'), 'image/png');
    expect(comandos().map((c) => c.constructor)).toEqual([
      CreateBucketCommand,
      PutObjectCommand,
      PutObjectCommand,
    ]);
    expect(comandos()[1].input).not.toHaveProperty('ServerSideEncryption');
  });

  it('MinIO: si crear el bucket falla, la subida falla y se reintenta la próxima vez', async () => {
    process.env.S3_ENDPOINT = 'http://localhost:9000';
    enviar.mockRejectedValueOnce(
      Object.assign(new Error(`sin conexión ${CLAVE}`), {
        name: 'TimeoutError',
      }),
    );
    const s = crear();
    await expect(
      s.subir(CLAVE, Buffer.from('x'), 'image/png'),
    ).rejects.toThrow();
    await s.subir(CLAVE, Buffer.from('x'), 'image/png');
    expect(comandos().map((c) => c.constructor)).toEqual([
      CreateBucketCommand,
      CreateBucketCommand,
      PutObjectCommand,
    ]);
  });

  it('D-20: los errores se registran solo con su tipo, nunca con la clave', async () => {
    enviar.mockRejectedValue(
      Object.assign(new Error(`AccessDenied para ${CLAVE}`), {
        name: 'AccessDenied',
      }),
    );
    const s = crear();
    await expect(
      s.subir(CLAVE, Buffer.from('x'), 'image/jpeg'),
    ).rejects.toThrow();
    // Compensación: borrar que falla no lanza.
    await expect(s.borrar(CLAVE)).resolves.toBeUndefined();
    expect(comandos()[1]).toBeInstanceOf(DeleteObjectCommand);
    expect(comandos()[1].input).toEqual({
      Bucket: 'uniride-sensible',
      Key: CLAVE,
    });
    expect(errores).toEqual([
      'No se pudo subir el archivo (AccessDenied)',
      'No se pudo borrar un archivo huérfano (AccessDenied)',
    ]);
  });

  it('descargar: devuelve el buffer del objeto S3', async () => {
    enviar.mockResolvedValueOnce({
      Body: {
        transformToByteArray: async () => new Uint8Array([1, 2, 3]),
      },
    } as never);
    const s = crear();
    const res = await s.descargar(CLAVE);
    expect(res).toEqual(Buffer.from([1, 2, 3]));
    const [get] = comandos();
    expect(get).toBeInstanceOf(GetObjectCommand);
    expect(get.input).toEqual({
      Bucket: 'uniride-sensible',
      Key: CLAVE,
    });
  });

  it('un S3_CIFRADO inválido detiene el arranque', () => {
    process.env.S3_CIFRADO = 'aes';
    expect(() => crear()).toThrow(/S3_CIFRADO/);
  });
});
