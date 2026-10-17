import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService } from '../comun/prisma.service.js';

const MAX_INTENTOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;
// Hash ficticio: se compara igual si el correo no existe, para que el tiempo no lo delate (RN-4).
const HASH_FICTICIO = bcrypt.hashSync('contrasena-ficticia', 12);

export type TipoCliente = 'movil' | 'web';
export interface Sesion {
  tokenAcceso: string;
  tokenRefresco: string;
}

const hashDe = (token: string) =>
  createHash('sha256').update(token).digest('hex');
const diasDe = (valor: string | undefined, porDefecto: number) =>
  parseInt(valor ?? '', 10) || porDefecto;

@Injectable()
export class AutenticacionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async iniciarSesion(
    correo: string,
    contrasena: string,
    tipoCliente: TipoCliente,
  ): Promise<Sesion> {
    const usuario = await this.prisma.usuario.findFirst({
      where: { correo: { equals: correo.trim(), mode: 'insensitive' } },
    });
    const ahora = new Date();
    if (usuario?.bloqueadoHasta && usuario.bloqueadoHasta > ahora) {
      await this.auditoria.registrar({
        accion: 'sesion.inicio',
        entidad: 'usuario',
        entidadId: usuario.id,
        resultado: 'fallo',
        actorId: usuario.id,
        detalle: { motivo: 'bloqueada' },
      });
      throw new ErrorNegocio(
        429,
        'SESION_BLOQUEADA',
        'autenticacion.sesion.bloqueada',
        {
          reintentarEn: usuario.bloqueadoHasta.toISOString(),
        },
      );
    }
    const correcta = await bcrypt.compare(
      contrasena,
      usuario?.hashContrasena ?? HASH_FICTICIO,
    );
    if (!usuario || !correcta) {
      if (usuario) await this.registrarFallo(usuario.id);
      throw new ErrorNegocio(
        401,
        'CREDENCIALES_INVALIDAS',
        'autenticacion.sesion.credenciales_invalidas',
      );
    }
    await this.prisma.usuario.update({
      where: { id: usuario.id },
      data: { intentosFallidos: 0, bloqueadoHasta: null },
    });
    const dias =
      tipoCliente === 'movil'
        ? diasDe(process.env.JWT_REFRESCO_DURACION_MOVIL, 30)
        : diasDe(process.env.JWT_REFRESCO_DURACION_WEB, 7);
    await this.auditoria.registrar({
      accion: 'sesion.inicio',
      entidad: 'usuario',
      entidadId: usuario.id,
      resultado: 'ok',
      actorId: usuario.id,
      detalle: { tipoCliente },
    });
    return this.emitir(
      usuario.id,
      usuario.ultimaOrganizacionId,
      tipoCliente,
      new Date(ahora.getTime() + dias * DIA_MS),
    );
  }

  async refrescar(
    tokenRefresco: string,
  ): Promise<{ sesion: Sesion; tipoCliente: TipoCliente }> {
    const fila = await this.prisma.tokenRefresco.findUnique({
      where: { hashToken: hashDe(tokenRefresco) },
    });
    if (!fila) throw this.sesionExpirada();
    const tipoCliente = fila.tipoCliente as TipoCliente;
    // Rotación: solo el primero que revoque el token gana; cualquier reuso cierra todas las sesiones (CA-5).
    const { count } = await this.prisma.tokenRefresco.updateMany({
      where: { id: fila.id, revocadoEn: null },
      data: { revocadoEn: new Date() },
    });
    if (count === 0) {
      await this.revocarTodas(fila.usuarioId);
      await this.auditoria.registrar({
        accion: 'sesion.reuso_refresco',
        entidad: 'usuario',
        entidadId: fila.usuarioId,
        resultado: 'fallo',
        actorId: fila.usuarioId,
      });
      throw this.sesionExpirada();
    }
    if (fila.sesionVenceEn <= new Date()) throw this.sesionExpirada();
    const usuario = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: fila.usuarioId },
    });
    return {
      sesion: await this.emitir(
        usuario.id,
        usuario.ultimaOrganizacionId,
        tipoCliente,
        fila.sesionVenceEn,
      ),
      tipoCliente,
    };
  }

  /** Con token de refresco revoca esa sesión; sin él, todas las del usuario. */
  async cerrarSesion(usuarioId: string, tokenRefresco?: string): Promise<void> {
    if (tokenRefresco) {
      await this.prisma.tokenRefresco.updateMany({
        where: {
          hashToken: hashDe(tokenRefresco),
          usuarioId,
          revocadoEn: null,
        },
        data: { revocadoEn: new Date() },
      });
    } else {
      await this.revocarTodas(usuarioId);
    }
    await this.auditoria.registrar({
      accion: 'sesion.cierre',
      entidad: 'usuario',
      entidadId: usuarioId,
      resultado: 'ok',
      actorId: usuarioId,
    });
  }

  private async registrarFallo(usuarioId: string): Promise<void> {
    const { intentosFallidos } = await this.prisma.usuario.update({
      where: { id: usuarioId },
      data: { intentosFallidos: { increment: 1 } },
    });
    const bloquear = intentosFallidos >= MAX_INTENTOS;
    if (bloquear) {
      await this.prisma.usuario.update({
        where: { id: usuarioId },
        data: {
          intentosFallidos: 0,
          bloqueadoHasta: new Date(Date.now() + BLOQUEO_MS),
        },
      });
    }
    await this.auditoria.registrar({
      accion: bloquear ? 'sesion.bloqueo' : 'sesion.inicio',
      entidad: 'usuario',
      entidadId: usuarioId,
      resultado: 'fallo',
      actorId: usuarioId,
    });
  }

  private revocarTodas(usuarioId: string) {
    return this.prisma.tokenRefresco.updateMany({
      where: { usuarioId, revocadoEn: null },
      data: { revocadoEn: new Date() },
    });
  }

  private async emitir(
    usuarioId: string,
    org: string | null,
    cli: TipoCliente,
    sesionVenceEn: Date,
  ): Promise<Sesion> {
    const tokenRefresco = randomBytes(32).toString('base64url');
    await this.prisma.tokenRefresco.create({
      data: {
        usuarioId,
        hashToken: hashDe(tokenRefresco),
        tipoCliente: cli,
        venceEn: sesionVenceEn,
        sesionVenceEn,
      },
    });
    const tokenAcceso = await this.jwt.signAsync({ sub: usuarioId, org, cli });
    return { tokenAcceso, tokenRefresco };
  }

  private sesionExpirada() {
    return new ErrorNegocio(
      401,
      'SESION_EXPIRADA',
      'autenticacion.sesion.expirada',
    );
  }
}
