import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { MAXIMO_FOTO_BYTES } from '../vehiculos/foto.js';

export const imagenIlegible = () =>
  new ErrorNegocio(
    400,
    'IMAGEN_ILEGIBLE',
    'identidad.verificacion.imagen_ilegible',
  );

/**
 * Como `FotoInterceptor` de HU-11 (JPEG/PNG por contenido, 5 MB) pero con el campo `fotoCarnet`.
 * Pasarse del límite responde `IMAGEN_ILEGIBLE` y no 413; ese rechazo ocurre antes del servicio y no cuenta como intento.
 */
@Injectable()
export class FotoCarnetInterceptor implements NestInterceptor {
  private readonly multer = new (FileInterceptor('fotoCarnet', {
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
      if (error instanceof PayloadTooLargeException) throw imagenIlegible();
      throw error;
    }
  }
}
