import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { t } from '../i18n/t.js';

/** Toda respuesta de error lleva `codigo`; nunca se filtra el detalle interno. */
@Catch()
export class FiltroErrores implements ExceptionFilter {
  private readonly registro = new Logger(FiltroErrores.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      const cuerpo = error.getResponse();
      const estado = error.getStatus();
      if (typeof cuerpo === 'object' && 'codigo' in cuerpo) {
        res.status(estado).json(cuerpo);
      } else if (estado === 400) {
        const mensajes = (cuerpo as { message?: string[] }).message;
        res.status(400).json({
          codigo: 'VALIDACION_FALLIDA',
          mensaje: t('comun.errores.validacion'),
          detalle: mensajes,
        });
      } else if (estado === 401) {
        res.status(401).json({
          codigo: 'NO_AUTENTICADO',
          mensaje: t('comun.errores.no_autenticado'),
        });
      } else {
        res
          .status(estado)
          .json({ codigo: `HTTP_${estado}`, mensaje: error.message });
      }
      return;
    }
    this.registro.error(error instanceof Error ? error.stack : String(error));
    res.status(500).json({
      codigo: 'ERROR_INTERNO',
      mensaje: t('comun.errores.interno'),
    });
  }
}
