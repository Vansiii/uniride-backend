import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ErrorNegocio } from './error-negocio.js';
import { ES_PUBLICO } from './decoradores.js';

const sinAutenticar = () =>
  new ErrorNegocio(401, 'NO_AUTENTICADO', 'comun.errores.no_autenticado');

/** Guard global: todo endpoint exige token de acceso salvo los marcados `@Publico()`. */
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const publico = this.reflector.getAllAndOverride<boolean>(ES_PUBLICO, [
      contexto.getHandler(),
      contexto.getClass(),
    ]);
    if (publico) return true;
    const peticion = contexto.switchToHttp().getRequest();
    const [tipo, token] = (peticion.headers.authorization ?? '').split(' ');
    if (tipo !== 'Bearer' || !token) throw sinAutenticar();
    try {
      const { sub, org, cli } = await this.jwt.verifyAsync(token);
      peticion.usuario = { id: sub, org: org ?? null, cli };
      return true;
    } catch {
      throw sinAutenticar();
    }
  }
}
