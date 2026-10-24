import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';

export type Transaccion = Prisma.TransactionClient;

/** Cliente de base de datos con el rol `uniride_app` (sin dueño, RLS forzado). */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Ejecuta `fn` en una transacción donde RLS solo deja ver la organización dada (A-13). */
  enOrganizacion<T>(
    organizacionId: string,
    fn: (tx: Transaccion) => Promise<T>,
  ): Promise<T> {
    return this.conContexto('app.organizacion_id', organizacionId, fn);
  }

  /** Contexto de plataforma: RLS deja ver todas las organizaciones. Solo para super admin y tareas del sistema. */
  comoSuperAdmin<T>(fn: (tx: Transaccion) => Promise<T>): Promise<T> {
    return this.conContexto('app.super_admin', 'true', fn);
  }

  private conContexto<T>(
    clave: string,
    valor: string,
    fn: (tx: Transaccion) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      // El tercer argumento `true` limita el valor a esta transacción.
      await tx.$executeRaw`SELECT set_config(${clave}, ${valor}, true)`;
      return fn(tx);
    });
  }
}
