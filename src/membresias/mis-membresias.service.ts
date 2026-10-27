import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import {
  AutenticacionService,
  type TipoCliente,
} from '../autenticacion/autenticacion.service.js';
import { OtpService } from '../autenticacion/otp.service.js';
import {
  noAfiliada,
  normalizar,
  organizacionDelCorreo,
} from '../autenticacion/registro.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService, type Transaccion } from '../comun/prisma.service.js';
import type { MembresiaCreadaDto } from './dto/membresia.dto.js';

/** Lo que guarda el código hasta confirmarlo: quién lo pidió y para qué organización. */
interface DatosAgregar {
  usuarioId: string;
  organizacionId: string;
}

const correoEnUso = () =>
  new ErrorNegocio(409, 'CORREO_EN_USO', 'membresias.agregar.correo_en_uso');

/** HU-07: una persona con sesión se une a otras organizaciones y elige cuál está activa. */
@Injectable()
export class MisMembresiasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly autenticacion: AutenticacionService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /** CA-1: valida y envía el código al correo de la otra organización; nada se crea hasta confirmarlo (RN-1). */
  async solicitar(
    usuarioId: string,
    correoRecibido: string,
  ): Promise<{ reenviarEn: Date }> {
    const correo = normalizar(correoRecibido);
    // La organización sale solo del dominio, nunca del cliente (A-13).
    const organizacionId = await organizacionDelCorreo(this.prisma, correo);
    if (!organizacionId) throw noAfiliada();
    await this.prisma.enOrganizacion(organizacionId, (tx) =>
      this.validar(tx, usuarioId, organizacionId, correo),
    );
    const datos: DatosAgregar = { usuarioId, organizacionId };
    return this.otp.generar(correo, 'agregar_organizacion', { ...datos });
  }

  /** CA-2: en una transacción consume el código y crea la membresía según el modo de la organización, con auditoría. */
  async confirmar(
    usuarioId: string,
    correoRecibido: string,
    codigo: string,
  ): Promise<MembresiaCreadaDto> {
    const correo = normalizar(correoRecibido);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const datos = (await this.otp.verificar(
          tx,
          correo,
          'agregar_organizacion',
          codigo,
        )) as unknown as DatosAgregar;
        // El código es de quien lo pidió: otra cuenta no lo usa aunque lo conozca (se revierte y sigue sin usar).
        if (datos.usuarioId !== usuarioId)
          throw new ErrorNegocio(
            400,
            'OTP_INVALIDO',
            'autenticacion.otp.invalido',
          );
        await this.prisma.fijarOrganizacion(tx, datos.organizacionId);
        const org = await tx.organizacion.findUnique({
          where: { id: datos.organizacionId },
        });
        if (org?.estado !== 'activa') throw noAfiliada();
        // Pudo cambiar entre el envío y la confirmación.
        await this.validar(tx, usuarioId, org.id, correo);
        const estado: 'aprobada' | 'pendiente' =
          org.modoAprobacion === 'automatica' ? 'aprobada' : 'pendiente';
        const m = await tx.membresia.create({
          data: {
            organizacionId: org.id,
            usuarioId,
            rol: 'miembro',
            estado,
            correoInstitucional: correo,
            decididoEn: estado === 'aprobada' ? new Date() : null,
          },
        });
        // Sin organización activa todavía, la nueva aprobada pasa a serlo (como al aprobar, HU-03).
        if (estado === 'aprobada')
          await tx.usuario.updateMany({
            where: { id: usuarioId, ultimaOrganizacionId: null },
            data: { ultimaOrganizacionId: org.id },
          });
        await this.auditoria.registrar(
          {
            accion: 'membresia.agregar',
            entidad: 'membresia',
            entidadId: m.id,
            resultado: 'ok',
            actorId: usuarioId,
            organizacionId: org.id,
            detalle: { estadoMembresia: estado },
          },
          tx,
        );
        return {
          membresia: {
            organizacionId: org.id,
            organizacion: org.nombre,
            rol: m.rol,
            estado,
          },
        };
      });
    } catch (error) {
      // UNIQUE(lower(correo_institucional)) en toda la plataforma: otra persona lo tomó a la vez.
      if ((error as { code?: string }).code === 'P2002') throw correoEnUso();
      throw error;
    }
  }

  /** CA-4 y CA-5: solo una membresía aprobada puede ser la activa; se recuerda para la próxima sesión (RN-6). */
  async cambiarActiva(
    usuarioId: string,
    organizacionId: string,
    cli: TipoCliente,
  ): Promise<{ tokenAcceso: string }> {
    await this.prisma.enOrganizacion(organizacionId, async (tx) => {
      const m = await tx.membresia.findUnique({
        where: { organizacionId_usuarioId: { organizacionId, usuarioId } },
      });
      // Sin membresía responde igual que pendiente o rechazada.
      if (m?.estado !== 'aprobada')
        throw new ErrorNegocio(
          403,
          'MEMBRESIA_NO_APROBADA',
          'membresias.activa.no_aprobada',
        );
      await tx.usuario.update({
        where: { id: usuarioId },
        data: { ultimaOrganizacionId: organizacionId },
      });
    });
    return {
      tokenAcceso: await this.autenticacion.emitirAcceso(
        usuarioId,
        organizacionId,
        cli,
      ),
    };
  }

  /** CA-7 y HU-03 RN-4. Corre con el contexto RLS de esa organización. */
  private async validar(
    tx: Transaccion,
    usuarioId: string,
    organizacionId: string,
    correo: string,
  ): Promise<void> {
    const propia = await tx.membresia.findUnique({
      where: { organizacionId_usuarioId: { organizacionId, usuarioId } },
    });
    if (propia?.estado === 'rechazada')
      throw new ErrorNegocio(
        409,
        'MEMBRESIA_RECHAZADA',
        'membresias.agregar.membresia_rechazada',
      );
    if (propia)
      throw new ErrorNegocio(
        409,
        'YA_ES_MIEMBRO',
        'membresias.agregar.ya_es_miembro',
      );
    // Un correo institucional, una persona: el de otra membresía o el de inicio de sesión de otra cuenta.
    const membresia = await tx.membresia.findFirst({
      where: {
        correoInstitucional: { equals: correo, mode: 'insensitive' },
        usuarioId: { not: usuarioId },
      },
      select: { id: true },
    });
    const cuenta = await tx.usuario.findFirst({
      where: {
        correo: { equals: correo, mode: 'insensitive' },
        id: { not: usuarioId },
      },
      select: { id: true },
    });
    if (membresia || cuenta) throw correoEnUso();
  }
}
