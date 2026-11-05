import { HttpException } from '@nestjs/common';
import { t } from '../i18n/t.js';

/** Error con `codigo` estable; el cliente lo traduce con su es-BO. */
export class ErrorNegocio extends HttpException {
  constructor(
    estado: number,
    readonly codigo: string,
    claveMensaje: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super({ codigo, mensaje: t(claveMensaje), ...extra }, estado);
  }
}
