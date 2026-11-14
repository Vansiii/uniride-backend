import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import QRCode from 'qrcode';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import type { LlaveTrayectoFirmante } from '../comun/firma-trayecto.guard.js';
import {
  PlayIntegrityService,
  type ResultadoIntegridad,
} from '../comun/play-integrity.service.js';
import { PrismaService, type Transaccion } from '../comun/prisma.service.js';
import { normalizarLlavePublica } from '../dispositivos/dispositivos.service.js';
import { EstadoViajeService } from '../viajes/estado-viaje.service.js';
import { ViajesService } from '../viajes/viajes.service.js';
import type {
  AbordajeDto,
  AbordarDto,
  BajadaDto,
  CrearDesafioDto,
  DesafioDto,
  EncuentroDto,
  EstadoDesafioDto,
  LlaveTrayectoCreadaDto,
  PosicionDto,
  PosicionesAceptadasDto,
  RegistrarLlaveTrayectoDto,
} from './dto/presencia.dto.js';
import {
  DISTANCIA_MAXIMA_M,
  VIDA_DESAFIO_MS,
  distanciaM,
  motivoPosicionInvalida,
  ventanaAbordaje,
  type Posicion,
} from './geo.js';
import {
  DESFASE_PAR_MS,
  evaluarTrayecto,
  type Evaluacion,
  type PuntoTraza,
} from './trayecto.js';

/** HU-22 abordaje, HU-23 bajada: el mismo encuentro (HU-23 RN-7). */
type TipoEncuentro = 'abordaje' | 'bajada';

const error = (
  estado: number,
  codigo: string,
  clave: string,
  extra = {},
  tipo: TipoEncuentro | 'trayecto' = 'abordaje',
) => new ErrorNegocio(estado, codigo, `presencia.${tipo}.${clave}`, extra);

/** Respuesta de cada motivo de rechazo del encuentro (HU-22 §4; en la bajada, con claves `presencia.bajada.*`). */
const RECHAZOS = {
  codigo_invalido: (t: TipoEncuentro) =>
    error(409, 'CODIGO_INVALIDO', 'codigo_invalido', {}, t),
  sin_reserva: (t: TipoEncuentro) =>
    error(409, 'SIN_RESERVA', 'sin_reserva', {}, t),
  no_abordada: (t: TipoEncuentro) =>
    error(409, 'RESERVA_NO_ABORDADA', 'no_abordada', {}, t),
  ubicacion_simulada: (t: TipoEncuentro) =>
    error(422, 'UBICACION_SIMULADA', 'ubicacion_simulada', {}, t),
  senal_gps: (t: TipoEncuentro) => error(422, 'SENAL_GPS', 'senal_gps', {}, t),
  distancia: (t: TipoEncuentro, distancia = 0) =>
    error(
      422,
      'DISTANCIA',
      'distancia',
      { distanciaM: Math.round(distancia) },
      t,
    ),
  no_integro: (t: TipoEncuentro) =>
    error(422, 'DISPOSITIVO_NO_INTEGRO', 'integridad', {}, t),
  servicio_no_disponible: (t: TipoEncuentro) =>
    error(503, 'SERVICIO_NO_DISPONIBLE', 'servicio_no_disponible', {}, t),
};
type MotivoRechazo = keyof typeof RECHAZOS;

/** Estado que exige cada encuentro, y los que ya lo dejaron atrás (repetirlo no crea otra prueba: HU-22 CA-14). */
const ENCUENTRO: Record<
  TipoEncuentro,
  { previo: string; hecho: string[]; accion: string }
> = {
  abordaje: {
    previo: 'confirmada',
    hecho: ['abordada', 'verificada', 'verificacion_fallida', 'pagada'],
    accion: 'reserva.abordaje',
  },
  bajada: {
    previo: 'abordada',
    hecho: ['verificada', 'verificacion_fallida', 'pagada'],
    accion: 'reserva.bajada',
  },
};

const viajeNoEnCurso = () =>
  error(409, 'VIAJE_NO_EN_CURSO', 'viaje_no_en_curso', {}, 'trayecto');
const firmaTrayectoInvalida = () =>
  new ErrorNegocio(
    401,
    'FIRMA_TRAYECTO_INVALIDA',
    'comun.errores.firma_invalida',
  );
/** CA-9: un punto con hora más allá de esto se ignora (la misma tolerancia de reloj que RN-4 de HU-22). */
const FUTURO_MAXIMO_MS = 30_000;

/** Lo que el encuentro validó: la transacción final de cada tipo lo guarda. */
interface EncuentroValido {
  reserva: { id: string; viajeId: string; estado: string };
  desafioId: string;
  posicion: PosicionDto;
  distancia: number;
  veredicto: string;
  hashPrueba: string;
}

/** Dos decimales: el mismo valor va a la base y al hash. */
const redondear = (n: number) => Math.round(n * 100) / 100;

/**
 * HU-22: llave de trayecto del conductor, desafíos con QR y abordaje. El teléfono solo aporta pruebas firmadas; el
 * servidor decide (`AGENTS.md` §5.1). Todo corre dentro de `enOrganizacion` (RLS, A-13).
 */
@Injectable()
export class PresenciaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly integridad: PlayIntegrityService,
    private readonly estadoViaje: EstadoViajeService,
    private readonly viajes: ViajesService,
  ) {}

  /** CA-1: el conductor registra su llave de trayecto con huella (la petición) e integridad (RN-5). */
  async registrarLlaveConductor(
    usuarioId: string,
    organizacionId: string,
    viajeId: string,
    dispositivoId: string,
    nonceIntegridad: string,
    dto: RegistrarLlaveTrayectoDto,
  ): Promise<LlaveTrayectoCreadaDto> {
    const llavePublica = normalizarLlavePublica(dto.llavePublicaPem);
    const viaje = await this.prisma.enOrganizacion(organizacionId, (tx) =>
      tx.viaje.findFirst({
        where: { id: viajeId, organizacionId, conductorId: usuarioId },
        select: {
          fechaHoraSalida: true,
          estado: true,
          reservas: {
            where: {
              estado: { in: ['confirmada', ...ENCUENTRO.abordaje.hecho] },
            },
            select: { id: true },
            take: 1,
          },
        },
      }),
    );
    if (!viaje)
      throw new ErrorNegocio(
        404,
        'VIAJE_NO_ENCONTRADO',
        'viajes.detalle.no_encontrado',
      );
    // HU-23 RN-7: con el viaje en curso la llave también firma el código de bajada, que no tiene ventana horaria; sin
    // esto, un conductor sin llave (app reinstalada) no podría bajar a nadie pasada la ventana de abordaje.
    if (viaje.estado !== 'en_curso') exigirVentana(viaje.fechaHoraSalida);
    if (viaje.reservas.length === 0)
      throw error(409, 'SIN_RESERVAS', 'sin_reservas');

    const integridad = await this.verificarIntegridad(
      dto.tokenIntegridad,
      nonceIntegridad,
    );
    if (!integridad.integro) {
      await this.auditar(
        organizacionId,
        usuarioId,
        'trayecto.llave',
        'fallo',
        viajeId,
        { motivo: integridad.motivo ?? 'no_integro' },
      );
      throw RECHAZOS.no_integro('abordaje');
    }

    try {
      return await this.prisma.enOrganizacion(organizacionId, async (tx) => {
        const { id } = await this.reemplazarLlave(tx, {
          organizacionId,
          viajeId,
          usuarioId,
          dispositivoId,
          llavePublica,
        });
        await this.auditar(
          organizacionId,
          usuarioId,
          'trayecto.llave',
          'ok',
          viajeId,
          {},
          tx,
        );
        return { llaveTrayectoId: id };
      });
    } catch (e) {
      // Dos registros a la vez: el índice de la llave vigente deja una y el perdedor no deja nada.
      if ((e as { code?: string }).code === 'P2002')
        throw error(409, 'CONFLICTO_CONCURRENTE', 'error');
      throw e;
    }
  }

  /**
   * CA-1, CA-11: código nuevo firmado con la llave de trayecto del conductor, sin huella (D-22). El de bajada (HU-23 RN-7)
   * no tiene ventana horaria, pero exige el viaje en curso.
   */
  async crearDesafio(
    usuarioId: string,
    organizacionId: string,
    viajeId: string,
    llave: LlaveTrayectoFirmante,
    dto: CrearDesafioDto,
  ): Promise<DesafioDto> {
    // La llave de un pasajero, o la de otro viaje, no emite códigos de este.
    if (llave.viajeId !== viajeId || llave.reservaId !== null)
      throw firmaTrayectoInvalida();
    const motivo = motivoPosicionInvalida(dto.posicion);
    if (motivo) throw RECHAZOS[motivo](dto.tipo);

    const nonce = randomBytes(32).toString('base64url');
    const venceEn = new Date(Date.now() + VIDA_DESAFIO_MS);
    await this.prisma.enOrganizacion(organizacionId, async (tx) => {
      const viaje = await tx.viaje.findFirst({
        where: { id: viajeId, organizacionId, conductorId: usuarioId },
        select: { fechaHoraSalida: true, estado: true },
      });
      if (!viaje)
        throw new ErrorNegocio(
          404,
          'VIAJE_NO_ENCONTRADO',
          'viajes.detalle.no_encontrado',
        );
      if (dto.tipo === 'abordaje') exigirVentana(viaje.fechaHoraSalida);
      else if (viaje.estado !== 'en_curso') throw viajeNoEnCurso();
      await tx.desafioHandshake.create({
        data: {
          organizacionId,
          viajeId,
          tipo: dto.tipo,
          nonce,
          conductorLat: dto.posicion.lat,
          conductorLng: dto.posicion.lng,
          conductorPrecisionM: dto.posicion.precisionM,
          conductorTomadaEn: new Date(dto.posicion.tomadaEn),
          venceEn,
        },
        select: { id: true },
      });
    });
    const qrTexto = `uniride://encuentro/${nonce}`;
    const [imagen, pasajeros] = await Promise.all([
      QRCode.toBuffer(qrTexto),
      this.viajes.pasajeros(usuarioId, organizacionId, viajeId),
    ]);
    return {
      nonce,
      venceEn,
      qrTexto,
      qrImagenBase64: imagen.toString('base64'),
      pasajeros,
    };
  }

  /** RN-1: el conductor ve enseguida que su código se gastó, también tras un escaneo rechazado. Solo el conductor del viaje. */
  async estadoDesafio(
    usuarioId: string,
    organizacionId: string,
    viajeId: string,
    nonce: string,
  ): Promise<EstadoDesafioDto> {
    const [desafio, pasajeros] = await Promise.all([
      this.prisma.enOrganizacion(organizacionId, (tx) =>
        tx.desafioHandshake.findFirst({
          where: { nonce, viajeId, viaje: { conductorId: usuarioId } },
          select: { usadoEn: true, venceEn: true },
        }),
      ),
      // Lanza 404 si no es su conductor: no se dice nada del código.
      this.viajes.pasajeros(usuarioId, organizacionId, viajeId),
    ]);
    const vigente =
      !!desafio && desafio.usadoEn === null && desafio.venceEn > new Date();
    return { vigente, pasajeros };
  }

  /**
   * HU-22 CA-2…CA-14. El encuentro (común con la bajada) valida y la Tx final deja la reserva `abordada`, la prueba y
   * la llave de trayecto del pasajero.
   */
  async abordar(
    usuarioId: string,
    organizacionId: string,
    reservaId: string,
    dispositivoId: string,
    nonceIntegridad: string,
    dto: AbordarDto,
  ): Promise<AbordajeDto> {
    // Antes de gastar el código: una petición mal formada no consume el del conductor.
    const llavePublica = normalizarLlavePublica(dto.llavePublicaTrayectoPem);
    const v = await this.encuentro(
      'abordaje',
      usuarioId,
      organizacionId,
      reservaId,
      nonceIntegridad,
      dto,
    );
    const llave = {
      organizacionId,
      usuarioId,
      dispositivoId,
      llavePublica,
    };
    // CA-14: idempotente, sin otra prueba. La app creó otra llave de trayecto al escanear y borró la anterior:
    // mientras dura el trayecto, la nueva pasa a ser la vigente (la petición ya vino con huella y del dispositivo activo).
    const yaAbordada = async (r: {
      id: string;
      viajeId: string;
      estado: string;
    }): Promise<AbordajeDto> => {
      if (r.estado !== 'abordada')
        return { estado: 'abordada', yaVerificado: true };
      const { id } = await this.prisma.enOrganizacion(organizacionId, (tx) =>
        this.reemplazarLlave(tx, {
          ...llave,
          viajeId: r.viajeId,
          reservaId: r.id,
        }),
      );
      return { estado: 'abordada', yaVerificado: true, llaveTrayectoId: id };
    };
    if (!('desafioId' in v)) return yaAbordada(v);

    const { reserva } = v;
    const llaveTrayectoId = await this.prisma.enOrganizacion(
      organizacionId,
      async (tx) => {
        // Dos escaneos válidos a la vez: el UPDATE condicional deja ganar a uno.
        const { count } = await tx.reserva.updateMany({
          where: { id: reserva.id, estado: 'confirmada' },
          data: { estado: 'abordada' },
        });
        if (count === 0) return null;
        await this.guardarPrueba(tx, organizacionId, 'abordaje', v);
        const { id } = await this.reemplazarLlave(tx, {
          ...llave,
          viajeId: reserva.viajeId,
          reservaId: reserva.id,
        });
        await this.estadoViaje.recalcular(tx, reserva.viajeId);
        await this.auditar(
          organizacionId,
          usuarioId,
          'reserva.abordaje',
          'ok',
          reserva.id,
          { distanciaM: v.distancia },
          tx,
        );
        return id;
      },
    );
    // Otro escaneo a la vez ganó: queda abordada y la llave de esta petición pasa a ser la vigente.
    return llaveTrayectoId
      ? { estado: 'abordada', yaVerificado: false, llaveTrayectoId }
      : yaAbordada({ ...reserva, estado: 'abordada' });
  }

  /**
   * HU-23 CA-3, CA-4, CA-10…CA-13, CA-15. El mismo encuentro con el código de bajada; aceptado, la Tx final evalúa las
   * dos trayectorias (`evaluarTrayecto`) y deja la reserva `verificada` o `verificacion_fallida`. Es definitiva.
   */
  async bajar(
    usuarioId: string,
    organizacionId: string,
    reservaId: string,
    nonceIntegridad: string,
    dto: EncuentroDto,
  ): Promise<BajadaDto> {
    const v = await this.encuentro(
      'bajada',
      usuarioId,
      organizacionId,
      reservaId,
      nonceIntegridad,
      dto,
    );
    if (!('desafioId' in v)) return this.bajadaHecha(organizacionId, v.id);

    const { reserva } = v;
    const evaluacion = await this.prisma.enOrganizacion(
      organizacionId,
      async (tx) => {
        const ev = await this.evaluar(tx, reserva, usuarioId);
        // Dos bajadas válidas a la vez: gana una y solo ella evalúa.
        const { count } = await tx.reserva.updateMany({
          where: { id: reserva.id, estado: 'abordada' },
          data: { estado: ev.resultado, evaluacion: { ...ev } },
        });
        if (count === 0) return null;
        await this.guardarPrueba(tx, organizacionId, 'bajada', v);
        await this.estadoViaje.recalcular(tx, reserva.viajeId);
        // CA-15 sin coordenadas (RN-8): porcentaje, pares, velocidad y resultado.
        await this.auditar(
          organizacionId,
          usuarioId,
          'reserva.bajada',
          'ok',
          reserva.id,
          { distanciaM: v.distancia, ...ev },
          tx,
        );
        // D-24: el pasaje sigue en garantía y queda la alerta para HU-20 / HU-26.
        if (ev.motivo)
          await this.auditar(
            organizacionId,
            usuarioId,
            'presencia.verificacion_fallida',
            'fallo',
            reserva.id,
            { ...ev },
            tx,
          );
        return ev;
      },
    );
    if (!evaluacion) return this.bajadaHecha(organizacionId, reserva.id);
    return {
      estado: evaluacion.resultado,
      motivo: evaluacion.motivo,
      yaVerificado: false,
    };
  }

  /** Bajada repetida: el resultado ya guardado, sin otra prueba ni otra evaluación. */
  private async bajadaHecha(
    organizacionId: string,
    reservaId: string,
  ): Promise<BajadaDto> {
    const r = await this.prisma.enOrganizacion(organizacionId, (tx) =>
      tx.reserva.findFirstOrThrow({
        where: { id: reservaId },
        select: { estado: true, evaluacion: true },
      }),
    );
    const motivo = (r.evaluacion as Evaluacion | null)?.motivo ?? null;
    return {
      estado: r.estado as BajadaDto['estado'],
      motivo,
      yaVerificado: true,
    };
  }

  /** RN-2 a RN-6 sobre los puntos guardados: el pasajero del abordaje a la bajada; el conductor, ±15 s en los bordes. */
  private async evaluar(
    tx: Transaccion,
    reserva: EncuentroValido['reserva'],
    pasajeroId: string,
  ): Promise<Evaluacion> {
    const abordaje = await tx.pruebaPresencia.findFirstOrThrow({
      where: { reservaId: reserva.id, tipo: 'abordaje', resultado: 'aceptada' },
      select: {
        creadoEn: true,
        reserva: { select: { viaje: { select: { conductorId: true } } } },
      },
    });
    const conductorId = abordaje.reserva.viaje.conductorId;
    const desde = abordaje.creadoEn.getTime();
    const hasta = Date.now();
    const puntos = await tx.puntoGps.findMany({
      where: {
        viajeId: reserva.viajeId,
        usuarioId: { in: [pasajeroId, conductorId] },
        tomadaEn: {
          gte: new Date(desde - DESFASE_PAR_MS),
          lte: new Date(hasta + DESFASE_PAR_MS),
        },
      },
      select: {
        usuarioId: true,
        lat: true,
        lng: true,
        tomadaEn: true,
        simulada: true,
      },
    });
    const pasajero: PuntoTraza[] = [];
    const conductor: PuntoTraza[] = [];
    for (const { usuarioId, tomadaEn, ...resto } of puntos) {
      const punto = { ...resto, tomadaEn: tomadaEn.getTime() };
      if (usuarioId === conductorId) conductor.push(punto);
      else if (punto.tomadaEn >= desde && punto.tomadaEn <= hasta)
        pasajero.push(punto);
    }
    return evaluarTrayecto(pasajero, conductor);
  }

  /** HU-23 CA-1, CA-2, CA-9: posiciones del conductor mientras lleva pasajeros a bordo (RN-8). */
  async posicionesConductor(
    usuarioId: string,
    organizacionId: string,
    viajeId: string,
    llave: LlaveTrayectoFirmante,
    puntos: PosicionDto[],
  ): Promise<PosicionesAceptadasDto> {
    // La llave de un pasajero, o la de otro viaje, no envía la traza del conductor (A-08).
    if (llave.viajeId !== viajeId || llave.reservaId !== null)
      throw firmaTrayectoInvalida();
    return this.prisma.enOrganizacion(organizacionId, async (tx) => {
      // Una sola consulta: el primer abordaje aceptado de un viaje suyo, en curso y con alguien a bordo.
      const primero = await tx.pruebaPresencia.findFirst({
        where: {
          tipo: 'abordaje',
          resultado: 'aceptada',
          reserva: {
            viajeId,
            viaje: {
              conductorId: usuarioId,
              estado: 'en_curso',
              reservas: { some: { estado: 'abordada' } },
            },
          },
        },
        orderBy: { creadoEn: 'asc' },
        select: { creadoEn: true },
      });
      if (!primero) throw viajeNoEnCurso();
      return this.guardarPuntos(tx, {
        organizacionId,
        viajeId,
        usuarioId,
        desde: primero.creadoEn,
        puntos,
      });
    });
  }

  /** HU-23 CA-1, CA-2, CA-9, CA-12: posiciones del pasajero entre su abordaje y su bajada. */
  async posicionesPasajero(
    usuarioId: string,
    organizacionId: string,
    reservaId: string,
    llave: LlaveTrayectoFirmante,
    puntos: PosicionDto[],
  ): Promise<PosicionesAceptadasDto> {
    if (llave.reservaId !== reservaId) throw firmaTrayectoInvalida();
    return this.prisma.enOrganizacion(organizacionId, async (tx) => {
      const abordaje = await tx.pruebaPresencia.findFirst({
        where: {
          reservaId,
          tipo: 'abordaje',
          resultado: 'aceptada',
          reserva: { pasajeroId: usuarioId, estado: 'abordada' },
        },
        select: { creadoEn: true, reserva: { select: { viajeId: true } } },
      });
      // CA-12: tras la bajada la reserva ya no está `abordada` y la app deja de enviar.
      if (!abordaje)
        throw error(409, 'RESERVA_NO_ABORDADA', 'no_abordada', {}, 'trayecto');
      return this.guardarPuntos(tx, {
        organizacionId,
        viajeId: abordaje.reserva.viajeId,
        usuarioId,
        desde: abordaje.creadoEn,
        puntos,
      });
    });
  }

  /** CA-9: los anteriores al abordaje, los del futuro y los repetidos se ignoran sin error. Los simulados se guardan (RN-6). */
  private async guardarPuntos(
    tx: Transaccion,
    d: {
      organizacionId: string;
      viajeId: string;
      usuarioId: string;
      desde: Date;
      puntos: PosicionDto[];
    },
  ): Promise<PosicionesAceptadasDto> {
    const limite = Date.now() + FUTURO_MAXIMO_MS;
    const validos = d.puntos.filter(
      (p) => p.tomadaEn >= d.desde.getTime() && p.tomadaEn <= limite,
    );
    const { count } = await tx.puntoGps.createMany({
      data: validos.map((p) => ({
        organizacionId: d.organizacionId,
        viajeId: d.viajeId,
        usuarioId: d.usuarioId,
        lat: p.lat,
        lng: p.lng,
        precisionM: p.precisionM,
        tomadaEn: new Date(p.tomadaEn),
        simulada: p.simulada,
      })),
      skipDuplicates: true,
    });
    return { aceptados: count, ignorados: d.puntos.length - count };
  }

  /**
   * Encuentro de HU-22, para abordaje y bajada (HU-23 RN-7). Tx 1 consume el código y se confirma siempre (RN-1: cada
   * escaneo lo gasta). Luego se valida, de lo barato a lo caro (Play Integrity al final). Devuelve la reserva sin más si
   * ese encuentro ya se hizo (repetirlo no crea otra prueba); si no, lo validado, que la Tx final de cada tipo guarda.
   */
  private async encuentro(
    tipo: TipoEncuentro,
    usuarioId: string,
    organizacionId: string,
    reservaId: string,
    nonceIntegridad: string,
    dto: EncuentroDto,
  ): Promise<
    EncuentroValido | { id: string; viajeId: string; estado: string }
  > {
    const { previo, hecho, accion } = ENCUENTRO[tipo];
    const ahora = new Date();
    const { reserva, desafio } = await this.prisma.enOrganizacion(
      organizacionId,
      async (tx) => {
        const reserva = await tx.reserva.findFirst({
          where: { id: reservaId, pasajeroId: usuarioId },
          select: { id: true, viajeId: true, estado: true },
        });
        // Por `tipo`: un código de abordaje no sirve para bajar ni al revés (A-05).
        const [desafio] = await tx.desafioHandshake.updateManyAndReturn({
          where: {
            nonce: dto.nonce,
            tipo,
            usadoEn: null,
            venceEn: { gt: ahora },
          },
          data: { usadoEn: ahora, reservaId: reserva?.id ?? null },
        });
        return { reserva, desafio };
      },
    );

    // Sin reserva propia no hay prueba que registrar: solo auditoría (HU-22 CA-13).
    if (!reserva) {
      await this.auditar(
        organizacionId,
        usuarioId,
        accion,
        'fallo',
        reservaId,
        { motivo: 'sin_reserva' },
      );
      throw RECHAZOS.sin_reserva(tipo);
    }
    if (hecho.includes(reserva.estado)) return reserva;

    const p = dto.posicion;
    const rechazar = async (
      motivo: MotivoRechazo,
      datos: { distancia?: number; veredicto?: string; detalle?: string } = {},
    ): Promise<never> => {
      await this.prisma.enOrganizacion(organizacionId, async (tx) => {
        await tx.pruebaPresencia.create({
          data: {
            organizacionId,
            reservaId: reserva.id,
            desafioId: desafio?.id ?? null,
            tipo,
            pasajeroLat: p.lat,
            pasajeroLng: p.lng,
            pasajeroPrecisionM: p.precisionM,
            distanciaM:
              datos.distancia === undefined ? null : redondear(datos.distancia),
            veredictoIntegridad: datos.veredicto ?? null,
            resultado: 'rechazada',
            motivo: datos.detalle ?? motivo,
          },
          select: { id: true },
        });
        await this.auditar(
          organizacionId,
          usuarioId,
          accion,
          'fallo',
          reserva.id,
          { motivo: datos.detalle ?? motivo },
          tx,
        );
      });
      throw RECHAZOS[motivo](tipo, datos.distancia);
    };

    if (!desafio) return rechazar('codigo_invalido');
    if (desafio.viajeId !== reserva.viajeId) return rechazar('sin_reserva');
    if (reserva.estado !== previo)
      return rechazar(tipo === 'bajada' ? 'no_abordada' : 'sin_reserva');
    const motivo = motivoPosicionInvalida(p, ahora.getTime());
    if (motivo) return rechazar(motivo);
    const conductor: Posicion = {
      lat: desafio.conductorLat,
      lng: desafio.conductorLng,
      precisionM: desafio.conductorPrecisionM,
      tomadaEn: desafio.conductorTomadaEn.getTime(),
      simulada: false,
    };
    const distancia = redondear(distanciaM(conductor, p));
    if (distancia > DISTANCIA_MAXIMA_M)
      return rechazar('distancia', { distancia });

    let integridad: ResultadoIntegridad;
    try {
      integridad = await this.verificarIntegridad(
        dto.tokenIntegridad,
        nonceIntegridad,
        tipo,
      );
    } catch {
      return rechazar('servicio_no_disponible', { distancia });
    }
    if (!integridad.integro)
      return rechazar('no_integro', {
        distancia,
        veredicto: integridad.veredicto,
        detalle: integridad.motivo,
      });

    const hashPrueba = createHash('sha256')
      .update(
        JSON.stringify({
          reservaId: reserva.id,
          tipo,
          nonce: desafio.nonce,
          conductor: {
            lat: conductor.lat,
            lng: conductor.lng,
            tomadaEn: desafio.conductorTomadaEn.toISOString(),
          },
          pasajero: {
            lat: p.lat,
            lng: p.lng,
            tomadaEn: new Date(p.tomadaEn).toISOString(),
          },
          distanciaM: distancia,
          veredicto: integridad.veredicto,
        }),
      )
      .digest('hex');
    return {
      reserva,
      desafioId: desafio.id,
      posicion: p,
      distancia,
      veredicto: integridad.veredicto,
      hashPrueba,
    };
  }

  /** CA-13 de HU-22: la prueba aceptada de un encuentro. */
  private guardarPrueba(
    tx: Transaccion,
    organizacionId: string,
    tipo: TipoEncuentro,
    v: EncuentroValido,
  ) {
    return tx.pruebaPresencia.create({
      data: {
        organizacionId,
        reservaId: v.reserva.id,
        desafioId: v.desafioId,
        tipo,
        pasajeroLat: v.posicion.lat,
        pasajeroLng: v.posicion.lng,
        pasajeroPrecisionM: v.posicion.precisionM,
        distanciaM: v.distancia,
        veredictoIntegridad: v.veredicto,
        resultado: 'aceptada',
        hashPrueba: v.hashPrueba,
      },
      select: { id: true },
    });
  }

  /** Una llave vigente por persona y viaje: registrar otra revoca la anterior. */
  private async reemplazarLlave(
    tx: Transaccion,
    datos: {
      organizacionId: string;
      viajeId: string;
      reservaId?: string;
      usuarioId: string;
      dispositivoId: string;
      llavePublica: string;
    },
  ) {
    await tx.llaveTrayecto.updateMany({
      where: {
        viajeId: datos.viajeId,
        usuarioId: datos.usuarioId,
        revocadaEn: null,
      },
      data: { revocadaEn: new Date() },
    });
    return tx.llaveTrayecto.create({ data: datos, select: { id: true } });
  }

  /** Lanza el 503 propio si Google no responde (spec §4). En el abordaje el código ya quedó gastado (RN-1). */
  private async verificarIntegridad(
    token: string,
    nonce: string,
    tipo: TipoEncuentro = 'abordaje',
  ): Promise<ResultadoIntegridad> {
    try {
      return await this.integridad.verificar(token, nonce);
    } catch {
      throw RECHAZOS.servicio_no_disponible(tipo);
    }
  }

  private auditar(
    organizacionId: string,
    actorId: string,
    accion: string,
    resultado: 'ok' | 'fallo',
    entidadId: string,
    detalle: Record<string, unknown>,
    tx?: Transaccion,
  ) {
    return this.auditoria.registrar(
      {
        accion,
        entidad: accion === 'trayecto.llave' ? 'viaje' : 'reserva',
        entidadId,
        resultado,
        actorId,
        organizacionId,
        detalle,
      },
      tx,
    );
  }
}

/** RN-3 / CA-11: fuera de la ventana no se emite nada y se dice desde y hasta cuándo. */
function exigirVentana(salida: Date, ahora = Date.now()): void {
  const { desde, hasta } = ventanaAbordaje(salida);
  if (ahora < desde.getTime() || ahora > hasta.getTime())
    throw error(409, 'FUERA_DE_VENTANA', 'fuera_de_ventana', {
      desde: desde.toISOString(),
      hasta: hasta.toISOString(),
    });
}
