import { randomBytes } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { hexlify, Wallet } from 'ethers';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import {
  BlockchainService,
  formatearUrc,
} from '../blockchain/blockchain.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService } from '../comun/prisma.service.js';
import { cifrarLlave, claveCustodia } from './custodia.js';
import type { BilleteraDto } from './dto/billetera.dto.js';

const noDisponible = () =>
  new ErrorNegocio(
    503,
    'SERVICIO_BLOCKCHAIN_NO_DISPONIBLE',
    'billetera.creacion.servicio_no_disponible',
  );

/** Solo id y dirección: `llave_custodia_ref` no sale de `crear` (A-12). */
const COLUMNAS_PUBLICAS = { id: true, direccion: true } as const;
export interface FilaPublica {
  id: string;
  direccion: string;
}

/** Tipo de error sin su mensaje: el de ethers lleva la URL del nodo y el de la BD puede traer la fila. */
export const tipoDeError = (error: unknown) => {
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  return String(code ?? name ?? 'Error');
};

@Injectable()
export class BilleteraService implements OnModuleInit {
  private readonly registro = new Logger(BilleteraService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly blockchain: BlockchainService,
  ) {}

  /** Sin `WALLET_ENCRYPTION_KEY` válida el arranque falla (salvo en pruebas, donde el helper la define). */
  onModuleInit(): void {
    if (process.env.NODE_ENV !== 'test') claveCustodia();
  }

  async exigirCuentaActiva(usuarioId: string): Promise<void> {
    const usuario = await this.prisma.usuario.findUnique({
      where: { id: usuarioId },
      select: { suspendidaEn: true },
    });
    if (usuario?.suspendidaEn)
      throw new ErrorNegocio(
        403,
        'CUENTA_SUSPENDIDA',
        'billetera.creacion.cuenta_suspendida',
      );
  }

  /**
   * Idempotente (CA-2, A-02): con billetera existente la devuelve. La cadena se comprueba antes de insertar, así una
   * falla responde 503 sin filas a medias (CA-6). El UNIQUE de `usuario_id` decide entre peticiones simultáneas.
   */
  async crear(
    usuarioId: string,
  ): Promise<{ billetera: BilleteraDto; creada: boolean }> {
    const existente = await this.buscar(usuarioId);
    if (existente)
      return { billetera: await this.aDto(existente), creada: false };

    const { direccion, llaveCustodiaRef, saldo } = await this.prepararNueva();
    try {
      const fila = await this.prisma.$transaction(async (tx) => {
        const creada = await tx.billetera.create({
          data: { usuarioId, direccion, llaveCustodiaRef },
          select: COLUMNAS_PUBLICAS,
        });
        await this.auditoria.registrar(
          {
            accion: 'billetera.creacion',
            entidad: 'billetera',
            entidadId: creada.id,
            resultado: 'ok',
            actorId: usuarioId,
          },
          tx,
        );
        return creada;
      });
      return { billetera: this.dto(fila, saldo), creada: true };
    } catch (error) {
      const ganadora =
        (error as { code?: string }).code === 'P2002'
          ? await this.buscar(usuarioId)
          : null;
      if (ganadora)
        return { billetera: await this.aDto(ganadora), creada: false };
      this.registro.error(
        `No se pudo guardar la billetera (${tipoDeError(error)})`,
      );
      throw noDisponible();
    }
  }

  async mia(usuarioId: string): Promise<BilleteraDto> {
    return this.aDto(await this.exigir(usuarioId));
  }

  async exigir(usuarioId: string): Promise<FilaPublica> {
    const fila = await this.buscar(usuarioId);
    if (!fila)
      throw new ErrorNegocio(
        404,
        'BILLETERA_NO_ENCONTRADA',
        'billetera.consulta.no_encontrada',
      );
    return fila;
  }

  /**
   * CA-1: al aprobarse la identidad. Nunca rechaza, para no revertir la verificación: la falla queda registrada
   * y `POST /billetera` sirve para reintentar.
   */
  async crearAutomatica(usuarioId: string): Promise<void> {
    try {
      await this.exigirCuentaActiva(usuarioId);
      await this.crear(usuarioId);
    } catch (error) {
      const motivo =
        error instanceof ErrorNegocio ? error.codigo : tipoDeError(error);
      this.registro.error(`Billetera automática sin crear (${motivo})`);
      await this.auditoria
        .registrar({
          accion: 'billetera.creacion',
          entidad: 'billetera',
          resultado: 'fallo',
          actorId: usuarioId,
          detalle: { motivo },
        })
        .catch(() =>
          this.registro.warn('No se pudo auditar la billetera sin crear'),
        );
    }
  }

  private buscar(usuarioId: string): Promise<FilaPublica | null> {
    return this.prisma.billetera.findUnique({
      where: { usuarioId },
      select: COLUMNAS_PUBLICAS,
    });
  }

  /** Genera la llave sin frase semilla y la cifra; se descarta si la cadena no responde. */
  private async prepararNueva() {
    try {
      const cuenta = new Wallet(hexlify(randomBytes(32)));
      const direccion = cuenta.address;
      const llaveCustodiaRef = cifrarLlave(cuenta.privateKey, direccion);
      const saldo = await this.blockchain.cadena.leerSaldo(direccion);
      return { direccion, llaveCustodiaRef, saldo };
    } catch (error) {
      throw this.fallaDeCadena(error);
    }
  }

  private async aDto(fila: FilaPublica): Promise<BilleteraDto> {
    try {
      const saldo = await this.blockchain.cadena.leerSaldo(fila.direccion);
      return this.dto(fila, saldo);
    } catch (error) {
      throw this.fallaDeCadena(error);
    }
  }

  private dto(fila: FilaPublica, saldo: bigint): BilleteraDto {
    return {
      id: fila.id,
      direccion: fila.direccion,
      saldoUrc: formatearUrc(saldo),
      exploradorUrl: this.blockchain.cadena.exploradorUrl(fila.direccion),
    };
  }

  private fallaDeCadena(error: unknown): ErrorNegocio {
    this.registro.error(`Falla de la cadena (${tipoDeError(error)})`);
    return noDisponible();
  }
}
