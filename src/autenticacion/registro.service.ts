import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService } from '../comun/prisma.service.js';
import { esContrasenaSegura } from '../comun/validaciones.js';
import { AutenticacionService, type Sesion } from './autenticacion.service.js';
import type { RegistroDto } from './dto/registro.dto.js';
import { OtpService, type PropositoOtp } from './otp.service.js';

/** Lo que espera la confirmación: nunca la contraseña, solo su hash (RN-6). */
interface DatosRegistro {
  nombreCompleto: string;
  hashContrasena: string;
  organizacionId: string;
  consentimientoEn: string;
}

export const noAfiliada = () =>
  new ErrorNegocio(
    422,
    'ORGANIZACION_NO_AFILIADA',
    'autenticacion.registro.organizacion_no_afiliada',
  );

export const normalizar = (correo: string) => correo.trim().toLowerCase();

/** Organización activa dueña del dominio del correo, o `null` (HU-05; la reutiliza HU-07). */
export async function organizacionDelCorreo(
  prisma: PrismaService,
  correo: string,
): Promise<string | null> {
  const dominio = correo.slice(correo.lastIndexOf('@') + 1);
  const [fila] = await prisma.$queryRaw<{ id: string | null }[]>`
    SELECT organizacion_por_dominio(${dominio}) AS id`;
  return fila?.id ?? null;
}

@Injectable()
export class RegistroService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly autenticacion: AutenticacionService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /** CA-1: valida y envía el código. Nada se crea hasta confirmarlo (RN-8). */
  async registrar(dto: RegistroDto): Promise<{ reenviarEn: Date }> {
    if (dto.aceptaTratamientoDatos !== true)
      throw new ErrorNegocio(
        400,
        'CONSENTIMIENTO_REQUERIDO',
        'autenticacion.registro.consentimiento_requerido',
      );
    if (!esContrasenaSegura(dto.contrasena))
      throw new ErrorNegocio(
        400,
        'CONTRASENA_DEBIL',
        'autenticacion.registro.contrasena_debil',
      );
    const correo = normalizar(dto.correo);
    // CA-8 (A-13): la organización sale solo del dominio; `dto.organizacionId` jamás se lee.
    const organizacionId = await organizacionDelCorreo(this.prisma, correo);
    if (!organizacionId) throw noAfiliada();
    // El hash se calcula también si la cuenta existe: el tiempo de respuesta no la delata (CA-7).
    const hashContrasena = await bcrypt.hash(dto.contrasena, 12);
    const cuenta = await this.prisma.usuario.findFirst({
      where: { correo: { equals: correo, mode: 'insensitive' } },
    });
    // CA-7: cuenta existente → aviso en vez de código, con la misma respuesta y los mismos límites.
    const datos = cuenta
      ? { aviso: 'ya_tienes_cuenta' }
      : {
          nombreCompleto: dto.nombreCompleto,
          hashContrasena,
          organizacionId,
          consentimientoEn: new Date().toISOString(),
        };
    return this.otp.generar(correo, 'registro', datos);
  }

  /** También sirve al código de agregar organización (HU-07): la app reutiliza la pantalla Código. */
  reenviar(correo: string, proposito: PropositoOtp = 'registro') {
    return this.otp.reenviar(normalizar(correo), proposito);
  }

  /** CA-2: en una transacción consume el código y crea la cuenta y la membresía según el modo de la organización. */
  async verificar(
    correoRecibido: string,
    codigo: string,
  ): Promise<Sesion & { estadoMembresia: 'aprobada' | 'pendiente' }> {
    const correo = normalizar(correoRecibido);
    const alta = await this.prisma.$transaction(async (tx) => {
      const datos = (await this.otp.verificar(
        tx,
        correo,
        'registro',
        codigo,
      )) as unknown as DatosRegistro;
      await this.prisma.fijarOrganizacion(tx, datos.organizacionId);
      const org = await tx.organizacion.findUnique({
        where: { id: datos.organizacionId },
      });
      // Suspendida entre el envío y la confirmación: se revierte y el código sigue sin usar.
      if (org?.estado !== 'activa') throw noAfiliada();
      const estado: 'aprobada' | 'pendiente' =
        org.modoAprobacion === 'automatica' ? 'aprobada' : 'pendiente';
      const ahora = new Date();
      const usuario = await tx.usuario.create({
        data: {
          correo,
          hashContrasena: datos.hashContrasena,
          nombreCompleto: datos.nombreCompleto,
          consentimientoDatosEn: new Date(datos.consentimientoEn),
          ultimaOrganizacionId: estado === 'aprobada' ? org.id : null,
        },
      });
      await tx.membresia.create({
        data: {
          organizacionId: org.id,
          usuarioId: usuario.id,
          rol: 'miembro',
          estado,
          correoInstitucional: correo,
          decididoEn: estado === 'aprobada' ? ahora : null,
        },
      });
      await this.auditoria.registrar(
        {
          accion: 'registro.alta',
          entidad: 'usuario',
          entidadId: usuario.id,
          resultado: 'ok',
          actorId: usuario.id,
          organizacionId: org.id,
          detalle: { estadoMembresia: estado },
        },
        tx,
      );
      return { usuarioId: usuario.id, organizacionId: org.id, estado };
    });
    // La sesión se abre ya: un paso menos para la persona. Solo con membresía aprobada lleva organización activa.
    const sesion = await this.autenticacion.abrirSesion(
      alta.usuarioId,
      alta.estado === 'aprobada' ? alta.organizacionId : null,
      'movil',
    );
    return { ...sesion, estadoMembresia: alta.estado };
  }
}
