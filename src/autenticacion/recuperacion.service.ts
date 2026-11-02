import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import {
  AuditoriaService,
  type EventoAuditoria,
} from '../auditoria/auditoria.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService } from '../comun/prisma.service.js';
import { esContrasenaSegura } from '../comun/validaciones.js';
import { CorreosService } from '../notificaciones/correos.service.js';
import { AutenticacionService } from './autenticacion.service.js';
import { OtpService } from './otp.service.js';
import { normalizar } from './registro.service.js';

const dominioDe = (correo: string) => correo.slice(correo.lastIndexOf('@') + 1);

/** Recuperación de contraseña con el código de HU-05, propósito `recuperacion` (HU-34). */
@Injectable()
export class RecuperacionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly autenticacion: AutenticacionService,
    private readonly correos: CorreosService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * CA-1: con cuenta, el código va por la cola. CA-2: sin cuenta queda una fila señuelo que no envía nada
   * y nunca valida, para que respuesta, límites y bloqueo sean los mismos (RN-4).
   */
  async solicitar(correoRecibido: string): Promise<{ reenviarEn: Date }> {
    const correo = normalizar(correoRecibido);
    const cuenta = await this.prisma.usuario.findFirst({
      where: { correo: { equals: correo, mode: 'insensitive' } },
      select: { id: true },
    });
    // RN-6: solo el dominio; el correo de quien no tiene cuenta no se guarda.
    const evento = {
      accion: 'recuperacion.solicitud',
      entidad: 'usuario',
      entidadId: cuenta?.id,
      actorId: cuenta?.id,
      detalle: { dominio: dominioDe(correo), conCuenta: Boolean(cuenta) },
    };
    try {
      const r = await this.otp.generar(
        correo,
        'recuperacion',
        cuenta ? { usuarioId: cuenta.id } : { senuelo: true },
      );
      await this.auditoria.registrar({ ...evento, resultado: 'ok' });
      return r;
    } catch (error) {
      await this.auditarFallo(evento, error);
      throw error;
    }
  }

  /** CA-3: en una transacción consume el código, cambia el hash, cierra todas las sesiones, audita y encola el aviso. */
  async restablecer(
    correoRecibido: string,
    codigo: string,
    contrasenaNueva: string,
  ): Promise<void> {
    const correo = normalizar(correoRecibido);
    const evento = {
      accion: 'recuperacion.cambio',
      entidad: 'usuario',
      detalle: { dominio: dominioDe(correo) },
    };
    try {
      // CA-6: antes de tocar el código, para no gastarlo.
      if (!esContrasenaSegura(contrasenaNueva))
        throw new ErrorNegocio(
          400,
          'CONTRASENA_DEBIL',
          'autenticacion.registro.contrasena_debil',
        );
      // Fuera de la transacción y con o sin cuenta: el tiempo no la delata.
      const hashContrasena = await bcrypt.hash(contrasenaNueva, 12);
      await this.prisma.$transaction(async (tx) => {
        const { usuarioId } = (await this.otp.verificar(
          tx,
          correo,
          'recuperacion',
          codigo,
        )) as { usuarioId: string };
        // También levanta el bloqueo de inicio de sesión (HU-06).
        await tx.usuario.update({
          where: { id: usuarioId },
          data: { hashContrasena, intentosFallidos: 0, bloqueadoHasta: null },
        });
        // RN-3: todas las sesiones de la cuenta; RN-5: dispositivos y billetera no se tocan.
        await this.autenticacion.revocarTodas(usuarioId, tx);
        await this.auditoria.registrar(
          {
            ...evento,
            entidadId: usuarioId,
            actorId: usuarioId,
            resultado: 'ok',
          },
          tx,
        );
        await this.correos.encolar(tx, {
          destinatario: correo,
          plantilla: 'contrasena_cambiada',
          datos: {},
        });
      });
    } catch (error) {
      await this.auditarFallo(evento, error);
      throw error;
    }
  }

  /** RN-6: el intento fallido queda con su motivo (el `codigo` del error). */
  private async auditarFallo(
    evento: Omit<EventoAuditoria, 'resultado'>,
    error: unknown,
  ): Promise<void> {
    if (!(error instanceof ErrorNegocio)) return;
    await this.auditoria.registrar({
      ...evento,
      resultado: 'fallo',
      detalle: { ...evento.detalle, motivo: error.codigo },
    });
  }
}
