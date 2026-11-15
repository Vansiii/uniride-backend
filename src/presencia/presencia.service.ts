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
  CrearDesafioDto,
  DesafioDto,
  EstadoDesafioDto,
  LlaveTrayectoCreadaDto,
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

const CLAVE = 'presencia.abordaje';
const error = (estado: number, codigo: string, clave: string, extra = {}) =>
  new ErrorNegocio(estado, codigo, `${CLAVE}.${clave}`, extra);

/** Respuesta de cada motivo de rechazo del abordaje (spec §4). */
const RECHAZOS = {
  codigo_invalido: () => error(409, 'CODIGO_INVALIDO', 'codigo_invalido'),
  sin_reserva: () => error(409, 'SIN_RESERVA', 'sin_reserva'),
  ubicacion_simulada: () =>
    error(422, 'UBICACION_SIMULADA', 'ubicacion_simulada'),
  senal_gps: () => error(422, 'SENAL_GPS', 'senal_gps'),
  distancia: (distancia: number) =>
    error(422, 'DISTANCIA', 'distancia', { distanciaM: Math.round(distancia) }),
  no_integro: () => error(422, 'DISPOSITIVO_NO_INTEGRO', 'integridad'),
  servicio_no_disponible: () =>
    error(503, 'SERVICIO_NO_DISPONIBLE', 'servicio_no_disponible'),
};
type MotivoRechazo = keyof typeof RECHAZOS;

const ESTADOS_YA_ABORDADA = ['abordada', 'verificada', 'pagada'];
const TIPO = 'abordaje';
const YA_VERIFICADO: AbordajeDto = { estado: 'abordada', yaVerificado: true };

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
          reservas: {
            where: { estado: { in: ['confirmada', ...ESTADOS_YA_ABORDADA] } },
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
    exigirVentana(viaje.fechaHoraSalida);
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
      throw RECHAZOS.no_integro();
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

  /** CA-1, CA-11: código nuevo firmado con la llave de trayecto del conductor, sin huella (D-22). */
  async crearDesafio(
    usuarioId: string,
    organizacionId: string,
    viajeId: string,
    llave: LlaveTrayectoFirmante,
    dto: CrearDesafioDto,
  ): Promise<DesafioDto> {
    // La llave de un pasajero, o la de otro viaje, no emite códigos de este.
    if (llave.viajeId !== viajeId || llave.reservaId !== null)
      throw new ErrorNegocio(
        401,
        'FIRMA_TRAYECTO_INVALIDA',
        'comun.errores.firma_invalida',
      );
    const motivo = motivoPosicionInvalida(dto.posicion);
    if (motivo) throw RECHAZOS[motivo]();

    const nonce = randomBytes(32).toString('base64url');
    const venceEn = new Date(Date.now() + VIDA_DESAFIO_MS);
    await this.prisma.enOrganizacion(organizacionId, async (tx) => {
      const viaje = await tx.viaje.findFirst({
        where: { id: viajeId, organizacionId, conductorId: usuarioId },
        select: { fechaHoraSalida: true },
      });
      if (!viaje)
        throw new ErrorNegocio(
          404,
          'VIAJE_NO_ENCONTRADO',
          'viajes.detalle.no_encontrado',
        );
      exigirVentana(viaje.fechaHoraSalida);
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
   * CA-2…CA-14. Tx 1 consume el código y se confirma siempre (RN-1: cada escaneo lo gasta). Luego se valida, de lo
   * barato a lo caro (Play Integrity al final), y la Tx 2 deja la reserva `abordada`, la prueba y la llave del pasajero.
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
    const ahora = new Date();
    const { reserva, desafio } = await this.prisma.enOrganizacion(
      organizacionId,
      async (tx) => {
        const reserva = await tx.reserva.findFirst({
          where: { id: reservaId, pasajeroId: usuarioId },
          select: { id: true, viajeId: true, estado: true },
        });
        const [desafio] = await tx.desafioHandshake.updateManyAndReturn({
          where: {
            nonce: dto.nonce,
            tipo: TIPO,
            usadoEn: null,
            venceEn: { gt: ahora },
          },
          data: { usadoEn: ahora, reservaId: reserva?.id ?? null },
        });
        return { reserva, desafio };
      },
    );

    // Sin reserva propia no hay prueba que registrar: solo auditoría (CA-13).
    if (!reserva) {
      await this.auditar(
        organizacionId,
        usuarioId,
        'reserva.abordaje',
        'fallo',
        reservaId,
        { motivo: 'sin_reserva' },
      );
      throw RECHAZOS.sin_reserva();
    }
    // CA-14: idempotente, sin otra prueba. La app creó otra llave de trayecto al escanear y borró la anterior:
    // mientras dura el trayecto, la nueva pasa a ser la vigente (la petición ya vino con huella y del dispositivo activo).
    if (ESTADOS_YA_ABORDADA.includes(reserva.estado)) {
      if (reserva.estado === 'abordada')
        await this.prisma.enOrganizacion(organizacionId, (tx) =>
          this.reemplazarLlave(tx, {
            organizacionId,
            viajeId: reserva.viajeId,
            reservaId: reserva.id,
            usuarioId,
            dispositivoId,
            llavePublica,
          }),
        );
      return YA_VERIFICADO;
    }

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
            tipo: TIPO,
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
          'reserva.abordaje',
          'fallo',
          reserva.id,
          { motivo: datos.detalle ?? motivo },
          tx,
        );
      });
      throw motivo === 'distancia'
        ? RECHAZOS.distancia(datos.distancia ?? 0)
        : RECHAZOS[motivo as Exclude<MotivoRechazo, 'distancia'>]();
    };

    if (!desafio) return rechazar('codigo_invalido');
    if (desafio.viajeId !== reserva.viajeId || reserva.estado !== 'confirmada')
      return rechazar('sin_reserva');
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
          tipo: TIPO,
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

    const abordada = await this.prisma.enOrganizacion(
      organizacionId,
      async (tx) => {
        // Dos escaneos válidos a la vez: el UPDATE condicional deja ganar a uno.
        const { count } = await tx.reserva.updateMany({
          where: { id: reserva.id, estado: 'confirmada' },
          data: { estado: 'abordada' },
        });
        if (count === 0) return false;
        await tx.pruebaPresencia.create({
          data: {
            organizacionId,
            reservaId: reserva.id,
            desafioId: desafio.id,
            tipo: TIPO,
            pasajeroLat: p.lat,
            pasajeroLng: p.lng,
            pasajeroPrecisionM: p.precisionM,
            distanciaM: distancia,
            veredictoIntegridad: integridad.veredicto,
            resultado: 'aceptada',
            hashPrueba,
          },
          select: { id: true },
        });
        await this.reemplazarLlave(tx, {
          organizacionId,
          viajeId: reserva.viajeId,
          reservaId: reserva.id,
          usuarioId,
          dispositivoId,
          llavePublica,
        });
        await this.estadoViaje.recalcular(tx, reserva.viajeId);
        await this.auditar(
          organizacionId,
          usuarioId,
          'reserva.abordaje',
          'ok',
          reserva.id,
          { distanciaM: distancia },
          tx,
        );
        return true;
      },
    );
    return abordada
      ? { estado: 'abordada', yaVerificado: false }
      : YA_VERIFICADO;
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
  ): Promise<ResultadoIntegridad> {
    try {
      return await this.integridad.verificar(token, nonce);
    } catch {
      throw RECHAZOS.servicio_no_disponible();
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
