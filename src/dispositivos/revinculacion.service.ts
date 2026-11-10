import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import {
  PlayIntegrityService,
  type ResultadoIntegridad,
} from '../comun/play-integrity.service.js';
import { PrismaService } from '../comun/prisma.service.js';
import { IdentidadService } from '../identidad/identidad.service.js';
import { CorreosService } from '../notificaciones/correos.service.js';
import { normalizarLlavePublica } from './dispositivos.service.js';
import type {
  DesafioRevinculacionDto,
  DispositivoVinculadoDto,
  RevincularDispositivoDto,
} from './dto/dispositivo.dto.js';

const VIDA_DESAFIO_MS = 5 * 60 * 1000;
const MAXIMO_PENDIENTES = 5;

const desafioInvalido = () =>
  new ErrorNegocio(
    400,
    'DESAFIO_INVALIDO',
    'dispositivo.vinculacion.desafio_invalido',
  );

/**
 * La sesión enviada vale solo si es la que se emitió con el desafío. El sufijo `~<rostro>` es la convención del
 * motor simulado y solo se acepta sobre sus ids (`sim-…`): con un id de Rekognition, el sufijo cuenta como prueba de
 * vida fallida en vez de llegar al servicio como un 503 que no suma intento.
 */
const sesionDelDesafio = (enviada?: string, emitida?: string) =>
  emitida &&
  (enviada === emitida ||
    (emitida.startsWith('sim-') && enviada?.startsWith(`${emitida}~`)))
    ? enviada
    : undefined;

/** CA-8: fecha y hora de Bolivia para el correo, no un ISO. */
const fechaLocal = (fecha: Date) =>
  fecha.toLocaleString('es-BO', {
    timeZone: 'America/La_Paz',
    dateStyle: 'long',
    timeStyle: 'short',
  });

@Injectable()
export class RevinculacionService {
  private readonly desafios = new Map<
    string,
    { usuarioId: string; venceEn: number; sesionLivenessId?: string }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly integridad: PlayIntegrityService,
    private readonly identidad: IdentidadService,
    private readonly correos: CorreosService,
  ) {}

  /**
   * CA-2 y CA-10: Pide un desafío para volver a vincular.
   * Si la cuenta ya tiene identidad verificada, comprueba que no esté bloqueada y
   * crea la sesión de prueba de vida (Face Liveness).
   */
  async emitirDesafio(usuarioId: string): Promise<DesafioRevinculacionDto> {
    const requiereIdentidad =
      await this.identidad.tieneIdentidadAprobada(usuarioId);
    let sesionLivenessId: string | undefined;

    if (requiereIdentidad) {
      try {
        sesionLivenessId =
          await this.identidad.crearSesionLivenessRevinculacion(usuarioId);
      } catch (error) {
        // CA-12: un intento frenado al empezar (bloqueo o motor caído) también queda; aún no hay modelo.
        throw await this.rechazar(
          usuarioId,
          undefined,
          (error as { codigo?: string }).codigo ?? 'identidad',
          error,
        );
      }
    }

    const ahora = Date.now();
    const propios: string[] = [];
    for (const [desafio, d] of this.desafios) {
      if (d.venceEn <= ahora) this.desafios.delete(desafio);
      else if (d.usuarioId === usuarioId) propios.push(desafio);
    }
    const sobran = Math.max(0, propios.length - MAXIMO_PENDIENTES + 1);
    for (const viejo of propios.slice(0, sobran)) this.desafios.delete(viejo);

    const desafio = randomBytes(32).toString('base64url');
    const venceEn = ahora + VIDA_DESAFIO_MS;
    // La sesión de prueba de vida queda atada a este desafío: vale una vez y solo con él.
    this.desafios.set(desafio, { usuarioId, venceEn, sesionLivenessId });

    return {
      desafio,
      expiraEn: new Date(venceEn).toISOString(),
      requiereIdentidad,
      ...(sesionLivenessId && { sesionLivenessId }),
    };
  }

  /**
   * CA-2, CA-4, CA-5, CA-6, CA-8, CA-10 y CA-11:
   * 1. Consume desafío (un solo uso).
   * 2. Si requiere identidad: valida prueba de vida y compara con carnet. Fallos suman y bloquean 24 h al 3.º (CA-7).
   * 3. Normaliza llave pública y valida Play Integrity.
   * 4. Transacción atómica: desactiva anterior(es), inserta nuevo, audita y encola correo de aviso.
   */
  async revincular(
    usuarioId: string,
    dto: RevincularDispositivoDto,
  ): Promise<DispositivoVinculadoDto> {
    const guardado = this.desafios.get(dto.desafio);
    this.desafios.delete(dto.desafio);
    if (
      !guardado ||
      guardado.usuarioId !== usuarioId ||
      guardado.venceEn <= Date.now()
    ) {
      throw await this.rechazar(
        usuarioId,
        dto.modelo,
        'desafio_invalido',
        desafioInvalido(),
      );
    }

    const requiereIdentidad =
      await this.identidad.tieneIdentidadAprobada(usuarioId);
    if (requiereIdentidad) {
      try {
        // Una sesión que no salió con este desafío cuenta como prueba de vida fallida.
        await this.identidad.comprobarRostroDelTitular(
          usuarioId,
          sesionDelDesafio(dto.sesionLivenessId, guardado.sesionLivenessId),
        );
      } catch (error) {
        throw await this.rechazar(
          usuarioId,
          dto.modelo,
          (error as { codigo?: string }).codigo ?? 'identidad',
          error,
        );
      }
    }

    let llavePublica: string;
    try {
      llavePublica = normalizarLlavePublica(dto.llavePublicaPem);
    } catch (error) {
      throw await this.rechazar(usuarioId, dto.modelo, 'llave_invalida', error);
    }

    let resultado: ResultadoIntegridad;
    try {
      resultado = await this.integridad.verificar(
        dto.tokenIntegridad,
        dto.desafio,
      );
    } catch (error) {
      throw await this.rechazar(
        usuarioId,
        dto.modelo,
        'servicio_no_disponible',
        error,
      );
    }

    if (!resultado.integro) {
      throw await this.rechazar(
        usuarioId,
        dto.modelo,
        resultado.motivo ?? 'no_integro',
        new ErrorNegocio(
          422,
          'DISPOSITIVO_NO_INTEGRO',
          'dispositivo.vinculacion.no_integro',
        ),
      );
    }

    try {
      const ahora = new Date();
      return await this.prisma.$transaction(async (tx) => {
        // Desactiva dispositivos anteriores
        await tx.dispositivo.updateMany({
          where: { usuarioId, activo: true },
          data: { activo: false, desactivadoEn: ahora },
        });

        // Inserta el nuevo dispositivo
        const { id } = await tx.dispositivo.create({
          data: {
            usuarioId,
            llavePublica,
            modeloDispositivo: dto.modelo,
            veredictoIntegridad: resultado.veredicto,
            activo: true,
            vinculadoEn: ahora,
          },
          select: { id: true },
        });

        // Registra auditoría
        await this.auditoria.registrar(
          {
            accion: 'dispositivo.revinculacion',
            entidad: 'dispositivo',
            entidadId: id,
            resultado: 'ok',
            actorId: usuarioId,
            detalle: {
              modelo: dto.modelo,
              veredicto: resultado.veredicto,
              requiereIdentidad,
            },
          },
          tx,
        );

        // Encola correo de aviso al dueño
        const usuario = await tx.usuario.findUniqueOrThrow({
          where: { id: usuarioId },
          select: { correo: true, nombreCompleto: true },
        });

        await this.correos.encolar(tx, {
          destinatario: usuario.correo,
          plantilla: 'dispositivo_revinculado',
          datos: {
            nombre: usuario.nombreCompleto,
            modelo: dto.modelo,
            fecha: fechaLocal(ahora),
          },
          referenciaTipo: 'dispositivo',
          referenciaId: id,
        });

        return { id, estado: 'vinculado' as const };
      });
    } catch (error) {
      // Conflicto de revinculación concurrente
      if ((error as { code?: string }).code === 'P2002') {
        throw await this.rechazar(
          usuarioId,
          dto.modelo,
          'revinculacion_concurrente',
          new ErrorNegocio(
            409,
            'CONFLICTO_CONCURRENTE',
            'dispositivo.revincular.concurrente',
          ),
        );
      }
      throw error;
    }
  }

  /** CA-12: todo intento rechazado queda con cuenta, modelo y motivo, sin datos biométricos. */
  private async rechazar(
    usuarioId: string,
    modelo: string | undefined,
    motivo: string,
    error: unknown,
  ): Promise<unknown> {
    await this.auditoria.registrar({
      accion: 'dispositivo.revinculacion',
      entidad: 'dispositivo',
      resultado: 'fallo',
      actorId: usuarioId,
      detalle: { motivo, ...(modelo && { modelo }) },
    });
    return error;
  }
}
