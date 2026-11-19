import { generateKeyPairSync } from 'node:crypto';
import { getBytes, SigningKey, Transaction, Wallet, getAddress } from 'ethers';
import { describe, expect, it } from 'vitest';
import { derARS, direccionDeSpki, FirmanteKms } from './firmante-kms.js';

/** Entero a DER INTEGER (con 0x00 delante si el bit alto está activo). */
function enteroDer(n: bigint): number[] {
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const bytes = [...getBytes('0x' + hex)];
  if (bytes[0] & 0x80) bytes.unshift(0);
  return [0x02, bytes.length, ...bytes];
}

/** KMS simulado con una llave secp256k1 real: firma el digest igual que KMS (DER, `s` cualquiera). */
function kmsSimulado() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
  });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const llave = new SigningKey(
    '0x' +
      Buffer.from(
        privateKey.export({ format: 'jwk' }).d!,
        'base64url',
      ).toString('hex'),
  );
  const direccion = getAddress(direccionDeSpki(spki));
  return {
    direccion,
    kms: {
      send: async (comando: { constructor: { name: string }; input: any }) =>
        comando.constructor.name === 'GetPublicKeyCommand'
          ? { PublicKey: new Uint8Array(spki) }
          : {
              Signature: (() => {
                const f = llave.sign(comando.input.Message);
                // Como KMS, firma el digest tal cual y puede devolver `s` alto: se invierte a propósito.
                const cuerpo = [
                  ...enteroDer(BigInt(f.r)),
                  ...enteroDer(BigInt(f.s)),
                ];
                return new Uint8Array([0x30, cuerpo.length, ...cuerpo]);
              })(),
            },
    } as never,
  };
}

describe('FirmanteKms (A-12)', () => {
  it('deriva la dirección de la llave pública de KMS', async () => {
    const { kms, direccion } = kmsSimulado();
    expect(await new FirmanteKms('k', kms).getAddress()).toBe(direccion);
  });

  it('firma una transacción que recupera la dirección de la llave', async () => {
    const { kms, direccion } = kmsSimulado();
    const firmante = new FirmanteKms('k', kms);
    const crudo = await firmante.signTransaction({
      to: Wallet.createRandom().address,
      chainId: 80002,
      nonce: 0,
      gasLimit: 21000,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      type: 2,
    });
    expect(Transaction.from(crudo).from).toBe(direccion);
  });

  it('conserva chainId y campos al firmar un Transaction, como hace sendTransaction', async () => {
    const { kms, direccion } = kmsSimulado();
    const tx = Transaction.from({
      to: Wallet.createRandom().address,
      chainId: 80002,
      nonce: 3,
      gasLimit: 100000,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      type: 2,
      data: '0x1234',
    });
    const firmada = Transaction.from(
      await new FirmanteKms('k', kms).signTransaction(tx),
    );
    expect(firmada.chainId).toBe(80002n);
    expect(firmada.nonce).toBe(3);
    expect(firmada.data).toBe('0x1234');
    expect(firmada.from).toBe(direccion);
  });

  it('rechaza una transacción de otra cuenta y no firma mensajes', async () => {
    const firmante = new FirmanteKms('k', kmsSimulado().kms);
    await expect(
      firmante.signTransaction({ from: Wallet.createRandom().address }),
    ).rejects.toThrow('otra cuenta');
    await expect(firmante.signMessage()).rejects.toThrow('solo firma');
  });

  it('lee r y s de una firma DER', () => {
    const der = Uint8Array.from([0x30, 6, 2, 1, 5, 2, 1, 7]);
    expect(derARS(der)).toEqual({ r: 5n, s: 7n });
  });
});
