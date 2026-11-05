import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ErrorNegocio } from '../comun/error-negocio.js';

export const MAXIMO_FOTO_BYTES = 5 * 1024 * 1024;
export const TIPOS_FOTO = ['image/jpeg', 'image/png'] as const;
export type TipoFoto = (typeof TIPOS_FOTO)[number];

/** Lo que deja Multer (almacenamiento en memoria) en `@UploadedFile()`. */
export interface FotoSubida {
  buffer: Buffer;
  size: number;
}

export const fotoInvalida = () =>
  new ErrorNegocio(
    400,
    'VEHICULO_FOTO_INVALIDA',
    'vehiculos.registro.foto_invalida',
    { maximoBytes: MAXIMO_FOTO_BYTES, tipos: TIPOS_FOTO },
  );

const FIRMAS: [TipoFoto, Buffer][] = [
  ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff])],
  ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
];

/** Tipo por los primeros bytes, no por la extensión ni el `Content-Type` que manda el cliente. */
export const tipoDeImagen = (contenido: Buffer): TipoFoto | null =>
  FIRMAS.find(([, firma]) =>
    contenido.subarray(0, firma.length).equals(firma),
  )?.[0] ?? null;

/** Multer en memoria con el límite de 5 MB; pasarse del límite responde `VEHICULO_FOTO_INVALIDA` y no 413. */
@Injectable()
export class FotoInterceptor implements NestInterceptor {
  private readonly multer = new (FileInterceptor('foto', {
    limits: {
      fileSize: MAXIMO_FOTO_BYTES,
      files: 1,
      fields: 10,
      fieldSize: 1024,
    },
  }))();

  async intercept(contexto: ExecutionContext, siguiente: CallHandler) {
    try {
      return await this.multer.intercept(contexto, siguiente);
    } catch (error) {
      if (error instanceof PayloadTooLargeException) throw fotoInvalida();
      throw error;
    }
  }
}
