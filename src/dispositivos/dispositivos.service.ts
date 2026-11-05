import { createPublicKey, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import {
  PlayIntegrityService,
  type ResultadoIntegridad,
} from '../comun/play-integrity.service.js';
import { PrismaService } from '../comun/prisma.service.js';
import type {
  DesafioAtestacionDto,
  DispositivoVinculadoDto,
  MiDispositivoDto,
  VincularDispositivoDto,
} from './dto/dispositivo.dto.js';

/** Tiempo para pedir el token a Play Integrity y enviarlo (la atestación tarda unos segundos). */
const VIDA_DESAFIO_MS = 5 * 60 * 1000;
/** Desafíos pendientes por cuenta: acota la memoria; al pasar el límite se descarta el más viejo. */
const MAXIMO_PENDIENTES = 5;

const yaVinculado = () =>
  new ErrorNegocio(
    400,
    'DISPOSITIVO_YA_VINCULADO',
    'dispositivo.vinculacion.ya_vinculado',
  );
const desafioInvalido = () =>
  new ErrorNegocio(
    400,
    'DESAFIO_INVALIDO',
    'dispositivo.vinculacion.desafio_invalido',
  );
const llaveInvalida = () =>
  new ErrorNegocio(
    400,
    'LLAVE_INVALIDA',
    'dispositivo.vinculacion.llave_invalida',
  );

/**
 * Valida que sea una llave PÚBLICA EC P-256 y la devuelve en SPKI/PEM canónico.
 * Una llave privada se rechaza: nunca debe llegar al servidor (y `createPublicKey` la aceptaría derivando la pública).
 */
export function normalizarLlavePublica(pem: string): string {
  if (/PRIVATE/i.test(pem)) throw llaveInvalida();
  try {
    const llave = createPublicKey({ key: pem, format: 'pem' });
    if (
      llave.asymmetricKeyType !== 'ec' ||
      llave.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    )
      throw llaveInvalida();
    return llave.export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    throw llaveInvalida();
  }
}

@Injectable()
export class DispositivosService {
  /**
   * ponytail: desafíos en memoria de una sola instancia (se pierden al reiniciar y no se comparten entre réplicas).
   * Con varias instancias del backend, migrar a BD o Redis con TTL.
   */
  private readonly desafios = new Map<
    string,
    { usuarioId: string; venceEn: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly integridad: PlayIntegrityService,
  ) {}

  /** CA-6 ya al pedir el desafío: quien tiene dispositivo activo no necesita otro. */
  async emitirDesafio(usuarioId: string): Promise<DesafioAtestacionDto> {
    await this.exigirSinDispositivo(usuarioId);
    const ahora = Date.now();
    const propios: string[] = []; // del más viejo al más nuevo (orden de inserción)
    for (const [desafio, d] of this.desafios) {
      if (d.venceEn <= ahora) this.desafios.delete(desafio);
      else if (d.usuarioId === usuarioId) propios.push(desafio);
    }
    const sobran = Math.max(0, propios.length - MAXIMO_PENDIENTES + 1);
    for (const viejo of propios.slice(0, sobran)) this.desafios.delete(viejo);
    const desafio = randomBytes(32).toString('base64url');
    const venceEn = ahora + VIDA_DESAFIO_MS;
    this.desafios.set(desafio, { usuarioId, venceEn });
    return { desafio, expiraEn: new Date(venceEn).toISOString() };
  }

  /**
   * CA-1, CA-2 y CA-6. El desafío se consume apenas se presenta (valga o no): vale una sola vez.
   * Orden: desafío, ya vinculado, llave, atestación, insertar. Si algo falla no queda nada guardado.
   */
  async vincular(
    usuarioId: string,
    dto: VincularDispositivoDto,
  ): Promise<DispositivoVinculadoDto> {
    const guardado = this.desafios.get(dto.desafio);
    this.desafios.delete(dto.desafio);
    if (
      !guardado ||
      guardado.usuarioId !== usuarioId ||
      guardado.venceEn <= Date.now()
    )
      throw await this.rechazar(
        usuarioId,
        'desafio_invalido',
        desafioInvalido(),
      );
    try {
      await this.exigirSinDispositivo(usuarioId);
    } catch (error) {
      throw await this.rechazar(usuarioId, 'ya_vinculado', error);
    }
    let llavePublica: string;
    try {
      llavePublica = normalizarLlavePublica(dto.llavePublicaPem);
    } catch (error) {
      throw await this.rechazar(usuarioId, 'llave_invalida', error);
    }

    let resultado: ResultadoIntegridad;
    try {
      resultado = await this.integridad.verificar(
        dto.tokenIntegridad,
        dto.desafio,
      );
    } catch (error) {
      throw await this.rechazar(usuarioId, 'servicio_no_disponible', error);
    }
    if (!resultado.integro)
      throw await this.rechazar(
        usuarioId,
        resultado.motivo ?? 'no_integro',
        new ErrorNegocio(
          422,
          'DISPOSITIVO_NO_INTEGRO',
          'dispositivo.vinculacion.no_integro',
        ),
      );

    try {
      return await this.prisma.$transaction(async (tx) => {
        const { id } = await tx.dispositivo.create({
          data: {
            usuarioId,
            llavePublica,
            modeloDispositivo: dto.modelo,
            veredictoIntegridad: resultado.veredicto,
          },
          select: { id: true },
        });
        await this.auditoria.registrar(
          {
            accion: 'dispositivo.vinculacion',
            entidad: 'dispositivo',
            entidadId: id,
            resultado: 'ok',
            actorId: usuarioId,
            detalle: { modelo: dto.modelo, veredicto: resultado.veredicto },
          },
          tx,
        );
        return { id, estado: 'vinculado' as const };
      });
    } catch (error) {
      // Vinculación concurrente: el UNIQUE(usuario_id) decide y el perdedor no deja nada.
      if ((error as { code?: string }).code === 'P2002')
        throw await this.rechazar(usuarioId, 'ya_vinculado', yaVinculado());
      throw error;
    }
  }

  async miDispositivo(usuarioId: string): Promise<MiDispositivoDto> {
    const d = await this.prisma.dispositivo.findUnique({
      where: { usuarioId },
      select: {
        id: true,
        modeloDispositivo: true,
        vinculadoEn: true,
        activo: true,
      },
    });
    if (!d)
      throw new ErrorNegocio(
        404,
        'NO_ENCONTRADO',
        'comun.errores.no_encontrado',
      );
    // Nunca la llave ni el veredicto: solo lo que la persona necesita ver.
    return {
      id: d.id,
      modelo: d.modeloDispositivo,
      vinculadoEn: d.vinculadoEn,
      activo: d.activo,
    };
  }

  private async exigirSinDispositivo(usuarioId: string): Promise<void> {
    const existente = await this.prisma.dispositivo.findFirst({
      where: { usuarioId, activo: true },
      select: { id: true },
    });
    if (existente) throw yaVinculado();
  }

  /** Audita el rechazo (el motivo exacto queda solo aquí, no en la respuesta) y devuelve el error a lanzar. */
  private async rechazar(
    usuarioId: string,
    motivo: string,
    error: unknown,
  ): Promise<unknown> {
    await this.auditoria.registrar({
      accion: 'dispositivo.vinculacion',
      entidad: 'dispositivo',
      resultado: 'fallo',
      actorId: usuarioId,
      detalle: { motivo },
    });
    return error;
  }
}
