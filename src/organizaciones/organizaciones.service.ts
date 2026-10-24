import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService, type Transaccion } from '../comun/prisma.service.js';
import { CorreosService } from '../notificaciones/correos.service.js';
import type { CrearOrganizacionDto } from './dto/organizacion.dto.js';

const VIGENCIA_INVITACION_MS = 72 * 60 * 60 * 1000;

const hashDe = (token: string) =>
  createHash('sha256').update(token).digest('hex');

const noEncontrada = () =>
  new ErrorNegocio(404, 'NO_ENCONTRADO', 'comun.errores.no_encontrado');

const invitacionVencida = () =>
  new ErrorNegocio(
    410,
    'INVITACION_VENCIDA',
    'organizaciones.invitacion.vencida',
  );

@Injectable()
export class OrganizacionesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly correos: CorreosService,
  ) {}

  async crear(actorId: string, dto: CrearOrganizacionDto) {
    const nombre = dto.nombre.trim();
    try {
      // Una sola transacción: organización, invitación, correo en cola y auditoría, o nada.
      return await this.prisma.comoSuperAdmin(async (tx) => {
        const org = await tx.organizacion.create({
          data: {
            nombre,
            nombreNormalizado: nombre.toLowerCase(),
            tipo: dto.tipo,
            precioMaximoUrc: dto.precioMaximoUrc,
          },
        });
        await this.invitar(
          tx,
          org.id,
          org.nombre,
          dto.adminCorreo,
          dto.adminNombre,
          actorId,
        );
        await this.auditoria.registrar(
          {
            accion: 'organizacion.alta',
            entidad: 'organizacion',
            entidadId: org.id,
            resultado: 'ok',
            actorId,
            organizacionId: org.id,
            detalle: { tipo: org.tipo },
          },
          tx,
        );
        return {
          id: org.id,
          nombre: org.nombre,
          tipo: org.tipo,
          estado: org.estado,
          precioMaximoUrc: Number(org.precioMaximoUrc),
          creadoEn: org.creadoEn,
        };
      });
    } catch (error) {
      // Choque con UNIQUE(nombre_normalizado): cubre mayúsculas, espacios y altas simultáneas.
      if ((error as { code?: string }).code === 'P2002') {
        await this.auditoria.registrar({
          accion: 'organizacion.alta',
          entidad: 'organizacion',
          resultado: 'fallo',
          actorId,
          detalle: { motivo: 'nombre_duplicado' },
        });
        throw new ErrorNegocio(
          409,
          'ORGANIZACION_NOMBRE_DUPLICADO',
          'organizaciones.alta.nombre_duplicado',
        );
      }
      throw error;
    }
  }

  listar() {
    return this.prisma.comoSuperAdmin(async (tx) => {
      const orgs = await tx.organizacion.findMany({
        orderBy: { creadoEn: 'desc' },
        include: {
          invitaciones: { orderBy: { creadoEn: 'desc' }, take: 1 },
        },
      });
      const ids = orgs.flatMap((o) => o.invitaciones.map((i) => i.id));
      const correos = await tx.correoSaliente.findMany({
        where: { referenciaTipo: 'invitacion', referenciaId: { in: ids } },
      });
      const ahora = new Date();
      return orgs.map((o) => {
        const inv = o.invitaciones[0];
        const correo = correos.find((c) => c.referenciaId === inv?.id);
        let estadoInvitacion = 'pendiente';
        if (inv?.usadaEn) estadoInvitacion = 'aceptada';
        else if (inv && inv.venceEn <= ahora) estadoInvitacion = 'vencida';
        else if (correo?.estado === 'enviado') estadoInvitacion = 'enviada';
        else if (correo && (correo.estado === 'fallido' || correo.intentos > 0))
          estadoInvitacion = 'no_enviada';
        return {
          id: o.id,
          nombre: o.nombre,
          tipo: o.tipo,
          estado: o.estado,
          precioMaximoUrc: Number(o.precioMaximoUrc),
          admin: inv ? { nombre: inv.nombre, correo: inv.correo } : null,
          estadoInvitacion,
          creadoEn: o.creadoEn,
        };
      });
    });
  }

  /** Invalida la invitación vigente y envía una nueva con el mismo administrador. */
  async reenviar(organizacionId: string, actorId: string): Promise<void> {
    await this.prisma.comoSuperAdmin(async (tx) => {
      const org = await tx.organizacion.findUnique({
        where: { id: organizacionId },
      });
      const ultima = await tx.invitacion.findFirst({
        where: { organizacionId },
        orderBy: { creadoEn: 'desc' },
      });
      if (!org || !ultima) throw noEncontrada();
      if (ultima.usadaEn)
        throw new ErrorNegocio(
          409,
          'INVITACION_YA_ACEPTADA',
          'organizaciones.invitacion.ya_aceptada',
        );
      await this.invitar(
        tx,
        org.id,
        org.nombre,
        ultima.correo,
        ultima.nombre,
        actorId,
      );
      await this.auditoria.registrar(
        {
          accion: 'invitacion.reenvio',
          entidad: 'organizacion',
          entidadId: org.id,
          resultado: 'ok',
          actorId,
          organizacionId: org.id,
        },
        tx,
      );
    });
  }

  /** Datos públicos de una invitación vigente; cualquier otro caso es el mismo 410, sin revelar si el token existió. */
  consultar(token: string) {
    return this.prisma.comoSuperAdmin(async (tx) => {
      const inv = await this.vigente(tx, token);
      const cuenta = await this.cuentaDe(tx, inv.correo);
      const org = await tx.organizacion.findUniqueOrThrow({
        where: { id: inv.organizacionId },
      });
      return {
        organizacion: org.nombre,
        correo: inv.correo,
        nombre: inv.nombre,
        cuentaExistente: !!cuenta,
      };
    });
  }

  /** Consume la invitación (un solo uso) y deja al administrador asociado solo a esa organización. */
  aceptar(
    token: string,
    nombreCompleto: string | undefined,
    contrasena: string,
  ) {
    return this.prisma.comoSuperAdmin(async (tx) => {
      const inv = await this.vigente(tx, token);
      // El update condicional es el candado: de dos aceptaciones simultáneas, solo una cuenta.
      const { count } = await tx.invitacion.updateMany({
        where: { id: inv.id, usadaEn: null, reemplazadaEn: null },
        data: { usadaEn: new Date() },
      });
      if (count === 0) throw invitacionVencida();

      let usuario = await this.cuentaDe(tx, inv.correo);
      if (usuario) {
        // RN-7: cuenta existente, se suma el rol; la contraseña prueba que es la misma persona.
        if (!(await bcrypt.compare(contrasena, usuario.hashContrasena)))
          throw new ErrorNegocio(
            401,
            'CREDENCIALES_INVALIDAS',
            'autenticacion.sesion.credenciales_invalidas',
          );
      } else {
        if (!/^(?=.*[A-Za-z])(?=.*\d).{8,72}$/.test(contrasena))
          throw new ErrorNegocio(
            400,
            'CONTRASENA_DEBIL',
            'organizaciones.invitacion.contrasena_debil',
          );
        usuario = await tx.usuario.create({
          data: {
            correo: inv.correo,
            hashContrasena: await bcrypt.hash(contrasena, 12),
            nombreCompleto: nombreCompleto?.trim() || inv.nombre,
          },
        });
      }
      await tx.membresia.create({
        data: {
          organizacionId: inv.organizacionId,
          usuarioId: usuario.id,
          rol: 'admin_organizacion',
          estado: 'aprobada',
          decididoPor: inv.creadoPor,
          decididoEn: new Date(),
        },
      });
      await tx.usuario.update({
        where: { id: usuario.id },
        data: { ultimaOrganizacionId: inv.organizacionId },
      });
      await this.auditoria.registrar(
        {
          accion: 'invitacion.aceptacion',
          entidad: 'organizacion',
          entidadId: inv.organizacionId,
          resultado: 'ok',
          actorId: usuario.id,
          organizacionId: inv.organizacionId,
        },
        tx,
      );
      return { usuarioId: usuario.id, organizacionId: inv.organizacionId };
    });
  }

  private cuentaDe(tx: Transaccion, correo: string) {
    return tx.usuario.findFirst({
      where: { correo: { equals: correo, mode: 'insensitive' } },
    });
  }

  private async vigente(tx: Transaccion, token: string) {
    const inv = await tx.invitacion.findUnique({
      where: { hashToken: hashDe(token) },
    });
    if (!inv || inv.usadaEn || inv.reemplazadaEn || inv.venceEn <= new Date())
      throw invitacionVencida();
    return inv;
  }

  /** Crea la invitación (invalidando las anteriores) y encola su correo. */
  private async invitar(
    tx: Transaccion,
    organizacionId: string,
    organizacion: string,
    correo: string,
    nombre: string,
    creadoPor: string,
  ): Promise<void> {
    await tx.invitacion.updateMany({
      where: { organizacionId, usadaEn: null, reemplazadaEn: null },
      data: { reemplazadaEn: new Date() },
    });
    const token = randomBytes(32).toString('base64url');
    const inv = await tx.invitacion.create({
      data: {
        organizacionId,
        correo: correo.trim().toLowerCase(),
        nombre,
        hashToken: hashDe(token),
        venceEn: new Date(Date.now() + VIGENCIA_INVITACION_MS),
        creadoPor,
      },
    });
    const base = process.env.WEB_URL ?? 'http://localhost:5173';
    await this.correos.encolar(tx, {
      destinatario: inv.correo,
      plantilla: 'invitacion_admin',
      datos: { nombre, organizacion, enlace: `${base}/invitaciones/${token}` },
      referenciaTipo: 'invitacion',
      referenciaId: inv.id,
    });
  }
}
