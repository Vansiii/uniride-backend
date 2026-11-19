import {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
} from '@aws-sdk/client-kms';
import {
  AbstractSigner,
  computeAddress,
  getAddress,
  recoverAddress,
  resolveAddress,
  Signature,
  Transaction,
  type Provider,
  type TransactionLike,
  type TransactionRequest,
  type TypedDataDomain,
  type TypedDataField,
} from 'ethers';

/** Orden de la curva secp256k1: la firma se normaliza a `s` bajo (EIP-2). */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Lee un entero DER (INTEGER) y devuelve su valor y la posición siguiente. */
function leerEntero(der: Uint8Array, pos: number): [bigint, number] {
  if (der[pos] !== 0x02) throw new Error('Firma DER inválida');
  const largo = der[pos + 1];
  let valor = 0n;
  for (const byte of der.subarray(pos + 2, pos + 2 + largo))
    valor = (valor << 8n) | BigInt(byte);
  return [valor, pos + 2 + largo];
}

/** Firma ECDSA en DER (`SEQUENCE { r, s }`) a sus dos enteros. */
export function derARS(der: Uint8Array): { r: bigint; s: bigint } {
  if (der[0] !== 0x30) throw new Error('Firma DER inválida');
  // Largo de la secuencia de 1 byte (firmas de 70 a 72 bytes) o de 2 con 0x81.
  const inicio = der[1] === 0x81 ? 3 : 2;
  const [r, siguiente] = leerEntero(der, inicio);
  const [s] = leerEntero(der, siguiente);
  return { r, s };
}

/** Dirección Ethereum de una llave pública SPKI DER de KMS (los últimos 65 bytes son `04 || X || Y`). */
export function direccionDeSpki(spki: Uint8Array): string {
  const sinCompresion = spki.subarray(spki.length - 65);
  if (sinCompresion[0] !== 0x04) throw new Error('Llave pública inválida');
  return computeAddress('0x' + Buffer.from(sinCompresion).toString('hex'));
}

/**
 * Firmante de ethers cuya llave privada vive en AWS KMS (ECC_SECG_P256K1) y nunca sale de él (A-12).
 * Solo firma transacciones: el relayer y el verificador no necesitan firmar mensajes ni datos tipados.
 */
export class FirmanteKms extends AbstractSigner {
  private direccion?: string;

  constructor(
    private readonly llaveId: string,
    private readonly kms: Pick<KMSClient, 'send'> = new KMSClient({}),
    proveedor?: Provider | null,
  ) {
    super(proveedor);
  }

  connect(proveedor: Provider | null): FirmanteKms {
    return new FirmanteKms(this.llaveId, this.kms, proveedor);
  }

  async getAddress(): Promise<string> {
    if (this.direccion) return this.direccion;
    const { PublicKey } = await this.kms.send(
      new GetPublicKeyCommand({ KeyId: this.llaveId }),
    );
    if (!PublicKey) throw new Error('KMS no devolvió la llave pública');
    return (this.direccion = getAddress(direccionDeSpki(PublicKey)));
  }

  async signTransaction(tx: TransactionRequest): Promise<string> {
    const direccion = await this.getAddress();
    const from = tx.from ? await resolveAddress(tx.from) : null;
    if (from && from !== direccion)
      throw new Error('La transacción es de otra cuenta que la llave KMS');
    const to = tx.to ? await resolveAddress(tx.to) : null;
    // `sendTransaction` entrega un `Transaction`: sus campos son getters y `{...tx}` quedaría vacío (chainId 0).
    const transaccion =
      tx instanceof Transaction
        ? tx.clone()
        : Transaction.from({
            ...tx,
            to,
            from: undefined,
          } as TransactionLike<string>);
    transaccion.signature = await this.firmar(
      transaccion.unsignedHash,
      direccion,
    );
    return transaccion.serialized;
  }

  signMessage(): Promise<string> {
    return Promise.reject(new Error('FirmanteKms solo firma transacciones'));
  }

  signTypedData(
    _dominio?: TypedDataDomain,
    _tipos?: Record<string, TypedDataField[]>,
    _valor?: Record<string, unknown>,
  ): Promise<string> {
    return Promise.reject(new Error('FirmanteKms solo firma transacciones'));
  }

  /** Firma el hash con KMS y averigua `v` probando cuál de las dos recuperaciones da la dirección de la llave. */
  private async firmar(hash: string, direccion: string): Promise<Signature> {
    const { Signature: der } = await this.kms.send(
      new SignCommand({
        KeyId: this.llaveId,
        Message: Buffer.from(hash.slice(2), 'hex'),
        MessageType: 'DIGEST',
        SigningAlgorithm: 'ECDSA_SHA_256',
      }),
    );
    if (!der) throw new Error('KMS no devolvió la firma');
    const { r, s: sCrudo } = derARS(der);
    // KMS puede devolver `s` alto; Ethereum solo acepta el bajo.
    const s = sCrudo > N / 2n ? N - sCrudo : sCrudo;
    for (const v of [27, 28]) {
      const firma = Signature.from({
        r: '0x' + r.toString(16).padStart(64, '0'),
        s: '0x' + s.toString(16).padStart(64, '0'),
        v,
      });
      if (recoverAddress(hash, firma) === direccion) return firma;
    }
    throw new Error('La firma de KMS no corresponde a la llave');
  }
}
