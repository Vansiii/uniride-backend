import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService, type Transaccion } from '../comun/prisma.service.js';
import { t } from '../i18n/t.js';
import {
  crearEnviadorPush,
  TokenPushInvalido,
  type EnviadorPush,
  type Push,
} from './fcm.js';

const MAX_INTENTOS = 5;
const CADA_MS = 5_000;
const LOTE = 20;

const rellenar = (clave: string, datos: Record<string, unknown>) =>
  t(clave).replace(/\{(\w+)\}/g, (_, k) => String(datos[k] ?? ''));

/** Textos es-BO de `push.<plantilla>.titulo` y `.cuerpo`; `ruta` es la pantalla que abre al tocarlo. */
export function renderizarPush(
  plantilla: string,
  datos: Record<string, unknown>,
): Push {
  return {
    titulo: rellenar(`push.${plantilla}.titulo`, datos),
    cuerpo: rellenar(`push.${plantilla}.cuerpo`, datos),
    ruta: typeof datos.ruta === 'string' ? datos.ruta : undefined,
  };
}

/**
 * PB-09: cola `notificaciones_push` y worker con reintentos, como `CorreosService`. Un aviso nunca revierte la
 * operación de negocio ni decide nada: solo informa de lo que el servidor ya hizo (principio 1 de AGENTS.md §5).
 */
@Injectable()
export class PushService implements OnModuleInit, OnModuleDestroy {
  private readonly registro = new Logger(PushService.name);
  private temporizador?: NodeJS.Timeout;
  /** Reemplazable en pruebas; `null` = apagado. */
  enviador?: EnviadorPush | null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.temporizador = setInterval(
      () => this.procesarPendientes().catch((e) => this.registro.error(e)),
      CADA_MS,
    );
  }

  onModuleDestroy(): void {
    clearInterval(this.temporizador);
  }

  /** Se encola dentro de la transacción del llamador: o quedan ambos o ninguno. */
  async encolar(
    tx: Transaccion,
    usuarioId: string,
    plantilla: string,
    datos: Record<string, unknown> = {},
  ): Promise<void> {
    await tx.notificacionPush.create({
      data: { usuarioId, plantilla, datos: datos as object },
    });
  }

  /** El token es de un solo usuario: si otra cuenta lo tenía (mismo teléfono), se le quita. */
  async guardarToken(usuarioId: string, token: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.usuario.updateMany({
        where: { tokenPush: token, NOT: { id: usuarioId } },
        data: { tokenPush: null },
      }),
      this.prisma.usuario.update({
        where: { id: usuarioId },
        data: { tokenPush: token },
      }),
    ]);
  }

  async quitarToken(usuarioId: string): Promise<void> {
    await this.prisma.usuario.update({
      where: { id: usuarioId },
      data: { tokenPush: null },
    });
  }

  /** Envía los avisos vencidos de la cola; devuelve cuántos salieron. */
  async procesarPendientes(): Promise<number> {
    if (this.enviador === undefined) this.enviador = crearEnviadorPush();
    const enviador = this.enviador;
    if (!enviador) return 0;
    return this.prisma.$transaction(
      async (tx) => {
        // SKIP LOCKED: dos workers no toman el mismo aviso.
        const filas = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM notificaciones_push
          WHERE estado = 'pendiente' AND proximo_intento_en <= now()
          ORDER BY proximo_intento_en LIMIT ${LOTE} FOR UPDATE SKIP LOCKED`;
        let enviados = 0;
        for (const { id } of filas) {
          const n = await tx.notificacionPush.findUniqueOrThrow({
            where: { id },
            include: { usuario: { select: { tokenPush: true } } },
          });
          const token = n.usuario.tokenPush;
          // Sin sesión en ningún teléfono: no hay a quién avisar (el correo y la app siguen informando).
          if (!token) {
            await tx.notificacionPush.update({
              where: { id },
              data: { estado: 'sin_token' },
            });
            continue;
          }
          try {
            await enviador.enviar(
              token,
              renderizarPush(n.plantilla, n.datos as Record<string, unknown>),
            );
            await tx.notificacionPush.update({
              where: { id },
              data: { estado: 'enviado', ultimoError: null },
            });
            enviados++;
          } catch (error) {
            if (error instanceof TokenPushInvalido) {
              await tx.usuario.updateMany({
                where: { tokenPush: token },
                data: { tokenPush: null },
              });
              await tx.notificacionPush.update({
                where: { id },
                data: { estado: 'sin_token', ultimoError: error.message },
              });
              continue;
            }
            const intentos = n.intentos + 1;
            await tx.notificacionPush.update({
              where: { id },
              data: {
                intentos,
                estado: intentos >= MAX_INTENTOS ? 'fallido' : 'pendiente',
                // Espera creciente: 20, 40, 80, 160 s. Un aviso tardío pierde sentido.
                proximoIntentoEn: new Date(Date.now() + 2 ** intentos * 10_000),
                ultimoError: String(error).slice(0, 500),
              },
            });
          }
        }
        return enviados;
      },
      { timeout: 60_000 },
    );
  }
}
