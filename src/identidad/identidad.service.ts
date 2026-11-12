import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { BilleteraService } from '../billetera/billetera.service.js';
import { AlmacenamientoService } from '../comun/almacenamiento.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import {
  CONFIANZA_MINIMA_LIVENESS,
  SIMILITUD_MINIMA,
  type MotorFacial,
} from '../comun/motor-facial.js';
import { PrismaService } from '../comun/prisma.service.js';
import { RekognitionService } from '../comun/rekognition.service.js';
import { MAXIMO_FOTO_BYTES, tipoDeImagen } from '../vehiculos/foto.js';
import type { FotoSubida } from '../vehiculos/foto.js';
import type {
  EstadoIdentidad,
  EstadoIdentidadDto,
  SesionLivenessDto,
  VerificacionDto,
  VerificarIdentidadDto,
} from './dto/identidad.dto.js';
import { hashDocumento, secretoIdentidad } from './documento.js';
import { imagenIlegible } from './foto-carnet.js';

export const MAXIMO_INTENTOS = 3;
export const BLOQUEO_MS = 24 * 60 * 60 * 1000;

/**
 * Fallos que cuentan para los 3 intentos consecutivos (CA-9): todo rechazo causado por lo que envía la persona
 * (vivacidad, rostro que no coincide, imagen ilegible o con formato inválido, y documento o rostro duplicados:
 * así también se frena el sondeo de carnets ajenos, A-02). NO cuentan los fallos nuestros (motor, S3, BD → 503),
 * ni el consentimiento ni los datos mal formados (ya los rechaza la validación), porque no son intentos de verificación.
 */
type Motivo =
  | 'prueba_vida_fallida'
  | 'rostro_no_coincide'
  | 'documento_duplicado'
  | 'rostro_duplicado'
  | 'imagen_ilegible';

const RECHAZOS: Record<Motivo, () => ErrorNegocio> = {
  prueba_vida_fallida: () =>
    new ErrorNegocio(
      422,
      'PRUEBA_VIDA_FALLIDA',
      'identidad.verificacion.prueba_vida_fallida',
    ),
  rostro_no_coincide: () =>
    new ErrorNegocio(
      422,
      'ROSTRO_NO_COINCIDE',
      'identidad.verificacion.rostro_no_coincide',
    ),
  documento_duplicado: () =>
    new ErrorNegocio(
      409,
      'DOCUMENTO_DUPLICADO',
      'identidad.verificacion.documento_duplicado',
    ),
  rostro_duplicado: () =>
    new ErrorNegocio(
      409,
      'ROSTRO_DUPLICADO',
      'identidad.verificacion.rostro_duplicado',
    ),
  imagen_ilegible: imagenIlegible,
};

const intentosAgotados = (bloqueadoHasta: Date) =>
  new ErrorNegocio(
    429,
    'INTENTOS_AGOTADOS',
    'identidad.verificacion.intentos_agotados',
    { bloqueadoHasta },
  );
const yaVerificada = () =>
  new ErrorNegocio(
    400,
    'IDENTIDAD_YA_VERIFICADA',
    'identidad.verificacion.ya_verificada',
  );
const noDisponible = () =>
  new ErrorNegocio(
    503,
    'SERVICIO_NO_DISPONIBLE',
    'identidad.verificacion.servicio_no_disponible',
  );

interface Fila {
  estado: string;
  bloqueadoHasta: Date | null;
}
const bloqueoVigente = (fila: Fila | null, ahora: Date) =>
  Boolean(fila?.bloqueadoHasta && fila.bloqueadoHasta > ahora);

@Injectable()
export class IdentidadService implements OnModuleInit {
  private readonly registro = new Logger(IdentidadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly almacenamiento: AlmacenamientoService,
    private readonly rekognition: RekognitionService,
    private readonly billetera: BilleteraService,
  ) {}

  /** Sin `IDENTIDAD_SECRETO` el arranque falla (salvo en pruebas, donde el helper lo define). */
  onModuleInit(): void {
    if (process.env.NODE_ENV !== 'test') secretoIdentidad();
  }

  /** Abre la sesión de Face Liveness (RN-4: la prueba de vida es en vivo, con la cámara de la app). */
  async crearSesionLiveness(usuarioId: string): Promise<SesionLivenessDto> {
    const fila = await this.leer(usuarioId);
    if (fila?.estado === 'verificada') throw yaVerificada();
    if (bloqueoVigente(fila, new Date()))
      throw new ErrorNegocio(
        403,
        'IDENTIDAD_BLOQUEADA_TEMPORAL',
        'identidad.verificacion.bloqueada_temporal',
        { bloqueadoHasta: fila?.bloqueadoHasta },
      );
    return { sesionId: await this.motor((m) => m.crearSesionLiveness()) };
  }

  /** HU-10: comprueba si la cuenta tiene identidad aprobada. */
  async tieneIdentidadAprobada(usuarioId: string): Promise<boolean> {
    const fila = await this.prisma.identidad.findUnique({
      where: { usuarioId },
      select: { estado: true },
    });
    return fila?.estado === 'verificada';
  }

  /** HU-10: sesion de liveness para revincular un dispositivo (con identidad aprobada). */
  async crearSesionLivenessRevinculacion(usuarioId: string): Promise<string> {
    const fila = await this.leer(usuarioId);
    if (bloqueoVigente(fila, new Date())) {
      throw intentosAgotados(fila!.bloqueadoHasta!);
    }
    return await this.motor((m) => m.crearSesionLiveness());
  }

  /**
   * HU-10 (SP135): comprueba que el rostro de la prueba de vida coincida con el carnet de la identidad aprobada.
   * Suma fallos y bloquea 24 h al tercer fallo consecutivo (CA-7).
   */
  async comprobarRostroDelTitular(
    usuarioId: string,
    sesionLivenessId?: string,
    modelo?: string,
  ): Promise<void> {
    const fila = await this.prisma.identidad.findUnique({
      where: { usuarioId },
      select: {
        id: true,
        estado: true,
        claveS3Carnet: true,
        intentosFallidos: true,
        bloqueadoHasta: true,
      },
    });
    if (!fila || fila.estado !== 'verificada') return;

    const ahora = new Date();
    if (bloqueoVigente(fila, ahora)) {
      throw intentosAgotados(fila.bloqueadoHasta!);
    }
    if (fila.bloqueadoHasta) {
      await this.prisma.identidad.updateMany({
        where: { usuarioId },
        data: { intentosFallidos: 0, bloqueadoHasta: null },
      });
    }

    if (!sesionLivenessId) {
      throw await this.rechazarFalloRostro(
        usuarioId,
        'prueba_vida_fallida',
        modelo,
      );
    }
    if (!fila.claveS3Carnet) {
      this.registro.error(
        `Identidad verificada de ${usuarioId} no tiene claveS3Carnet`,
      );
      throw noDisponible();
    }

    let carnet: Buffer;
    try {
      carnet = await this.almacenamiento.descargar(fila.claveS3Carnet);
    } catch {
      throw noDisponible();
    }

    const vivacidad = await this.motor((m) =>
      m.obtenerResultadoLiveness(sesionLivenessId),
    );
    if (
      !vivacidad.exitosa ||
      vivacidad.confianza < CONFIANZA_MINIMA_LIVENESS ||
      !vivacidad.imagenReferencia
    ) {
      throw await this.rechazarFalloRostro(
        usuarioId,
        'prueba_vida_fallida',
        modelo,
      );
    }

    const similitud = await this.motor((m) =>
      m.compararRostros(vivacidad.imagenReferencia!, carnet),
    );
    if (similitud === null || similitud < SIMILITUD_MINIMA) {
      throw await this.rechazarFalloRostro(
        usuarioId,
        'rostro_no_coincide',
        modelo,
      );
    }

    if (fila.intentosFallidos > 0) {
      await this.prisma.identidad.updateMany({
        where: { usuarioId },
        data: { intentosFallidos: 0, bloqueadoHasta: null },
      });
    }
  }

  /**
   * Orden barato → caro: consentimiento (RN-3) → estado y bloqueo → imagen y documento duplicado (A-02, sin gastar
   * llamadas biométricas) → vivacidad (A-01) → comparación con el carnet → rostro duplicado (A-02) → S3 → indexado → BD.
   * Lo subido a S3 y lo indexado se deshacen si algo falla después: nada queda a medias.
   */
  async verificar(
    usuarioId: string,
    dto: VerificarIdentidadDto,
    foto?: FotoSubida,
  ): Promise<VerificacionDto> {
    if (dto.aceptaConsentimiento !== true)
      throw new ErrorNegocio(
        400,
        'CONSENTIMIENTO_REQUERIDO',
        'identidad.verificacion.consentimiento_requerido',
      );

    const fila = await this.leer(usuarioId);
    if (fila?.estado === 'verificada') throw yaVerificada();
    const ahora = new Date();
    if (fila?.bloqueadoHasta && fila.bloqueadoHasta > ahora)
      throw intentosAgotados(fila.bloqueadoHasta);
    // Bloqueo vencido: vuelve a tener 3 intentos.
    if (fila?.bloqueadoHasta)
      await this.prisma.identidad.updateMany({
        where: { usuarioId, estado: { not: 'verificada' } },
        data: {
          estado: 'no_verificada',
          intentosFallidos: 0,
          bloqueadoHasta: null,
        },
      });

    const documentoHash = hashDocumento(dto.numeroDocumento);
    const tipo =
      foto && foto.size <= MAXIMO_FOTO_BYTES ? tipoDeImagen(foto.buffer) : null;
    if (!foto || !tipo) throw await this.rechazar(usuarioId, 'imagen_ilegible');

    const dueno = await this.prisma.identidad.findUnique({
      where: { documentoHash },
      select: { usuarioId: true },
    });
    if (dueno && dueno.usuarioId !== usuarioId)
      throw await this.rechazar(usuarioId, 'documento_duplicado');

    const vivacidad = await this.motor((m) =>
      m.obtenerResultadoLiveness(dto.sesionId),
    );
    if (
      !vivacidad.exitosa ||
      vivacidad.confianza < CONFIANZA_MINIMA_LIVENESS ||
      !vivacidad.imagenReferencia
    )
      throw await this.rechazar(usuarioId, 'prueba_vida_fallida');
    const referencia = vivacidad.imagenReferencia;

    const similitud = await this.motor((m) =>
      m.compararRostros(referencia, foto.buffer),
    );
    if (similitud === null)
      throw await this.rechazar(usuarioId, 'imagen_ilegible');
    if (similitud < SIMILITUD_MINIMA)
      throw await this.rechazar(usuarioId, 'rostro_no_coincide');

    if (
      await this.motor((m) => m.buscarRostroDuplicado(foto.buffer, usuarioId))
    )
      throw await this.rechazar(usuarioId, 'rostro_duplicado');

    // La clave solo lleva el id del dueño (identificador interno), nunca el número de carnet.
    const clave = `identidades/${usuarioId}/${randomUUID()}`;
    try {
      await this.almacenamiento.subir(clave, foto.buffer, tipo);
    } catch {
      throw noDisponible();
    }

    let faceId: string;
    try {
      faceId = await this.motor((m) => m.indexarRostro(foto.buffer, usuarioId));
    } catch (error) {
      await this.almacenamiento.borrar(clave);
      throw error;
    }

    let verificacion: VerificacionDto;
    try {
      // Dos cuentas con el mismo rostro a la vez pasan la búsqueda previa sin verse: tras indexar, la que
      // indexó después sí ve a la otra. Nunca quedan las dos verificadas (A-02); como mucho se rechazan ambas.
      if (
        await this.motor((m) => m.buscarRostroDuplicado(foto.buffer, usuarioId))
      )
        throw await this.rechazar(usuarioId, 'rostro_duplicado');
      verificacion = await this.guardar(usuarioId, {
        documentoHash,
        similitud,
        clave,
        faceId,
      });
    } catch (error) {
      await this.compensar(clave, faceId);
      // El UNIQUE de documento_hash decide cuando dos cuentas envían el mismo carnet a la vez (A-02).
      if ((error as { code?: string }).code === 'P2002')
        throw await this.rechazar(usuarioId, 'documento_duplicado');
      if (error instanceof ErrorNegocio) throw error;
      // El mensaje de la BD puede traer la fila (hash, clave, face id): solo se registra su código.
      this.registro.error(
        `No se pudo guardar la identidad (${(error as { code?: string }).code ?? 'BD'})`,
      );
      throw noDisponible();
    }
    // HU-12 CA-1: fuera del try, porque una falla de la billetera no revierte la verificación.
    await this.billetera.crearAutomatica(usuarioId);
    return verificacion;
  }

  /** CA-8: solo estado y fechas. Un bloqueo vencido se informa como `no_verificada`. */
  async estado(usuarioId: string): Promise<EstadoIdentidadDto> {
    const fila = await this.leer(usuarioId);
    if (!fila)
      return {
        estado: 'no_verificada',
        verificadoEn: null,
        bloqueadoHasta: null,
      };
    const vigente = bloqueoVigente(fila, new Date());
    const estado =
      fila.estado === 'bloqueada_temporal' && !vigente
        ? 'no_verificada'
        : (fila.estado as EstadoIdentidad);
    return {
      estado,
      verificadoEn: fila.verificadoEn,
      bloqueadoHasta: vigente ? fila.bloqueadoHasta : null,
    };
  }

  private leer(usuarioId: string) {
    return this.prisma.identidad.findUnique({
      where: { usuarioId },
      select: { estado: true, bloqueadoHasta: true, verificadoEn: true },
    });
  }

  /** Falla del motor (red, credenciales, límite): 503 sin contar intento ni guardar nada; solo se registra el tipo de error. */
  private async motor<T>(
    llamada: (motor: MotorFacial) => Promise<T>,
  ): Promise<T> {
    try {
      return await llamada(this.rekognition.motor);
    } catch (error) {
      this.registro.error(
        `Falla del motor facial (${(error as { name?: string } | null)?.name ?? 'Error'})`,
      );
      throw noDisponible();
    }
  }

  private async compensar(clave: string, faceId: string): Promise<void> {
    await this.almacenamiento.borrar(clave);
    try {
      await this.rekognition.motor.desindexarRostro(faceId);
    } catch (error) {
      this.registro.error(
        `No se pudo desindexar un rostro huérfano (${(error as { name?: string } | null)?.name ?? 'Error'})`,
      );
    }
  }

  /**
   * Un solo UPDATE condicional decide: la verificación solo se escribe si no estaba ya verificada ni bloqueada
   * (peticiones paralelas del mismo usuario) y el UNIQUE de documento_hash decide entre cuentas (A-02).
   */
  private guardar(
    usuarioId: string,
    d: {
      documentoHash: string;
      similitud: number;
      clave: string;
      faceId: string;
    },
  ): Promise<VerificacionDto> {
    return this.prisma.$transaction(async (tx) => {
      const ahora = new Date();
      await tx.identidad.createMany({
        data: [{ usuarioId, consentimientoEn: ahora }],
        skipDuplicates: true,
      });
      const { count } = await tx.identidad.updateMany({
        where: {
          usuarioId,
          estado: { not: 'verificada' },
          OR: [{ bloqueadoHasta: null }, { bloqueadoHasta: { lte: ahora } }],
        },
        data: {
          estado: 'verificada',
          documentoHash: d.documentoHash,
          similitudFacial: d.similitud,
          claveS3Carnet: d.clave,
          faceIdColeccion: d.faceId,
          intentosFallidos: 0,
          bloqueadoHasta: null,
          verificadoEn: ahora,
        },
      });
      const fila = await tx.identidad.findUniqueOrThrow({
        where: { usuarioId },
        select: { id: true, estado: true, bloqueadoHasta: true },
      });
      if (!count) {
        if (fila.estado === 'verificada') throw yaVerificada();
        throw intentosAgotados(fila.bloqueadoHasta ?? ahora);
      }
      await this.auditoria.registrar(
        {
          accion: 'identidad.verificacion',
          entidad: 'identidad',
          entidadId: fila.id,
          resultado: 'ok',
          actorId: usuarioId,
        },
        tx,
      );
      return { estado: 'verificada', verificadoEn: ahora };
    });
  }

  /** Cuenta el intento fallido, bloquea 24 h al tercero (CA-9) y audita con el motivo (sin datos sensibles). */
  private async rechazar(
    usuarioId: string,
    motivo: Motivo,
  ): Promise<ErrorNegocio> {
    const bloqueadoHasta = await this.prisma.$transaction(async (tx) => {
      const ahora = new Date();
      await tx.identidad.createMany({
        data: [{ usuarioId, consentimientoEn: ahora }],
        skipDuplicates: true,
      });
      // Nunca se toca una identidad ya verificada (petición paralela que ganó).
      const noVerificada = { usuarioId, estado: { not: 'verificada' } };
      await tx.identidad.updateMany({
        where: noVerificada,
        data: { intentosFallidos: { increment: 1 } },
      });
      const fila = await tx.identidad.findUniqueOrThrow({
        where: { usuarioId },
        select: { intentosFallidos: true, estado: true },
      });
      let hasta: Date | null = null;
      if (
        fila.estado !== 'verificada' &&
        fila.intentosFallidos >= MAXIMO_INTENTOS
      ) {
        hasta = new Date(ahora.getTime() + BLOQUEO_MS);
        await tx.identidad.updateMany({
          where: noVerificada,
          data: { estado: 'bloqueada_temporal', bloqueadoHasta: hasta },
        });
      }
      await this.auditoria.registrar(
        {
          accion: 'identidad.verificacion',
          entidad: 'identidad',
          resultado: 'fallo',
          actorId: usuarioId,
          detalle: {
            motivo,
            intentos: fila.intentosFallidos,
            bloqueada: hasta !== null,
          },
        },
        tx,
      );
      return hasta;
    });
    return bloqueadoHasta
      ? intentosAgotados(bloqueadoHasta)
      : RECHAZOS[motivo]();
  }

  /** HU-10: cuenta fallos biométricos durante la revinculación de un titular ya verificado. */
  private async rechazarFalloRostro(
    usuarioId: string,
    motivo: 'prueba_vida_fallida' | 'rostro_no_coincide',
    modelo?: string,
  ): Promise<ErrorNegocio> {
    const bloqueadoHasta = await this.prisma.$transaction(async (tx) => {
      const ahora = new Date();
      await tx.identidad.updateMany({
        where: { usuarioId },
        data: { intentosFallidos: { increment: 1 } },
      });
      const fila = await tx.identidad.findUniqueOrThrow({
        where: { usuarioId },
        select: { intentosFallidos: true, id: true },
      });
      let hasta: Date | null = null;
      if (fila.intentosFallidos >= MAXIMO_INTENTOS) {
        hasta = new Date(ahora.getTime() + BLOQUEO_MS);
        await tx.identidad.updateMany({
          where: { usuarioId },
          data: { bloqueadoHasta: hasta },
        });
      }
      await this.auditoria.registrar(
        {
          accion: 'dispositivo.revinculacion',
          entidad: 'identidad',
          entidadId: fila.id,
          resultado: 'fallo',
          actorId: usuarioId,
          detalle: {
            motivo,
            intentos: fila.intentosFallidos,
            bloqueada: hasta !== null,
            ...(modelo && { modelo }),
          },
        },
        tx,
      );
      return hasta;
    });
    const error = bloqueadoHasta
      ? intentosAgotados(bloqueadoHasta)
      : RECHAZOS[motivo]();
    // Ya quedó en auditoría con sus intentos: quien lo recibe no lo vuelve a registrar (CA-12).
    Object.defineProperty(error, 'auditado', { value: true });
    return error;
  }
}
