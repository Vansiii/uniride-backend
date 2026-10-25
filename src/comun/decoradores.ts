import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';

export const ES_PUBLICO = 'esPublico';
/** Marca un endpoint como accesible sin token de acceso. */
export const Publico = () => SetMetadata(ES_PUBLICO, true);

export interface UsuarioToken {
  id: string;
  org: string | null;
  cli: 'movil' | 'web';
}

export const UsuarioActual = createParamDecorator(
  (_: unknown, contexto: ExecutionContext): UsuarioToken =>
    contexto.switchToHttp().getRequest().usuario,
);

/** Organización activa ya validada por `OrganizacionGuard`. */
export const OrganizacionActual = createParamDecorator(
  (_: unknown, contexto: ExecutionContext): string =>
    contexto.switchToHttp().getRequest().organizacionId,
);
