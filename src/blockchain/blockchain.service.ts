import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  Contract,
  FetchRequest,
  isAddress,
  JsonRpcProvider,
  Network,
} from 'ethers';

/** Hardhat local y Polygon Amoy. Cualquier otra red, en especial una mainnet, no arranca (AGENTS.md §11). */
const CADENAS_PERMITIDAS = [31337, 80002];
const ID_AMOY = 80002;
const EXPLORADOR_AMOY = 'https://amoy.polygonscan.com/address/';
const TIEMPO_MAXIMO_MS = 5_000;
const ABI_SALDO = ['function balanceOf(address) view returns (uint256)'];
const UNIDADES_POR_CENTAVO = 10n ** 16n; // URC tiene 18 decimales

export interface Cadena {
  /** Saldo en las unidades mínimas del token. Rechaza si el nodo falla o no es la red configurada. */
  leerSaldo(direccion: string): Promise<bigint>;
  exploradorUrl(direccion: string): string | null;
}

/** Trunca a 2 decimales: nunca muestra más saldo del que hay. */
export function formatearUrc(unidades: bigint): string {
  const centavos = unidades / UNIDADES_POR_CENTAVO;
  return `${centavos / 100n}.${String(centavos % 100n).padStart(2, '0')}`;
}

export class CadenaReal implements Cadena {
  private readonly proveedor: JsonRpcProvider;
  private readonly token: Contract | null;

  constructor(
    url: string,
    direccionToken: string,
    private readonly cadenaId: number,
    tiempoMaximoMs = TIEMPO_MAXIMO_MS,
  ) {
    const peticion = new FetchRequest(url);
    peticion.timeout = tiempoMaximoMs;
    // Con red fija ethers no reintenta detectarla sin fin cuando el nodo está caído.
    const red = Network.from(cadenaId);
    this.proveedor = new JsonRpcProvider(peticion, red, { staticNetwork: red });
    this.token = direccionToken
      ? new Contract(direccionToken, ABI_SALDO, this.proveedor)
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

  exploradorUrl(direccion: string): string | null {
    return this.cadenaId === ID_AMOY ? `${EXPLORADOR_AMOY}${direccion}` : null;
  }
}

/** Solo pruebas y desarrollo: toda dirección tiene saldo 0 y no hay nodo. */
export class CadenaSimulada implements Cadena {
  constructor() {
    new Logger(CadenaSimulada.name).warn(
      'BLOCKCHAIN_SIMULADA activo: la cadena es SIMULADA. Nunca en producción.',
    );
  }

  async leerSaldo(): Promise<bigint> {
    return 0n;
  }

  exploradorUrl(): string | null {
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
  return new CadenaReal(env.CADENA_RPC_URL, token, cadenaId);
}

@Injectable()
export class BlockchainService implements OnModuleInit {
  private actual?: Cadena;

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
  }
}
