import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService, type Transaccion } from '../comun/prisma.service.js';
import { CorreosService } from '../notificaciones/correos.service.js';

export const PROPOSITOS_OTP = [
  'registro',
  'agregar_organizacion',
  'recuperacion',
] as const;
export type PropositoOtp = (typeof PROPOSITOS_OTP)[number];

/**
 * `aviso`: fila señuelo. Se envía esa plantilla en lugar del código (nadie lo conoce), pero
 * límites, bloqueo y respuestas son los de un código real: así no se revela si el correo tiene cuenta (HU-05 CA-7).
 * `senuelo`: igual, pero no se envía nada (HU-34 CA-2: correo sin cuenta).
 */
export type DatosOtp = Record<string, unknown> & {
  aviso?: string;
  senuelo?: boolean;
};

/** Van por la cola: una falla del correo no cambia la respuesta ni revela si la cuenta existe (HU-34). */
const POR_COLA: readonly PropositoOtp[] = ['recuperacion'];

const MINUTO_MS = 60 * 1000;
const VIGENCIA_MS = 10 * MINUTO_MS;
const BLOQUEO_MS = 15 * MINUTO_MS;
const HORA_MS = 60 * MINUTO_MS;
const MAX_INTENTOS = 5;
const MAX_ENVIOS_HORA = 5;

const invalido = () =>
  new ErrorNegocio(400, 'OTP_INVALIDO', 'autenticacion.otp.invalido');
const bloqueado = (hasta: Date) =>
  new ErrorNegocio(429, 'OTP_BLOQUEADO', 'autenticacion.otp.bloqueado', {
    reintentarEn: hasta.toISOString(),
  });

/** Cuándo se puede enviar otro código, dados los envíos de la última hora en orden (RN-4: 1/min y 5/h). */
export function proximoEnvio(creados: Date[]): Date | null {
  if (creados.length === 0) return null;
  const porMinuto = creados[creados.length - 1].getTime() + MINUTO_MS;
  const porHora =
    creados.length >= MAX_ENVIOS_HORA
      ? creados[creados.length - MAX_ENVIOS_HORA].getTime() + HORA_MS
      : 0;
  return new Date(Math.max(porMinuto, porHora));
}

/** Códigos de 6 dígitos de un solo uso por correo y propósito (HU-05; lo reutilizan HU-07 y HU-34). */
@Injectable()
export class OtpService {
  private readonly registro = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly correos: CorreosService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Invalida los códigos anteriores, guarda el nuevo (solo su HMAC) y lo envía en el momento; si el correo falla, no queda nada.
   * Los propósitos de `POR_COLA` lo encolan en la misma transacción.
   */
  generar(
    correo: string,
    proposito: PropositoOtp,
    datos: DatosOtp,
  ): Promise<{ reenviarEn: Date }> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.serializar(tx, correo, proposito);
        const ahora = new Date();
        const enBloqueo = await tx.codigoOtp.findFirst({
          where: { correo, proposito, bloqueadoHasta: { gt: ahora } },
        });
        // CA-4: pedir otro código no levanta el bloqueo.
        if (enBloqueo) throw bloqueado(enBloqueo.bloqueadoHasta!);
        const recientes = (
          await tx.codigoOtp.findMany({
            where: {
              correo,
              proposito,
              creadoEn: { gt: new Date(ahora.getTime() - HORA_MS) },
            },
            orderBy: { creadoEn: 'asc' },
            select: { creadoEn: true },
          })
        ).map((f) => f.creadoEn);
        const desde = proximoEnvio(recientes);
        if (desde && desde > ahora)
          throw new ErrorNegocio(
            429,
            'OTP_LIMITE_REENVIO',
            'autenticacion.otp.limite_reenvio',
            { reenviarEn: desde.toISOString() },
          );
        const anterior = await tx.codigoOtp.findFirst({
          where: { correo, proposito },
          orderBy: { creadoEn: 'desc' },
        });
        // CA-6: el código anterior deja de servir; se borran sus datos (llevan el hash de la contraseña).
        await tx.codigoOtp.updateMany({
          where: { correo, proposito, usadoEn: null, invalidadoEn: null },
          data: { invalidadoEn: ahora, datos: {} },
        });
        const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
        await tx.codigoOtp.create({
          data: {
            correo,
            proposito,
            hashCodigo: hmacDe(correo, proposito, codigo),
            datos: datos as object,
            venceEn: new Date(ahora.getTime() + VIGENCIA_MS),
            // Los errores son "seguidos" por correo: un código nuevo no los borra (CA-4).
            intentos: anterior && !anterior.usadoEn ? anterior.intentos : 0,
            creadoEn: ahora,
          },
        });
        // La fila señuelo no envía nada: solo iguala límites y respuestas.
        if (!datos.senuelo)
          await this.enviar(tx, correo, proposito, datos, codigo);
        return { reenviarEn: proximoEnvio([...recientes, ahora])! };
      },
      { timeout: 20_000 },
    );
  }

  private async enviar(
    tx: Transaccion,
    correo: string,
    proposito: PropositoOtp,
    datos: DatosOtp,
    codigo: string,
  ): Promise<void> {
    const plantilla = datos.aviso ?? `otp_${proposito}`;
    const variables = { codigo, minutos: VIGENCIA_MS / MINUTO_MS };
    if (POR_COLA.includes(proposito)) {
      await this.correos.encolar(tx, {
        destinatario: correo,
        plantilla,
        datos: variables,
      });
      return;
    }
    try {
      await this.correos.enviarAhora(correo, plantilla, variables);
    } catch (error) {
      this.registro.error(`Envío de OTP fallido: ${String(error)}`);
      throw new ErrorNegocio(
        503,
        'CORREO_NO_DISPONIBLE',
        'autenticacion.registro.correo_no_disponible',
      );
    }
  }

  /** CA-6: otro código con los mismos datos. Sin código pendiente responde igual y no envía nada (no revela si existe). */
  async reenviar(
    correo: string,
    proposito: PropositoOtp,
  ): Promise<{ reenviarEn: Date }> {
    const ultima = await this.prisma.codigoOtp.findFirst({
      where: { correo, proposito },
      orderBy: { creadoEn: 'desc' },
    });
    if (!ultima || ultima.usadoEn)
      return { reenviarEn: new Date(Date.now() + MINUTO_MS) };
    return this.generar(correo, proposito, ultima.datos as DatosOtp);
  }

  /**
   * Consume el código dentro de la transacción del llamador y devuelve sus datos. El fallo se cuenta
   * fuera de ella, para que quede aunque el llamador revierta (CA-4).
   */
  async verificar(
    tx: Transaccion,
    correo: string,
    proposito: PropositoOtp,
    codigo: string,
  ): Promise<DatosOtp> {
    await this.serializar(tx, correo, proposito);
    const ahora = new Date();
    const fila = await tx.codigoOtp.findFirst({
      where: { correo, proposito },
      orderBy: { creadoEn: 'desc' },
    });
    if (fila?.bloqueadoHasta && fila.bloqueadoHasta > ahora)
      throw bloqueado(fila.bloqueadoHasta);
    if (!fila || fila.usadoEn) throw invalido();
    // CA-5: vencido se dice aparte, para ofrecer uno nuevo.
    if (fila.venceEn <= ahora)
      throw new ErrorNegocio(410, 'OTP_VENCIDO', 'autenticacion.otp.vencido');
    const datos = fila.datos as DatosOtp;
    if (
      !coinciden(fila.hashCodigo, hmacDe(correo, proposito, codigo)) ||
      datos.aviso ||
      datos.senuelo
    ) {
      const hasta = await this.registrarFallo(fila.id);
      throw hasta ? bloqueado(hasta) : invalido();
    }
    // Un solo uso: de dos verificaciones simultáneas, solo una consume.
    const { count } = await tx.codigoOtp.updateMany({
      where: { id: fila.id, usadoEn: null },
      data: { usadoEn: ahora, datos: {} },
    });
    if (count === 0) throw invalido();
    return datos;
  }

  /** Suma un error; al quinto bloquea 15 minutos y devuelve hasta cuándo. */
  private async registrarFallo(id: string): Promise<Date | null> {
    const { intentos } = await this.prisma.codigoOtp.update({
      where: { id },
      data: { intentos: { increment: 1 } },
    });
    if (intentos < MAX_INTENTOS) return null;
    const hasta = new Date(Date.now() + BLOQUEO_MS);
    await this.prisma.codigoOtp.update({
      where: { id },
      data: { intentos: 0, bloqueadoHasta: hasta },
    });
    await this.auditoria.registrar({
      accion: 'otp.bloqueo',
      entidad: 'codigo_otp',
      entidadId: id,
      resultado: 'fallo',
    });
    return hasta;
  }

  /** Una operación a la vez por correo y propósito: un doble envío no deja dos códigos vigentes. */
  private async serializar(
    tx: Transaccion,
    correo: string,
    proposito: PropositoOtp,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`otp:${proposito}:${correo}`}))`;
  }
}

function hmacDe(correo: string, proposito: string, codigo: string): string {
  const secreto = process.env.OTP_SECRETO;
  if (!secreto) throw new Error('OTP_SECRETO no está configurado');
  return createHmac('sha256', secreto)
    .update(`${proposito}:${correo}:${codigo}`)
    .digest('hex');
}

function coinciden(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}
