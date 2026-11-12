import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';

export interface Almacen {
  subir(clave: string, contenido: Buffer, tipo: string): Promise<void>;
  borrar(clave: string): Promise<void>;
  descargar(clave: string): Promise<Buffer>;
}

type Cifrado = Pick<
  PutObjectCommandInput,
  'ServerSideEncryption' | 'SSEKMSKeyId'
>;

/**
 * `S3_CIFRADO`: `kms` (SSE-KMS, por defecto; en AWS), `s3` (SSE-S3) o `ninguno` (MinIO sin KMS, solo desarrollo).
 * Con `kms`, `S3_KMS_LLAVE_ID` elige la llave; vacía usa la administrada `aws/s3`.
 */
export function cifradoS3(): Cifrado {
  const modo = process.env.S3_CIFRADO || 'kms';
  if (modo === 'kms')
    return {
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: process.env.S3_KMS_LLAVE_ID || undefined,
    };
  if (modo === 's3') return { ServerSideEncryption: 'AES256' };
  if (modo === 'ninguno' && process.env.NODE_ENV !== 'production') return {};
  throw new Error(`S3_CIFRADO inválido o prohibido en este entorno: ${modo}`);
}

/** S3 en AWS; con `S3_ENDPOINT`, MinIO de desarrollo (credenciales `MINIO_ROOT_*` y el bucket se crea solo). */
class AlmacenS3 implements Almacen {
  private readonly cifrado = cifradoS3();
  private readonly bucket = process.env.S3_BUCKET_SENSIBLE;
  private readonly local = Boolean(process.env.S3_ENDPOINT);
  private readonly cliente = new S3Client({
    region: process.env.AWS_REGION,
    ...(this.local && {
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.MINIO_ROOT_USER ?? '',
        secretAccessKey: process.env.MINIO_ROOT_PASSWORD ?? '',
      },
    }),
  });
  private bucketListo?: Promise<unknown>;

  async subir(clave: string, contenido: Buffer, tipo: string): Promise<void> {
    if (this.local) await this.crearBucket();
    await this.cliente.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: clave,
        Body: contenido,
        ContentType: tipo,
        ...this.cifrado,
      }),
    );
  }

  async borrar(clave: string): Promise<void> {
    await this.cliente.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: clave }),
    );
  }

  async descargar(clave: string): Promise<Buffer> {
    const respuesta = await this.cliente.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: clave }),
    );
    if (!respuesta.Body) {
      throw new Error('Cuerpo de objeto S3 vacio');
    }
    const bytes = await respuesta.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  /** Solo MinIO: en AWS el bucket ya existe con su política. Si falla, se reintenta en la próxima subida. */
  private crearBucket(): Promise<unknown> {
    this.bucketListo ??= this.cliente
      .send(new CreateBucketCommand({ Bucket: this.bucket }))
      .catch((error: { name?: string }) => {
        if (error.name === 'BucketAlreadyOwnedByYou') return;
        this.bucketListo = undefined;
        throw error;
      });
    return this.bucketListo;
  }
}

/** Fotos sensibles (carnets, vehículos) cifradas en S3. La clave y el contenido nunca van a los logs (D-20). */
@Injectable()
export class AlmacenamientoService implements OnModuleInit {
  private readonly registro = new Logger(AlmacenamientoService.name);
  /** Reemplazable en pruebas. */
  almacen?: Almacen;

  /** Un `S3_CIFRADO` inválido detiene el arranque en vez de fallar en la primera subida. */
  onModuleInit(): void {
    this.almacen ??= new AlmacenS3();
  }

  async subir(clave: string, contenido: Buffer, tipo: string): Promise<void> {
    this.almacen ??= new AlmacenS3();
    try {
      await this.almacen.subir(clave, contenido, tipo);
    } catch (error) {
      this.registro.error(`No se pudo subir el archivo (${nombre(error)})`);
      throw error;
    }
  }

  /** Compensación: un fallo aquí deja un archivo huérfano (limpieza manual en v1), nunca un error al usuario. */
  async borrar(clave: string): Promise<void> {
    this.almacen ??= new AlmacenS3();
    try {
      await this.almacen.borrar(clave);
    } catch (error) {
      this.registro.error(
        `No se pudo borrar un archivo huérfano (${nombre(error)})`,
      );
    }
  }

  async descargar(clave: string): Promise<Buffer> {
    this.almacen ??= new AlmacenS3();
    try {
      return await this.almacen.descargar(clave);
    } catch (error) {
      this.registro.error(`No se pudo descargar el archivo (${nombre(error)})`);
      throw error;
    }
  }
}

// Solo el tipo de error: el mensaje del SDK puede incluir la clave.
const nombre = (error: unknown) =>
  (error as { name?: string } | null)?.name ?? 'Error';
