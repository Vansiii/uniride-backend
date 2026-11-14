import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Contract,
  ContractFactory,
  id,
  JsonRpcProvider,
  keccak256,
  toUtf8Bytes,
  Wallet,
} from 'ethers';
import {
  CadenaReal,
  ErrorBloqueoPermanente,
} from '../../src/blockchain/blockchain.service.js';

/**
 * HU-19, definición de hecho: bloqueo real con `permit` contra `EscrowUniRide` en un nodo Hardhat local.
 * Se omite sin nodo: `npm run nodo` en `contracts/` y luego `HARDHAT_RPC_URL=http://127.0.0.1:8545 npm run test:e2e`.
 * Despliega contratos propios con los artefactos compilados de `contracts/` (`npm run build` allí).
 */
const RPC = process.env.HARDHAT_RPC_URL;
/** Cuentas 0, 1 y 2 de Hardhat: llaves públicas y sin valor. */
const LLAVE_ADMIN =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const LLAVE_RELAYER =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
/** HU-24: la cuenta verificadora, distinta del relayer. */
const LLAVE_VERIFICADOR =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const URC = 10n ** 18n;
const artefacto = (nombre: string) =>
  JSON.parse(
    readFileSync(
      resolve(
        '..',
        'contracts',
        'artifacts',
        'contracts',
        `${nombre}.sol`,
        `${nombre}.json`,
      ),
      'utf8',
    ),
  ) as { abi: unknown[]; bytecode: string };

describe.skipIf(!RPC)('EscrowUniRide real: bloquear con permit (e2e)', () => {
  let proveedor: JsonRpcProvider;
  let token: Contract;
  let escrow: Contract;
  let cadena: CadenaReal;
  const ROL_ACUNADOR = keccak256(toUtf8Bytes('ROL_ACUNADOR'));
  const ROL_OPERADOR = keccak256(toUtf8Bytes('ROL_OPERADOR'));
  const ROL_VERIFICADOR = keccak256(toUtf8Bytes('ROL_VERIFICADOR'));
  let n = 0;
  const nuevaReserva = () => id(`reserva-hardhat-${Date.now()}-${++n}`);

  /** Pasajero sin ETH: el relayer paga el gas, como en producción. */
  const pasajero = async (urc: bigint) => {
    const cuenta = Wallet.createRandom();
    await cadena.acunarRecarga(
      cuenta.address,
      urc * URC,
      id(`recarga-${cuenta.address}`),
    );
    return cuenta;
  };
  const conductor = () => Wallet.createRandom().address;

  beforeAll(async () => {
    proveedor = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
    const admin = new Wallet(LLAVE_ADMIN, proveedor);
    const relayer = new Wallet(LLAVE_RELAYER, proveedor);
    const cUrc = artefacto('UniCoin');
    const cEscrow = artefacto('EscrowUniRide');
    const desplegado = await new ContractFactory(
      cUrc.abi as never,
      cUrc.bytecode,
      admin,
    ).deploy(admin.address);
    await desplegado.waitForDeployment();
    token = new Contract(
      await desplegado.getAddress(),
      cUrc.abi as never,
      admin,
    );
    const e = await new ContractFactory(
      cEscrow.abi as never,
      cEscrow.bytecode,
      admin,
    ).deploy(await token.getAddress(), admin.address);
    await e.waitForDeployment();
    escrow = new Contract(await e.getAddress(), cEscrow.abi as never, admin);
    // El despliegue no otorga los roles (hallazgo del plan de HU-19).
    await (await token.grantRole(ROL_ACUNADOR, relayer.address)).wait();
    await (await escrow.grantRole(ROL_OPERADOR, relayer.address)).wait();
    await (
      await escrow.grantRole(
        ROL_VERIFICADOR,
        new Wallet(LLAVE_VERIFICADOR).address,
      )
    ).wait();
    const { chainId } = await proveedor.getNetwork();
    cadena = new CadenaReal(
      RPC as string,
      await token.getAddress(),
      Number(chainId),
      undefined,
      LLAVE_RELAYER,
      await escrow.getAddress(),
      LLAVE_VERIFICADOR,
    );
  });

  it('bloquea el pasaje con el permit del pasajero, que no tiene ETH, y lo deja en el escrow', async () => {
    const p = await pasajero(50n);
    const c = conductor();
    const idReserva = nuevaReserva();
    const hash = await cadena.bloquearReserva({
      idReserva,
      llavePagador: p.privateKey,
      conductor: c,
      monto: 10n * URC + URC / 2n,
    });

    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await cadena.leerSaldo(p.address)).toBe(39n * URC + URC / 2n);
    expect(
      await cadena.leerSaldo(await escrow.getAddress()),
    ).toBeGreaterThanOrEqual(10n * URC);
    expect(await cadena.leerSaldo(c)).toBe(0n);
    expect(await cadena.estadoReservaEscrow(idReserva)).toEqual({
      estado: 'bloqueada',
      pagador: p.address,
      conductor: c,
      monto: 10n * URC + URC / 2n,
      hashPrueba: `0x${'00'.repeat(32)}`,
    });
    // Respuesta perdida: el hash se recupera del evento, sin enviar otra transacción.
    expect(await cadena.hashDeBloqueo(idReserva)).toBe(hash);
    // El permit se gastó con su nonce; el escrow no deja autorización colgada.
    expect(await token.allowance(p.address, await escrow.getAddress())).toBe(
      0n,
    );
  });

  it('antes de bloquear la reserva no existe en el escrow', async () => {
    const r = await cadena.estadoReservaEscrow(nuevaReserva());
    expect(r.estado).toBe('ninguno');
  });

  it('dos reservas seguidas del mismo pasajero: el nonce del permit avanza y ambas valen', async () => {
    const p = await pasajero(50n);
    const c = conductor();
    for (let i = 0; i < 2; i++)
      await cadena.bloquearReserva({
        idReserva: nuevaReserva(),
        llavePagador: p.privateKey,
        conductor: c,
        monto: 10n * URC,
      });
    expect(await cadena.leerSaldo(p.address)).toBe(30n * URC);
  });

  it('repetir la misma reserva revierte con ReservaExistente: falla permanente y nada se cobra dos veces', async () => {
    const p = await pasajero(50n);
    const datos = {
      idReserva: nuevaReserva(),
      llavePagador: p.privateKey,
      conductor: conductor(),
      monto: 10n * URC,
    };
    await cadena.bloquearReserva(datos);
    const segunda = cadena.bloquearReserva(datos);
    await expect(segunda).rejects.toBeInstanceOf(ErrorBloqueoPermanente);
    await expect(segunda).rejects.toMatchObject({ motivo: 'ReservaExistente' });
    expect(await cadena.leerSaldo(p.address)).toBe(40n * URC);
  });

  it('sin saldo el contrato revierte con ERC20InsufficientBalance: falla permanente, sin cobro', async () => {
    const p = await pasajero(5n);
    const falla = cadena.bloquearReserva({
      idReserva: nuevaReserva(),
      llavePagador: p.privateKey,
      conductor: conductor(),
      monto: 10n * URC,
    });
    await expect(falla).rejects.toBeInstanceOf(ErrorBloqueoPermanente);
    await expect(falla).rejects.toMatchObject({
      motivo: 'ERC20InsufficientBalance',
    });
    expect(await cadena.leerSaldo(p.address)).toBe(5n * URC);
  });

  it('pagador igual al conductor revierte con DatosInvalidos: falla permanente', async () => {
    const p = await pasajero(50n);
    await expect(
      cadena.bloquearReserva({
        idReserva: nuevaReserva(),
        llavePagador: p.privateKey,
        conductor: p.address,
        monto: 10n * URC,
      }),
    ).rejects.toMatchObject({ motivo: 'DatosInvalidos' });
  });

  it('un nodo caído no es una falla permanente: el worker reintenta', async () => {
    const p = await pasajero(50n);
    const sinNodo = new CadenaReal(
      'http://127.0.0.1:1',
      await token.getAddress(),
      31337,
      500,
      LLAVE_RELAYER,
      await escrow.getAddress(),
    );
    const falla = sinNodo.bloquearReserva({
      idReserva: nuevaReserva(),
      llavePagador: p.privateKey,
      conductor: conductor(),
      monto: 10n * URC,
    });
    await expect(falla).rejects.toThrow();
    await expect(falla).rejects.not.toBeInstanceOf(ErrorBloqueoPermanente);
  });

  describe('HU-24: liberar', () => {
    const HASH_PRUEBA = `0x${'cd'.repeat(32)}`;
    const bloqueada = async () => {
      const p = await pasajero(50n);
      const c = conductor();
      const idReserva = nuevaReserva();
      await cadena.bloquearReserva({
        idReserva,
        llavePagador: p.privateKey,
        conductor: c,
        monto: 10n * URC + URC / 2n,
      });
      return { c, idReserva };
    };

    it('CA-1, CA-2: la cuenta verificadora paga al conductor y la red guarda el hash de la prueba', async () => {
      const { c, idReserva } = await bloqueada();
      const hash = await cadena.liberarReserva(idReserva, HASH_PRUEBA);

      expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(await cadena.leerSaldo(c)).toBe(10n * URC + URC / 2n);
      expect(await cadena.estadoReservaEscrow(idReserva)).toMatchObject({
        estado: 'liberada',
        hashPrueba: HASH_PRUEBA,
      });
      // Respuesta perdida: el hash sale del evento PagoLiberado.
      expect(await cadena.hashDeLiberacion(idReserva)).toBe(hash);
    });

    it('CA-4: liberar otra vez revierte con ReservaNoBloqueada y el conductor cobra una sola vez', async () => {
      const { c, idReserva } = await bloqueada();
      await cadena.liberarReserva(idReserva, HASH_PRUEBA);
      await expect(
        cadena.liberarReserva(idReserva, HASH_PRUEBA),
      ).rejects.toThrow();
      expect(await cadena.leerSaldo(c)).toBe(10n * URC + URC / 2n);
    });

    it('CA-5 / A-09: con la llave del relayer como verificadora el contrato rechaza y nada se paga', async () => {
      const { c, idReserva } = await bloqueada();
      const conRelayer = new CadenaReal(
        RPC as string,
        await token.getAddress(),
        31337,
        undefined,
        LLAVE_RELAYER,
        await escrow.getAddress(),
        LLAVE_RELAYER,
      );
      await expect(
        conRelayer.liberarReserva(idReserva, HASH_PRUEBA),
      ).rejects.toThrow();
      expect(await cadena.leerSaldo(c)).toBe(0n);
      expect((await cadena.estadoReservaEscrow(idReserva)).estado).toBe(
        'bloqueada',
      );
    });
  });
});
