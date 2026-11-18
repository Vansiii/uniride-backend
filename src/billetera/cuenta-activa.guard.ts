import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { UsuarioToken } from '../comun/decoradores.js';
import { BilleteraService } from './billetera.service.js';

/** Spec §4: 403 `CUENTA_SUSPENDIDA`. Va después del `JwtGuard` global y antes de identidad y firma. */
@Injectable()
export class CuentaActivaGuard implements CanActivate {
  constructor(private readonly servicio: BilleteraService) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const usuario: UsuarioToken = contexto.switchToHttp().getRequest().usuario;
    await this.servicio.exigirCuentaActiva(usuario.id);
    return true;
  }
}
