import {
  BadRequestException,
  PayloadTooLargeException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { of } from 'rxjs';
import { FotoInterceptor, MAXIMO_FOTO_BYTES, tipoDeImagen } from './foto.js';

describe('tipoDeImagen', () => {
  it('reconoce JPEG y PNG por sus primeros bytes', () => {
    expect(tipoDeImagen(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2]))).toBe(
      'image/jpeg',
    );
    expect(
      tipoDeImagen(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
      ),
    ).toBe('image/png');
  });

  it('rechaza otros formatos, archivos vacíos o cortados', () => {
    for (const contenido of [
      Buffer.from('GIF89a'),
      Buffer.from('%PDF-1.7'),
      Buffer.from('<svg/>'),
      Buffer.alloc(0),
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    ])
      expect(tipoDeImagen(contenido)).toBeNull();
  });
});

describe('FotoInterceptor', () => {
  const contexto = {} as ExecutionContext;
  const siguiente: CallHandler = { handle: () => of('ok') };
  const conMulter = (error?: Error) => {
    const interceptor = new FotoInterceptor();
    const multer = (
      interceptor as unknown as { multer: { intercept: unknown } }
    ).multer;
    multer.intercept = vi.fn(async () => {
      if (error) throw error;
      return siguiente.handle();
    });
    return interceptor;
  };

  it('pasarse de 5 MB es VEHICULO_FOTO_INVALIDA con el límite, no 413', async () => {
    await expect(
      conMulter(new PayloadTooLargeException('File too large')).intercept(
        contexto,
        siguiente,
      ),
    ).rejects.toMatchObject({
      codigo: 'VEHICULO_FOTO_INVALIDA',
      extra: { maximoBytes: MAXIMO_FOTO_BYTES },
    });
  });

  it('los demás errores de Multer y el caso feliz pasan tal cual', async () => {
    const otro = new BadRequestException('Unexpected field');
    await expect(conMulter(otro).intercept(contexto, siguiente)).rejects.toBe(
      otro,
    );
    await expect(
      conMulter().intercept(contexto, siguiente),
    ).resolves.toBeDefined();
  });
});
