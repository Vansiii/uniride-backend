import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  Contract,
  FetchRequest,
  formatUnits,
  id,
  isAddress,
  JsonRpcProvider,
  Network,
  parseUnits,
  Wallet,
} from 'ethers';

/** Hardhat local y Polygon Amoy. Cualquier otra red, en especial una mainnet, no arranca (AGENTS.md §11). */
const CADENAS_PERMITIDAS = [31337, 80002];
const ID_AMOY = 80002;
const EXPLORADOR_AMOY = 'https://amoy.polygonscan.com/address/';
const EXPLORADOR_TX_AMOY = 'https://amoy.polygonscan.com/tx/';
const TIEMPO_MAXIMO_MS = 5_000;
const VIDA_CACHE_MS = 15_000;
/** Sin recibo a tiempo el worker reintenta: el contrato no acuña dos veces la misma orden. */
const TIEMPO_RECIBO_MS = 120_000;
const ABI_UNICOIN = [
  'function balanceOf(address) view returns (uint256)',
  'function ordenAcunada(bytes32) view returns (bool)',
  'function acunarRecarga(address destino, uint256 monto, bytes32 idOrden)',
  'event RecargaAcunada(bytes32 indexed idOrden, address indexed destino, uint256 monto)',
];
const DECIMALES_URC = 18;
const UNIDADES_POR_CENTAVO = 10n ** 16n;

export interface Cadena {
  /** Saldo en las unidades mínimas del token. Rechaza si el nodo falla o no es la red configurada. */
  leerSaldo(direccion: string): Promise<bigint>;
  /**
   * Acuña una recarga y devuelve el hash de su transacción. Repetir la misma orden no acuña de nuevo y devuelve
   * el hash original. Rechaza si el nodo falla: el worker reintenta.
   */
  acunarRecarga(
    destino: string,
    monto: bigint,
    idOrden: string,
  ): Promise<string>;
  exploradorUrl(direccion: string): string | null;
  exploradorTxUrl(hashTx: string): string | null;
}

/** Trunca a 2 decimales: nunca muestra más saldo del que hay. */
export function formatearUrc(unidades: bigint): string {
  const centavos = unidades / UNIDADES_POR_CENTAVO;
  return `${centavos / 100n}.${String(centavos % 100n).padStart(2, '0')}`;
}

/** Monto en URC ("15.00") a las unidades mínimas del token. */
export function urcAUnidades(monto: string): bigint {
  return parseUnits(monto, DECIMALES_URC);
}

export function unidadesAUrc(unidades: bigint): string {
  return formatUnits(unidades, DECIMALES_URC);
}

export class CadenaReal implements Cadena {
  private readonly proveedor: JsonRpcProvider;
  private readonly token: Contract | null;
  private readonly relayer: Wallet | null;

  constructor(
    url: string,
    direccionToken: string,
    private readonly cadenaId: number,
    tiempoMaximoMs = TIEMPO_MAXIMO_MS,
    llaveRelayer?: string,
  ) {
    const peticion = new FetchRequest(url);
    peticion.timeout = tiempoMaximoMs;
    // Con red fija ethers no reintenta detectarla sin fin cuando el nodo está caído.
    const red = Network.from(cadenaId);
    // Sin caché: con los 250 ms de ethers, dos acuñaciones seguidas leerían el mismo nonce.
    this.proveedor = new JsonRpcProvider(peticion, red, {
      staticNetwork: red,
      cacheTimeout: -1,
    });
    this.token = direccionToken
      ? new Contract(direccionToken, ABI_UNICOIN, this.proveedor)
      : null;
    this.relayer = llaveRelayer
      ? new Wallet(llaveRelayer, this.proveedor)
      : null;
  }

  async leerSaldo(direccion: string): Promise<bigint> {
    if (!this.token) throw new Error('DIRECCION_TOKEN_URC no está configurada');
    const [id, saldo] = await Promise.all([
      this.proveedor.send('eth_chainId', []) as Promise<string>,
      this.token.balanceOf(direccion) as Promise<bigint>,
    ]);
    // La URL puede apuntar a otra red aunque CADENA_ID sea válido: se comprueba con el propio nodo.
    if (BigInt(id) !== BigInt(this.cadenaId))
      throw new Error('El nodo no corresponde a CADENA_ID');
    return saldo;
  }

  async acunarRecarga(
    destino: string,
    monto: bigint,
    idOrden: string,
  ): Promise<string> {
    if (!this.token) throw new Error('DIRECCION_TOKEN_URC no está configurada');
    if (!this.relayer)
      throw new Error('RELAYER_LLAVE_PRIVADA no está configurada');
    // Ya acuñada: un intento anterior perdió la respuesta. Si dos intentos se cruzan, el contrato revierte
    // con `OrdenYaAcunada` y el siguiente reintento pasa por aquí.
    if (await this.token.ordenAcunada(idOrden)) {
      // ponytail: sin `fromBlock`; si un RPC limita el rango de bloques, esto falla y el worker sigue reintentando
      // con su alerta. Se acota guardando el bloque al enviar.
      const [evento] = await this.token.queryFilter(
        this.token.filters.RecargaAcunada(idOrden),
      );
      if (!evento) throw new Error('Orden acuñada sin su evento en el nodo');
      return evento.transactionHash;
    }
    const token = this.token.connect(this.relayer) as Contract;
    const tx = await token.acunarRecarga(destino, monto, idOrden);
    await tx.wait(1, TIEMPO_RECIBO_MS);
    return tx.hash as string;
  }

  exploradorUrl(direccion: string): string | null {
    return this.cadenaId === ID_AMOY ? `${EXPLORADOR_AMOY}${direccion}` : null;
  }

  exploradorTxUrl(hashTx: string): string | null {
    return this.cadenaId === ID_AMOY ? `${EXPLORADOR_TX_AMOY}${hashTx}` : null;
  }
}

/** Solo pruebas y desarrollo: sin nodo, con los saldos en memoria; cada dirección empieza en 0 y un reinicio los borra. */
export class CadenaSimulada implements Cadena {
  protected saldos = new Map<string, bigint>();
  private readonly acunadas = new Map<string, string>();

  constructor() {
    new Logger(CadenaSimulada.name).warn(
      'BLOCKCHAIN_SIMULADA activo: la cadena es SIMULADA. Nunca en producción.',
    );
  }

  async leerSaldo(direccion = ''): Promise<bigint> {
    return this.saldos.get(direccion) ?? 0n;
  }

  async acunarRecarga(
    destino: string,
    monto: bigint,
    idOrden: string,
  ): Promise<string> {
    const previa = this.acunadas.get(idOrden);
    if (previa) return previa;
    const hash = id(`recarga-simulada:${idOrden}`);
    this.acunadas.set(idOrden, hash);
    this.saldos.set(destino, (this.saldos.get(destino) ?? 0n) + monto);
    return hash;
  }

  exploradorUrl(): string | null {
    return null;
  }

  exploradorTxUrl(): string | null {
    return null;
  }
}

/**
 * Elige la cadena al arrancar. `BLOCKCHAIN_SIMULADA=true` en producción detiene el arranque (AGENTS.md §6).
 * Fuera de producción `DIRECCION_TOKEN_URC` puede estar vacía (contrato sin desplegar): cada lectura falla y responde 503.
 */
export function crearCadena(env: NodeJS.ProcessEnv = process.env): Cadena {
  const produccion = env.NODE_ENV === 'production';
  if (env.BLOCKCHAIN_SIMULADA === 'true' && produccion)
    throw new Error('BLOCKCHAIN_SIMULADA=true está prohibido en producción');
  const cadenaId = Number(env.CADENA_ID);
  if (!CADENAS_PERMITIDAS.includes(cadenaId))
    throw new Error(
      'CADENA_ID debe ser 31337 (Hardhat) u 80002 (Polygon Amoy)',
    );
  if (env.BLOCKCHAIN_SIMULADA === 'true') return new CadenaSimulada();

  if (!env.CADENA_RPC_URL)
    throw new Error('CADENA_RPC_URL no está configurada');
  const token = env.DIRECCION_TOKEN_URC ?? '';
  if (token ? !isAddress(token) : produccion)
    throw new Error('DIRECCION_TOKEN_URC no es una dirección válida');
  // A-12: en producción la llave del relayer solo vive en KMS. Sin ese firmante (SP129) no se arranca.
  if (produccion)
    throw new Error(
      'Producción exige el firmante KMS del relayer (SP129); RELAYER_LLAVE_PRIVADA no se acepta',
    );
  return new CadenaReal(
    env.CADENA_RPC_URL,
    token,
    cadenaId,
    undefined,
    env.RELAYER_LLAVE_PRIVADA,
  );
}

function conTiempoMaximo<T>(promesa: Promise<T>): Promise<T> {
  let reloj: NodeJS.Timeout;
  const vencida = new Promise<never>((_, rechazar) => {
    reloj = setTimeout(
      () => rechazar(new Error('El nodo no respondió a tiempo')),
      TIEMPO_MAXIMO_MS,
    );
  });
  return Promise.race([promesa, vencida]).finally(() => clearTimeout(reloj));
}

@Injectable()
export class BlockchainService implements OnModuleInit {
  private actual?: Cadena;
  // ponytail: por proceso y una entrada por billetera consultada; con varias instancias cada una lee por su cuenta.
  private readonly cache = new Map<
    string,
    { saldo: bigint; venceEn: number; version: number }
  >();

  /** Una mala configuración detiene el arranque; en pruebas se elige al primer uso. */
  onModuleInit(): void {
    if (process.env.NODE_ENV !== 'test') this.actual ??= crearCadena();
  }

  get cadena(): Cadena {
    return (this.actual ??= crearCadena());
  }

  /** Reemplazable en pruebas. */
  set cadena(cadena: Cadena) {
    this.actual = cadena;
    this.cache.clear();
  }

  /**
   * Para `/saldo` (HU-14): no satura el RPC y nunca espera más que el tiempo máximo, aunque el nodo se cuelgue.
   * `real` indica si este saldo acaba de salir de la cadena. Rechaza si el nodo falla o no responde a tiempo.
   * `version` cambia cuando el libro confirma un movimiento: el saldo guardado ya no sirve, aunque no haya vencido.
   */
  async leerSaldoConCache(
    direccion: string,
    version: number,
  ): Promise<{ saldo: bigint; real: boolean }> {
    const guardado = this.cache.get(direccion);
    if (
      guardado &&
      guardado.version === version &&
      Date.now() < guardado.venceEn
    )
      return { saldo: guardado.saldo, real: false };
    const saldo = await conTiempoMaximo(this.cadena.leerSaldo(direccion));
    this.cache.set(direccion, {
      saldo,
      version,
      venceEn: Date.now() + VIDA_CACHE_MS,
    });
    return { saldo, real: true };
  }
}
