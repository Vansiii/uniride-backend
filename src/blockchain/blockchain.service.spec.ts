import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  BlockchainService,
  CadenaReal,
  CadenaSimulada,
  crearCadena,
  formatearUrc,
} from './blockchain.service.js';

const TOKEN = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const DIRECCION = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const URC = 10n ** 18n;

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

  it('exige CADENA_RPC_URL', () => {
    expect(() => crearCadena({ ...valido, CADENA_RPC_URL: '' })).toThrow(
      'CADENA_RPC_URL',
    );
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
          params: { to?: string; data?: string }[];
        }) => {
          nodo.llamadas.push({
            metodo: p.method,
            a: p.params[0]?.to,
            datos: p.params[0]?.data,
          });
          return {
            jsonrpc: '2.0',
            id: p.id,
            result: p.method === 'eth_chainId' ? nodo.cadena : nodo.llamada,
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
    };
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
});
