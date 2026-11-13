import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  Contract,
  FetchRequest,
  formatUnits,
  id,
  Interface,
  isAddress,
  JsonRpcProvider,
  Network,
  parseUnits,
  Signature,
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
const BLOQUES_POR_VENTANA = 1_000;
const MAX_VENTANAS_LOGS = 500;
const ABI_UNICOIN = [
  'function balanceOf(address) view returns (uint256)',
  'function nonces(address) view returns (uint256)',
  'function ordenAcunada(bytes32) view returns (bool)',
  'function acunarRecarga(address destino, uint256 monto, bytes32 idOrden)',
  'event RecargaAcunada(bytes32 indexed idOrden, address indexed destino, uint256 monto)',
];
/** Los errores van en el ABI para que ethers los decodifique y el worker distinga una falla permanente. */
const ABI_ESCROW = [
  'function bloquear(bytes32 idReserva, address pagador, address conductor, uint256 monto, uint256 plazo, uint8 v, bytes32 r, bytes32 s)',
  'function reservas(bytes32) view returns (address pagador, address conductor, uint256 monto, uint8 estado, bytes32 hashPrueba)',
  'event ReservaBloqueada(bytes32 indexed idReserva, address indexed pagador, address indexed conductor, uint256 monto)',
  'error ReservaExistente(bytes32 idReserva)',
  'error DatosInvalidos()',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
];
const INTERFAZ_ESCROW = new Interface(ABI_ESCROW);
/** Revertidas por el contrato que ningún reintento arregla: la reserva no se completa (HU-19 CA-12). */
const REVERSIONES_PERMANENTES = [
  'ERC20InsufficientBalance',
  'DatosInvalidos',
  'ReservaExistente',
];
/** Vida del permit: el worker lo firma al enviar, así que una hora sobra incluso con reintentos (plan HU-19). */
const VIDA_PERMIT_S = 3_600;
const ESTADOS_ESCROW = [
  'ninguno',
  'bloqueada',
  'liberada',
  'reembolsada',
] as const;
const DECIMALES_URC = 18;
const UNIDADES_POR_CENTAVO = 10n ** 16n;

export type EstadoEscrow = (typeof ESTADOS_ESCROW)[number];

export interface ReservaEscrow {
  estado: EstadoEscrow;
  pagador: string;
  conductor: string;
  monto: bigint;
}

export interface DatosBloqueo {
  /** `keccak256(reservaId)`. */
  idReserva: string;
  /** Llave de la billetera del pasajero, descifrada solo para firmar el permit. Nunca se guarda ni se registra. */
  llavePagador: string;
  conductor: string;
  monto: bigint;
}

/** El contrato (o la cadena simulada) rechazó el bloqueo y repetirlo daría lo mismo: saldo insuficiente o datos inválidos. */
export class ErrorBloqueoPermanente extends Error {
  constructor(readonly motivo: string) {
    super(motivo);
  }
}

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
  /**
   * Bloquea el pasaje en el escrow con el permit del pasajero y devuelve el hash de la transacción. Rechaza con
   * `ErrorBloqueoPermanente` si no hay saldo o los datos no valen; con cualquier otro error el worker reintenta.
   */
  bloquearReserva(datos: DatosBloqueo): Promise<string>;
  /** Lo que el escrow guarda de la reserva; `ninguno` si nunca se bloqueó. */
  estadoReservaEscrow(idReserva: string): Promise<ReservaEscrow>;
  /** Hash de la transacción que bloqueó la reserva, para cuando la respuesta se perdió. */
  hashDeBloqueo(idReserva: string): Promise<string>;
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
  private readonly escrow: Contract | null;

  constructor(
    url: string,
    private readonly direccionToken: string,
    private readonly cadenaId: number,
    tiempoMaximoMs = TIEMPO_MAXIMO_MS,
    llaveRelayer?: string,
    private readonly direccionEscrow = '',
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
    this.escrow = direccionEscrow
      ? new Contract(direccionEscrow, ABI_ESCROW, this.proveedor)
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
    if (await this.token.ordenAcunada(idOrden))
      return this.hashDeEvento(
        this.token,
        this.token.filters.RecargaAcunada(idOrden),
        'Orden acuñada sin su evento en el nodo',
      );
    const token = this.token.connect(this.relayer) as Contract;
    // ponytail: una confirmación y sin reemplazar una transacción atascada; sirve con el relayer de desarrollo. SP129 agrega
    // N confirmaciones y reemplazo con más gas antes de usar el firmante real.
    const tx = await token.acunarRecarga(destino, monto, idOrden);
    await tx.wait(1, TIEMPO_RECIBO_MS);
    return tx.hash as string;
  }

  async bloquearReserva(datos: DatosBloqueo): Promise<string> {
    if (!this.token) throw new Error('DIRECCION_TOKEN_URC no está configurada');
    if (!this.escrow) throw new Error('DIRECCION_ESCROW no está configurada');
    if (!this.relayer)
      throw new Error('RELAYER_LLAVE_PRIVADA no está configurada');
    const pagador = new Wallet(datos.llavePagador);
    const plazo = BigInt(Math.floor(Date.now() / 1000) + VIDA_PERMIT_S);
    const nonce = (await this.token.nonces(pagador.address)) as bigint;
    // EIP-2612: el pasajero autoriza al escrow solo por este monto y el relayer paga el gas.
    const firma = Signature.from(
      await pagador.signTypedData(
        {
          name: 'UniCoin',
          version: '1',
          chainId: this.cadenaId,
          verifyingContract: this.direccionToken,
        },
        {
          Permit: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        {
          owner: pagador.address,
          spender: this.direccionEscrow,
          value: datos.monto,
          nonce,
          deadline: plazo,
        },
      ),
    );
    const escrow = this.escrow.connect(this.relayer) as Contract;
    try {
      // ponytail: una confirmación y sin reemplazar una transacción atascada, igual que la recarga (SP129).
      const tx = await escrow.bloquear(
        datos.idReserva,
        pagador.address,
        datos.conductor,
        datos.monto,
        plazo,
        firma.v,
        firma.r,
        firma.s,
      );
      await tx.wait(1, TIEMPO_RECIBO_MS);
      return tx.hash as string;
    } catch (error) {
      const reversion = nombreDeReversion(error);
      if (reversion && REVERSIONES_PERMANENTES.includes(reversion))
        throw new ErrorBloqueoPermanente(reversion);
      throw error;
    }
  }

  async estadoReservaEscrow(idReserva: string): Promise<ReservaEscrow> {
    if (!this.escrow) throw new Error('DIRECCION_ESCROW no está configurada');
    const [pagador, conductor, monto, estado] = (await this.escrow.reservas(
      idReserva,
    )) as [string, string, bigint, bigint];
    return {
      estado: ESTADOS_ESCROW[Number(estado)],
      pagador,
      conductor,
      monto,
    };
  }

  hashDeBloqueo(idReserva: string): Promise<string> {
    if (!this.escrow) throw new Error('DIRECCION_ESCROW no está configurada');
    return this.hashDeEvento(
      this.escrow,
      this.escrow.filters.ReservaBloqueada(idReserva),
      'Reserva bloqueada sin su evento en el nodo',
    );
  }

  /**
   * Busca el evento de atrás hacia adelante por ventanas: los RPC públicos rechazan un rango grande de bloques.
   * ponytail: tras `MAX_VENTANAS_LOGS` (unos 11 días en Amoy) rechaza y el worker sigue con su alerta; si una operación
   * llega a tardar más, guardar el bloque al enviar.
   */
  private async hashDeEvento(
    contrato: Contract,
    filtro: Parameters<Contract['queryFilter']>[0],
    sinEvento: string,
  ): Promise<string> {
    let hasta = await this.proveedor.getBlockNumber();
    for (let i = 0; i < MAX_VENTANAS_LOGS && hasta >= 0; i++) {
      const desde = Math.max(0, hasta - BLOQUES_POR_VENTANA + 1);
      const [evento] = await contrato.queryFilter(filtro, desde, hasta);
      if (evento) return evento.transactionHash;
      hasta = desde - 1;
    }
    throw new Error(sinEvento);
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
  private readonly bloqueos = new Map<
    string,
    { pagador: string; conductor: string; monto: bigint; hash: string }
  >();

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

  /** Mueve el monto del pasajero al escrow simulado; sin saldo rechaza como el contrato (`ERC20InsufficientBalance`). */
  async bloquearReserva(datos: DatosBloqueo): Promise<string> {
    const pagador = new Wallet(datos.llavePagador).address;
    const previo = this.bloqueos.get(datos.idReserva);
    if (previo) {
      if (previo.pagador !== pagador || previo.monto !== datos.monto)
        throw new ErrorBloqueoPermanente('ReservaExistente');
      return previo.hash;
    }
    if (pagador === datos.conductor || datos.monto === 0n)
      throw new ErrorBloqueoPermanente('DatosInvalidos');
    const saldo = this.saldos.get(pagador) ?? 0n;
    if (saldo < datos.monto)
      throw new ErrorBloqueoPermanente('ERC20InsufficientBalance');
    this.saldos.set(pagador, saldo - datos.monto);
    const hash = id(`bloqueo-simulado:${datos.idReserva}`);
    this.bloqueos.set(datos.idReserva, {
      pagador,
      conductor: datos.conductor,
      monto: datos.monto,
      hash,
    });
    return hash;
  }

  async estadoReservaEscrow(idReserva: string): Promise<ReservaEscrow> {
    const b = this.bloqueos.get(idReserva);
    return b
      ? {
          estado: 'bloqueada',
          pagador: b.pagador,
          conductor: b.conductor,
          monto: b.monto,
        }
      : { estado: 'ninguno', pagador: '', conductor: '', monto: 0n };
  }

  async hashDeBloqueo(idReserva: string): Promise<string> {
    const b = this.bloqueos.get(idReserva);
    if (!b) throw new Error('Reserva sin bloquear');
    return b.hash;
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
  const escrow = env.DIRECCION_ESCROW ?? '';
  // Vacía fuera de producción: contrato sin desplegar, cada bloqueo falla y se reintenta. Producción ya exige el KMS (SP129).
  if (escrow && !isAddress(escrow))
    throw new Error('DIRECCION_ESCROW no es una dirección válida');
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
    escrow,
  );
}

/**
 * Nombre del error personalizado con el que revirtió el contrato, o `undefined` si la falla no fue una reversión
 * (nodo caído, tiempo agotado). Al estimar el gas ethers no decodifica el error: se lee de los datos con el ABI.
 */
export function nombreDeReversion(error: unknown): string | undefined {
  const { code, revert, data, info } = (error ?? {}) as {
    code?: string;
    revert?: { name?: string } | null;
    data?: unknown;
    info?: { error?: { data?: unknown } };
  };
  if (code !== 'CALL_EXCEPTION') return undefined;
  if (revert?.name) return revert.name;
  for (const datos of [data, info?.error?.data])
    if (typeof datos === 'string' && datos.startsWith('0x'))
      try {
        const decodificado = INTERFAZ_ESCROW.parseError(datos);
        if (decodificado) return decodificado.name;
      } catch {
        // datos que no son de este contrato: no es una reversión conocida
      }
  return undefined;
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
