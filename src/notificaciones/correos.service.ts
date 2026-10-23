import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService, type Transaccion } from '../comun/prisma.service.js';
import { crearEnviador, type Enviador } from './enviador.js';
import { renderizar } from './plantillas.js';

const MAX_INTENTOS = 5;
const CADA_MS = 30_000;
const LOTE = 10;

export interface CorreoNuevo {
  destinatario: string;
  plantilla: string;
  datos: Record<string, unknown>;
  referenciaTipo?: string;
  referenciaId?: string;
}

/** Cola `correos_salientes` y worker con reintentos: un fallo de correo nunca revierte la operación de negocio. */
@Injectable()
export class CorreosService implements OnModuleInit, OnModuleDestroy {
  private readonly registro = new Logger(CorreosService.name);
  private temporizador?: NodeJS.Timeout;
  /** Reemplazable en pruebas. */
  enviador?: Enviador;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    // En pruebas se llama a `procesarPendientes()` a mano.
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
  async encolar(tx: Transaccion, correo: CorreoNuevo): Promise<void> {
    await tx.correoSaliente.create({
      data: { ...correo, datos: correo.datos as object },
    });
  }

  /** Envía los correos vencidos de la cola; devuelve cuántos salieron. */
  async procesarPendientes(): Promise<number> {
    this.enviador ??= crearEnviador();
    return this.prisma.$transaction(
      async (tx) => {
        // SKIP LOCKED: dos workers no toman el mismo correo.
        const filas = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM correos_salientes
          WHERE estado = 'pendiente' AND proximo_intento_en <= now()
          ORDER BY proximo_intento_en LIMIT ${LOTE} FOR UPDATE SKIP LOCKED`;
        let enviados = 0;
        for (const { id } of filas) {
          const c = await tx.correoSaliente.findUniqueOrThrow({
            where: { id },
          });
          try {
            await this.enviador!.enviar(
              c.destinatario,
              renderizar(c.plantilla, c.datos as Record<string, unknown>),
            );
            // Se borra `datos`: puede llevar el enlace con el token de la invitación.
            await tx.correoSaliente.update({
              where: { id },
              data: { estado: 'enviado', datos: {}, ultimoError: null },
            });
            enviados++;
          } catch (error) {
            const intentos = c.intentos + 1;
            await tx.correoSaliente.update({
              where: { id },
              data: {
                intentos,
                estado: intentos >= MAX_INTENTOS ? 'fallido' : 'pendiente',
                // Espera creciente: 2, 4, 8, 16 minutos.
                proximoIntentoEn: new Date(Date.now() + 2 ** intentos * 60_000),
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
