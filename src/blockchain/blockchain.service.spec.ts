import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AbiCoder, id, Wallet, zeroPadValue } from 'ethers';
import {
  BlockchainService,
  CadenaReal,
  CadenaSimulada,
  crearCadena,
  ErrorBloqueoPermanente,
  formatearUrc,
  nombreDeReversion,
  unidadesAUrc,
  urcAUnidades,
} from './blockchain.service.js';

const TOKEN = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const DIRECCION = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const URC = 10n ** 18n;
/** Primera cuenta de Hardhat: pública y sin valor. */
const LLAVE =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ID_ORDEN = `0x${'11'.repeat(32)}`;
const HASH = `0x${'ab'.repeat(32)}`;
const ESCROW = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const ID_RESERVA = `0x${'33'.repeat(32)}`;

describe('formatearUrc', () => {
  it.each([
    [0n, '0.00'],
    [URC, '1.00'],
    [(URC * 5n) / 2n, '2.50'],
    [(URC * 123n) / 100n, '1.23'],
    [URC / 100n, '0.01'],
    [1n, '0.00'], // nunca redondea hacia arriba
    [(URC * 1999n) / 1000n, '1.99'],
    [URC * 1000000n, '1000000.00'],
  ])('%s unidades → %s', (unidades, esperado) => {
    expect(formatearUrc(unidades)).toBe(esperado);
  });
});

describe('crearCadena', () => {
  const valido = {
    CADENA_ID: '31337',
    CADENA_RPC_URL: 'http://localhost:8545',
    DIRECCION_TOKEN_URC: TOKEN,
  };

  it('BLOCKCHAIN_SIMULADA=true en producción detiene el arranque', () => {
    expect(() =>
      crearCadena({
        ...valido,
        NODE_ENV: 'production',
        BLOCKCHAIN_SIMULADA: 'true',
      }),
    ).toThrow('BLOCKCHAIN_SIMULADA');
  });

  it('fuera de producción BLOCKCHAIN_SIMULADA=true usa la simulada: saldo 0 y sin explorador', async () => {
    const cadena = crearCadena({
      CADENA_ID: '31337',
      BLOCKCHAIN_SIMULADA: 'true',
    });
    expect(cadena).toBeInstanceOf(CadenaSimulada);
    expect(await cadena.leerSaldo(DIRECCION)).toBe(0n);
    expect(cadena.exploradorUrl(DIRECCION)).toBeNull();
  });

  it.each([
    ['mainnet de Ethereum', '1'],
    ['mainnet de Polygon', '137'],
    ['otra red de prueba', '11155111'],
    ['sin valor', undefined],
    ['vacío', ''],
    ['no numérico', 'amoy'],
  ])('rechaza CADENA_ID: %s', (_, CADENA_ID) => {
    expect(() => crearCadena({ ...valido, CADENA_ID })).toThrow('CADENA_ID');
    expect(() =>
      crearCadena({ ...valido, CADENA_ID, BLOCKCHAIN_SIMULADA: 'true' }),
    ).toThrow('CADENA_ID');
  });

  it.each(['31337', '80002'])('acepta CADENA_ID %s', (CADENA_ID) => {
    expect(crearCadena({ ...valido, CADENA_ID })).toBeInstanceOf(CadenaReal);
  });

  it('rechaza una DIRECCION_ESCROW inválida; vacía se acepta fuera de producción (contrato sin desplegar)', () => {
    expect(() => crearCadena({ ...valido, DIRECCION_ESCROW: '0x123' })).toThrow(
      'DIRECCION_ESCROW',
    );
    expect(crearCadena({ ...valido, DIRECCION_ESCROW: ESCROW })).toBeInstanceOf(
      CadenaReal,
    );
    expect(crearCadena({ ...valido, DIRECCION_ESCROW: '' })).toBeInstanceOf(
      CadenaReal,
    );
  });

  it('exige CADENA_RPC_URL', () => {
    expect(() => crearCadena({ ...valido, CADENA_RPC_URL: '' })).toThrow(
      'CADENA_RPC_URL',
    );
  });

  it.each([
    ['sin llave', {}],
    ['con RELAYER_LLAVE_PRIVADA', { RELAYER_LLAVE_PRIVADA: LLAVE }],
    ['con KMS_LLAVE_RELAYER_ID', { KMS_LLAVE_RELAYER_ID: 'alias/relayer' }],
  ])('en producción no arranca sin el firmante KMS: %s', (_, extra) => {
    expect(() =>
      crearCadena({ ...valido, ...extra, NODE_ENV: 'production' }),
    ).toThrow('firmante KMS');
  });

  it('rechaza una DIRECCION_TOKEN_URC inválida en cualquier entorno', () => {
    expect(() =>
      crearCadena({ ...valido, DIRECCION_TOKEN_URC: '0x123' }),
    ).toThrow('DIRECCION_TOKEN_URC');
  });

  it('sin DIRECCION_TOKEN_URC se comporta igual que vacía', () => {
    const { DIRECCION_TOKEN_URC: _, ...sinToken } = valido;
    expect(crearCadena(sinToken)).toBeInstanceOf(CadenaReal);
  });

  it('DIRECCION_TOKEN_URC vacía: en producción no arranca; en desarrollo arranca y cada lectura falla', async () => {
    const vacia = { ...valido, DIRECCION_TOKEN_URC: '' };
    expect(() => crearCadena({ ...vacia, NODE_ENV: 'production' })).toThrow(
      'DIRECCION_TOKEN_URC',
    );
    await expect(crearCadena(vacia).leerSaldo(DIRECCION)).rejects.toThrow(
      'DIRECCION_TOKEN_URC',
    );
  });
});

describe('CadenaSimulada', () => {
  it('acuña una vez por orden: repetirla devuelve el mismo hash sin sumar', async () => {
    const cadena = new CadenaSimulada();
    const hash = await cadena.acunarRecarga(DIRECCION, URC, ID_ORDEN);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await cadena.acunarRecarga(DIRECCION, URC, ID_ORDEN)).toBe(hash);
    expect(await cadena.leerSaldo(DIRECCION)).toBe(URC);
    await cadena.acunarRecarga(DIRECCION, URC, `0x${'22'.repeat(32)}`);
    expect(await cadena.leerSaldo(DIRECCION)).toBe(URC * 2n);
    expect(await cadena.leerSaldo(TOKEN)).toBe(0n);
  });
});

describe('CadenaSimulada · bloquear reserva', () => {
  const pasajero = new Wallet(LLAVE);
  const conductor = DIRECCION;
  const datos = (monto = 10n * URC, idReserva = ID_RESERVA) => ({
    idReserva,
    llavePagador: LLAVE,
    conductor,
    monto,
  });
  const fondeada = async (monto: bigint) => {
    const cadena = new CadenaSimulada();
    await cadena.acunarRecarga(pasajero.address, monto, ID_ORDEN);
    return cadena;
  };

  it('mueve el monto del pasajero al escrow y registra la reserva; no crea saldo', async () => {
    const cadena = await fondeada(50n * URC);
    const hash = await cadena.bloquearReserva(datos());
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await cadena.leerSaldo(pasajero.address)).toBe(40n * URC);
    expect(await cadena.leerSaldo(conductor)).toBe(0n);
    expect(await cadena.estadoReservaEscrow(ID_RESERVA)).toEqual({
      estado: 'bloqueada',
      pagador: pasajero.address,
      conductor,
      monto: 10n * URC,
    });
    expect(await cadena.hashDeBloqueo(ID_RESERVA)).toBe(hash);
  });

  it('repetir la misma reserva devuelve el mismo hash sin bloquear de nuevo', async () => {
    const cadena = await fondeada(50n * URC);
    const hash = await cadena.bloquearReserva(datos());
    expect(await cadena.bloquearReserva(datos())).toBe(hash);
    expect(await cadena.leerSaldo(pasajero.address)).toBe(40n * URC);
  });

  it('la misma reserva con otro monto es ReservaExistente: permanente', async () => {
    const cadena = await fondeada(50n * URC);
    await cadena.bloquearReserva(datos());
    await expect(cadena.bloquearReserva(datos(5n * URC))).rejects.toMatchObject(
      {
        motivo: 'ReservaExistente',
      },
    );
  });

  it('sin saldo rechaza como el contrato, con una falla permanente y sin tocar nada', async () => {
    const cadena = await fondeada(5n * URC);
    const falla = cadena.bloquearReserva(datos());
    await expect(falla).rejects.toBeInstanceOf(ErrorBloqueoPermanente);
    await expect(falla).rejects.toMatchObject({
      motivo: 'ERC20InsufficientBalance',
    });
    expect(await cadena.leerSaldo(pasajero.address)).toBe(5n * URC);
    expect((await cadena.estadoReservaEscrow(ID_RESERVA)).estado).toBe(
      'ninguno',
    );
  });

  it('pagador igual al conductor o monto cero: DatosInvalidos', async () => {
    const cadena = await fondeada(50n * URC);
    await expect(
      cadena.bloquearReserva({ ...datos(), conductor: pasajero.address }),
    ).rejects.toMatchObject({ motivo: 'DatosInvalidos' });
    await expect(cadena.bloquearReserva(datos(0n))).rejects.toMatchObject({
      motivo: 'DatosInvalidos',
    });
  });

  it('el hash de una reserva que nunca se bloqueó no existe', async () => {
    await expect(
      new CadenaSimulada().hashDeBloqueo(ID_RESERVA),
    ).rejects.toThrow();
  });
});

describe('nombreDeReversion', () => {
  const reversion = (extra: object) =>
    Object.assign(new Error('revert'), { code: 'CALL_EXCEPTION', ...extra });

  it('lee el error personalizado de los datos, que ethers no decodifica al estimar el gas', () => {
    expect(nombreDeReversion(reversion({ data: '0x91bdcb8d' }))).toBe(
      'DatosInvalidos',
    );
    expect(
      nombreDeReversion(reversion({ info: { error: { data: '0x91bdcb8d' } } })),
    ).toBe('DatosInvalidos');
  });

  it('usa el nombre que ethers ya decodificó', () => {
    expect(
      nombreDeReversion(reversion({ revert: { name: 'ReservaExistente' } })),
    ).toBe('ReservaExistente');
  });

  it.each([
    ['un nodo caído', { code: 'SERVER_ERROR', data: '0x91bdcb8d' }],
    ['un tiempo agotado', { code: 'TIMEOUT' }],
    ['datos de otro contrato', { code: 'CALL_EXCEPTION', data: '0xdeadbeef' }],
    ['sin datos', { code: 'CALL_EXCEPTION', data: '0x' }],
  ])('%s no es una reversión conocida', (_, error) => {
    expect(nombreDeReversion(Object.assign(new Error('x'), error))).toBe(
      undefined,
    );
  });

  it('un valor que no es un error tampoco', () => {
    expect(nombreDeReversion(undefined)).toBeUndefined();
    expect(nombreDeReversion('texto')).toBeUndefined();
  });
});

describe('BlockchainService', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('fuera de pruebas una mala configuración detiene el arranque', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('BLOCKCHAIN_SIMULADA', 'false');
    vi.stubEnv('CADENA_ID', '137');
    expect(() => new BlockchainService().onModuleInit()).toThrow('CADENA_ID');
  });

  it('en pruebas se elige al primer uso y se puede reemplazar', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('BLOCKCHAIN_SIMULADA', 'true');
    vi.stubEnv('CADENA_ID', '31337');
    const servicio = new BlockchainService();
    servicio.onModuleInit();
    const primera = servicio.cadena;
    expect(primera).toBeInstanceOf(CadenaSimulada);
    expect(servicio.cadena).toBe(primera);
    const otra = new CadenaSimulada();
    servicio.cadena = otra;
    expect(servicio.cadena).toBe(otra);
  });
});

describe('CadenaReal contra un nodo JSON-RPC', () => {
  let servidor: Server;
  let url: string;
  let nodo: {
    cadena: string;
    llamada: string;
    estado: number;
    colgado: boolean;
    llamadas: { metodo: string; a?: string; datos?: string }[];
    resultados: Record<string, unknown>;
  };

  beforeAll(async () => {
    servidor = createServer((peticion, respuesta) => {
      let cuerpo = '';
      peticion.on('data', (parte) => (cuerpo += parte));
      peticion.on('end', () => {
        if (nodo.colgado) return;
        const entrada = JSON.parse(cuerpo);
        const responder = (p: {
          id: number;
          method: string;
          params: {
            to?: string;
            data?: string;
            fromBlock?: string;
            toBlock?: string;
          }[];
        }) => {
          nodo.llamadas.push({
            metodo: p.method,
            a: p.params[0]?.to,
            datos: p.params[0]?.data,
          });
          const resultado = nodo.resultados[p.method];
          return {
            jsonrpc: '2.0',
            id: p.id,
            result:
              typeof resultado === 'function'
                ? resultado(p.params[0])
                : p.method in nodo.resultados
                  ? resultado
                  : p.method === 'eth_chainId'
                    ? nodo.cadena
                    : nodo.llamada,
          };
        };
        respuesta.statusCode = nodo.estado;
        respuesta.setHeader('content-type', 'application/json');
        respuesta.end(
          JSON.stringify(
            Array.isArray(entrada)
              ? entrada.map(responder)
              : responder(entrada),
          ),
        );
      });
    });
    await new Promise<void>((listo) => servidor.listen(0, listo));
    url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    servidor.closeAllConnections();
    servidor.close();
  });
  beforeEach(() => {
    nodo = {
      cadena: '0x7a69', // 31337
      llamada: `0x${(URC * 2n).toString(16).padStart(64, '0')}`,
      estado: 200,
      colgado: false,
      llamadas: [],
      resultados: {},
    };
  });

  describe('acunarRecarga', () => {
    const SI = `0x${'1'.padStart(64, '0')}`;
    const relayer = () => new CadenaReal(url, TOKEN, 31337, undefined, LLAVE);
    const EVENTO = {
      address: TOKEN,
      topics: [
        id('RecargaAcunada(bytes32,address,uint256)'),
        ID_ORDEN,
        zeroPadValue(DIRECCION, 32),
      ],
      data: `0x${URC.toString(16).padStart(64, '0')}`,
      blockNumber: '0x1',
      blockHash: `0x${'cd'.repeat(32)}`,
      transactionHash: HASH,
      transactionIndex: '0x0',
      logIndex: '0x0',
      removed: false,
    };

    it('orden acuñada hace muchos bloques: la busca por ventanas, como exige un RPC público', async () => {
      nodo.llamada = SI;
      nodo.resultados.eth_blockNumber = '0x9c4'; // 2500
      const rangos: number[][] = [];
      nodo.resultados.eth_getLogs = ({
        fromBlock,
        toBlock,
      }: {
        fromBlock: string;
        toBlock: string;
      }) => {
        const rango = [Number(fromBlock), Number(toBlock)];
        rangos.push(rango);
        return rango[1] - rango[0] < 1_000 && rango[0] <= 100 ? [EVENTO] : [];
      };
      await expect(
        relayer().acunarRecarga(DIRECCION, URC, ID_ORDEN),
      ).resolves.toBe(HASH);
      expect(rangos).toEqual([
        [1501, 2500],
        [501, 1500],
        [0, 500],
      ]);
    });

    it('orden ya acuñada: recupera el hash del evento y no envía otra transacción', async () => {
      nodo.llamada = SI;
      nodo.resultados.eth_getLogs = [EVENTO];
      await expect(
        relayer().acunarRecarga(DIRECCION, URC, ID_ORDEN),
      ).resolves.toBe(HASH);
      const metodos = nodo.llamadas.map((l) => l.metodo);
      expect(metodos).not.toContain('eth_sendRawTransaction');
      expect(metodos).not.toContain('eth_estimateGas');
    });

    it('dos acuñaciones seguidas leen el nonce cada una: la caché de ethers lo repetiría', async () => {
      nodo.llamada = `0x${'0'.repeat(64)}`;
      // Sin bloque, ethers rechaza al armar la transacción, ya con el nonce leído: lo único que mira esta prueba.
      nodo.resultados.eth_getBlockByNumber = null;
      const cadena = relayer();
      await expect(
        cadena.acunarRecarga(DIRECCION, URC, ID_ORDEN),
      ).rejects.toBeDefined();
      await expect(
        cadena.acunarRecarga(DIRECCION, URC, ID_ORDEN),
      ).rejects.toBeDefined();
      expect(
        nodo.llamadas.filter((l) => l.metodo === 'eth_getTransactionCount'),
      ).toHaveLength(2);
    });

    it('orden acuñada sin su evento en el nodo: rechaza, para reintentar', async () => {
      nodo.llamada = SI;
      nodo.resultados.eth_getLogs = [];
      await expect(
        relayer().acunarRecarga(DIRECCION, URC, ID_ORDEN),
      ).rejects.toThrow('sin su evento');
    });

    it('sin llave del relayer o sin token rechaza sin llamar al nodo', async () => {
      await expect(
        new CadenaReal(url, TOKEN, 31337).acunarRecarga(
          DIRECCION,
          URC,
          ID_ORDEN,
        ),
      ).rejects.toThrow('RELAYER_LLAVE_PRIVADA');
      await expect(
        new CadenaReal(url, '', 31337, undefined, LLAVE).acunarRecarga(
          DIRECCION,
          URC,
          ID_ORDEN,
        ),
      ).rejects.toThrow('DIRECCION_TOKEN_URC');
      expect(nodo.llamadas).toEqual([]);
    });
  });

  describe('escrow', () => {
    const datos = {
      idReserva: ID_RESERVA,
      llavePagador: LLAVE,
      conductor: DIRECCION,
      monto: 10n * URC,
    };

    it('sin escrow, token o llave del relayer rechaza sin llamar al nodo', async () => {
      await expect(
        new CadenaReal(url, TOKEN, 31337, undefined, LLAVE).bloquearReserva(
          datos,
        ),
      ).rejects.toThrow('DIRECCION_ESCROW');
      await expect(
        new CadenaReal(
          url,
          TOKEN,
          31337,
          undefined,
          undefined,
          ESCROW,
        ).bloquearReserva(datos),
      ).rejects.toThrow('RELAYER_LLAVE_PRIVADA');
      await expect(
        new CadenaReal(
          url,
          '',
          31337,
          undefined,
          LLAVE,
          ESCROW,
        ).bloquearReserva(datos),
      ).rejects.toThrow('DIRECCION_TOKEN_URC');
      await expect(
        new CadenaReal(url, TOKEN, 31337).estadoReservaEscrow(ID_RESERVA),
      ).rejects.toThrow('DIRECCION_ESCROW');
      expect(nodo.llamadas).toEqual([]);
    });

    it('estadoReservaEscrow lee la reserva del contrato y traduce su estado', async () => {
      nodo.llamada = AbiCoder.defaultAbiCoder().encode(
        ['address', 'address', 'uint256', 'uint8', 'bytes32'],
        [DIRECCION, TOKEN, 10n * URC, 1, `0x${'00'.repeat(32)}`],
      );
      const cadena = new CadenaReal(
        url,
        TOKEN,
        31337,
        undefined,
        LLAVE,
        ESCROW,
      );
      expect(await cadena.estadoReservaEscrow(ID_RESERVA)).toEqual({
        estado: 'bloqueada',
        pagador: DIRECCION,
        conductor: TOKEN,
        monto: 10n * URC,
      });
      expect(nodo.llamadas[0].a?.toLowerCase()).toBe(ESCROW.toLowerCase());
    });
  });

  it('lee balanceOf del contrato configurado', async () => {
    const saldo = await new CadenaReal(url, TOKEN, 31337).leerSaldo(DIRECCION);
    expect(saldo).toBe(URC * 2n);
    const llamada = nodo.llamadas.find((l) => l.metodo === 'eth_call');
    expect(llamada?.a?.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(llamada?.datos?.startsWith('0x70a08231')).toBe(true); // selector de balanceOf
  });

  it('rechaza un nodo de otra red, aunque CADENA_ID sea válido', async () => {
    nodo.cadena = '0x89'; // mainnet de Polygon
    await expect(
      new CadenaReal(url, TOKEN, 80002).leerSaldo(DIRECCION),
    ).rejects.toThrow('CADENA_ID');
  });

  it('rechaza si el contrato no está desplegado en esa dirección', async () => {
    nodo.llamada = '0x';
    await expect(
      new CadenaReal(url, TOKEN, 31337).leerSaldo(DIRECCION),
    ).rejects.toBeDefined();
  });

  it('rechaza si el nodo responde con error', async () => {
    nodo.estado = 500;
    await expect(
      new CadenaReal(url, TOKEN, 31337).leerSaldo(DIRECCION),
    ).rejects.toBeDefined();
  });

  it('un nodo que no responde corta por tiempo, sin quedarse colgado', async () => {
    nodo.colgado = true;
    await expect(
      new CadenaReal(url, TOKEN, 31337, 50).leerSaldo(DIRECCION),
    ).rejects.toBeDefined();
  });

  it('un nodo apagado rechaza sin reintentar sin fin', async () => {
    await expect(
      new CadenaReal('http://127.0.0.1:9', TOKEN, 31337, 500).leerSaldo(
        DIRECCION,
      ),
    ).rejects.toBeDefined();
  });

  it('el explorador es Polygonscan solo en Amoy', () => {
    expect(new CadenaReal(url, TOKEN, 80002).exploradorUrl(DIRECCION)).toBe(
      `https://amoy.polygonscan.com/address/${DIRECCION}`,
    );
    expect(
      new CadenaReal(url, TOKEN, 31337).exploradorUrl(DIRECCION),
    ).toBeNull();
  });

  it('el enlace a la transacción es Polygonscan solo en Amoy', () => {
    expect(new CadenaReal(url, TOKEN, 80002).exploradorTxUrl('0xabc')).toBe(
      'https://amoy.polygonscan.com/tx/0xabc',
    );
    expect(
      new CadenaReal(url, TOKEN, 31337).exploradorTxUrl('0xabc'),
    ).toBeNull();
  });
});

describe('BlockchainService.leerSaldoConCache', () => {
  const preparar = () => {
    const leerSaldo = vi.fn().mockResolvedValue(5n);
    const servicio = new BlockchainService();
    servicio.cadena = {
      leerSaldo,
      exploradorUrl: () => null,
      exploradorTxUrl: () => null,
    };
    return { servicio, leerSaldo };
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('dentro de 15 s no vuelve a la cadena e indica que no es lectura real', async () => {
    const { servicio, leerSaldo } = preparar();
    await expect(servicio.leerSaldoConCache(DIRECCION, 0)).resolves.toEqual({
      saldo: 5n,
      real: true,
    });
    vi.advanceTimersByTime(14_999);
    await expect(servicio.leerSaldoConCache(DIRECCION, 0)).resolves.toEqual({
      saldo: 5n,
      real: false,
    });
    expect(leerSaldo).toHaveBeenCalledOnce();
  });

  it('a los 15 s lee otra vez', async () => {
    const { servicio, leerSaldo } = preparar();
    await servicio.leerSaldoConCache(DIRECCION, 0);
    vi.advanceTimersByTime(15_000);
    const r = await servicio.leerSaldoConCache(DIRECCION, 0);
    expect(r.real).toBe(true);
    expect(leerSaldo).toHaveBeenCalledTimes(2);
  });

  it('otra versión del libro lee otra vez, aunque no hayan pasado 15 s', async () => {
    const { servicio, leerSaldo } = preparar();
    await servicio.leerSaldoConCache(DIRECCION, 0);
    const r = await servicio.leerSaldoConCache(DIRECCION, 1);
    expect(r.real).toBe(true);
    expect(leerSaldo).toHaveBeenCalledTimes(2);
  });

  it('cada dirección tiene su entrada', async () => {
    const { servicio, leerSaldo } = preparar();
    await servicio.leerSaldoConCache(DIRECCION, 0);
    const r = await servicio.leerSaldoConCache(TOKEN, 0);
    expect(r.real).toBe(true);
    expect(leerSaldo).toHaveBeenCalledTimes(2);
  });

  it('una falla no se guarda: la siguiente lectura vuelve a intentar', async () => {
    const { servicio, leerSaldo } = preparar();
    leerSaldo.mockRejectedValueOnce(new Error('caído'));
    await expect(servicio.leerSaldoConCache(DIRECCION, 0)).rejects.toThrow(
      'caído',
    );
    await expect(servicio.leerSaldoConCache(DIRECCION, 0)).resolves.toEqual({
      saldo: 5n,
      real: true,
    });
  });

  it('un nodo colgado se corta a los 5 s y no deja nada en caché', async () => {
    const { servicio, leerSaldo } = preparar();
    leerSaldo.mockReturnValueOnce(new Promise(() => {}));
    const lectura = servicio.leerSaldoConCache(DIRECCION, 0);
    const verificado = expect(lectura).rejects.toThrow('a tiempo');
    await vi.advanceTimersByTimeAsync(5_000);
    await verificado;
    const r = await servicio.leerSaldoConCache(DIRECCION, 0);
    expect(r.real).toBe(true);
  });

  it('cambiar de cadena vacía el caché', async () => {
    const { servicio, leerSaldo } = preparar();
    await servicio.leerSaldoConCache(DIRECCION, 0);
    servicio.cadena = {
      leerSaldo,
      exploradorUrl: () => null,
      exploradorTxUrl: () => null,
    };
    const r = await servicio.leerSaldoConCache(DIRECCION, 0);
    expect(r.real).toBe(true);
  });

  it('una cadena mal configurada rechaza, no lanza al llamar', async () => {
    vi.stubEnv('CADENA_ID', '1');
    const lectura = new BlockchainService().leerSaldoConCache(DIRECCION, 0);
    await expect(lectura).rejects.toThrow('CADENA_ID');
    vi.unstubAllEnvs();
  });
});

describe('urcAUnidades y unidadesAUrc', () => {
  it.each([
    ['15.00', 15n * URC],
    ['0', 0n],
    ['0.01', URC / 100n],
    ['-5.50', (-55n * URC) / 10n],
  ])('%s', (texto, unidades) => {
    expect(urcAUnidades(texto)).toBe(unidades);
  });

  it('unidadesAUrc no pierde precisión', () => {
    expect(unidadesAUrc(URC + 1n)).toBe('1.000000000000000001');
  });
});
