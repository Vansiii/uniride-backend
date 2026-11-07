import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Wallet } from 'ethers';
import {
  BlockchainService,
  CadenaSimulada,
} from '../../src/blockchain/blockchain.service.js';
import { mensajeCanonico } from '../../src/comun/firma-dispositivo.guard.js';
import type { Entorno } from '../ayudas-organizaciones.js';

export const URC = 10n ** 18n;

/** La cadena simulada con saldos y una falla activable. Su error lleva la URL del nodo a propósito: no debe llegar a logs ni respuestas. */
export class CadenaControlable extends CadenaSimulada {
  fallar = false;
  colgar = false;
  explorador: string | null = null;
  lecturas = 0;
  saldos = new Map<string, bigint>();

  override async leerSaldo(direccion?: string): Promise<bigint> {
    this.lecturas++;
    if (this.colgar) return new Promise<bigint>(() => {});
    if (this.fallar)
      throw Object.assign(
        new Error('nodo caído en https://nodo.test/clave-rpc'),
        {
          code: 'SERVER_ERROR',
        },
      );
    return this.saldos.get(direccion ?? '') ?? 0n;
  }

  override exploradorUrl(): string | null {
    return this.explorador;
  }

  override exploradorTxUrl(hashTx?: string): string | null {
    return this.explorador && `${this.explorador}/tx/${hashTx}`;
  }
}

export interface Dispositivo {
  id: string;
  llave: ReturnType<typeof par>;
}
const par = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

let nonce = 0;
/** Lo que haría la app: firma METODO, RUTA, TIMESTAMP, NONCE y SHA256(cuerpo vacío) con la llave del Keystore. */
export function firmar(metodo: string, ruta: string, d: Dispositivo) {
  const marca = String(Date.now());
  const n = `nonce-billetera-${marca}-${++nonce}`;
  const mensaje = mensajeCanonico(metodo, ruta, marca, n, Buffer.alloc(0));
  return {
    'X-Dispositivo-Id': d.id,
    'X-Timestamp': marca,
    'X-Nonce': n,
    'X-Firma': sign(
      'sha256',
      Buffer.from(mensaje),
      d.llave.privateKey,
    ).toString('base64'),
  };
}

export const RUTA = '/api/v1/billetera';
export const RUTA_MIA = `${RUTA}/mia`;
export const RUTA_SALDO = `${RUTA}/saldo`;
export const RUTA_MOVIMIENTOS = `${RUTA}/movimientos`;
export const HASH = `0x${'ab'.repeat(32)}`;

/** Cliente de prueba de los endpoints de billetera, con la cadena controlable reiniciada por prueba. */
export function ayudasBilletera(e: () => Entorno) {
  const preparar = () => {
    const cadena = new CadenaControlable();
    e().app.get(BlockchainService, { strict: false }).cadena = cadena;
    return cadena;
  };
  /** Vincula un dispositivo directo en BD: su flujo ya lo prueba HU-09. */
  const vincular = async (usuarioId: string): Promise<Dispositivo> => {
    const llave = par();
    const { rows } = await e().bd.query(
      `INSERT INTO dispositivos (usuario_id, llave_publica, modelo_dispositivo, veredicto_integridad)
       VALUES ($1, $2, 'Pixel 8', 'SIMULADO') RETURNING id`,
      [usuarioId, llave.publicKey.export({ type: 'spki', format: 'pem' })],
    );
    return { id: rows[0].id, llave };
  };
  const conToken = (token: string) => ({ Authorization: `Bearer ${token}` });
  const crear = (token: string, d: Dispositivo) =>
    e()
      .api()
      .post(RUTA)
      .set(conToken(token))
      .set(firmar('POST', RUTA, d));
  const mia = (token: string, d: Dispositivo) =>
    e()
      .api()
      .get(RUTA_MIA)
      .set(conToken(token))
      .set(firmar('GET', RUTA_MIA, d));
  const filas = async (usuarioId: string) =>
    (
      await e().bd.query(`SELECT * FROM billeteras WHERE usuario_id = $1`, [
        usuarioId,
      ])
    ).rows;
  const auditorias = async (actorId: string) =>
    (
      await e().bd.query(
        `SELECT * FROM registros_auditoria WHERE accion = 'billetera.creacion' AND actor_id = $1 ORDER BY creado_en`,
        [actorId],
      )
    ).rows;
  const saldo = (token: string) =>
    e().api().get(RUTA_SALDO).set(conToken(token));
  const movimientos = (token: string, consulta: object = {}) =>
    e().api().get(RUTA_MOVIMIENTOS).set(conToken(token)).query(consulta);
  /** Usuario con identidad (verificada por omisión; `null` sin fila) y sesión. Sin dispositivo: estas lecturas no firman. */
  const persona = async (
    correo: string,
    estado: string | null = 'verificada',
  ) => {
    const id = await e().crearUsuario(correo);
    if (estado) {
      const verificada = estado === 'verificada';
      await e().bd.query(
        `INSERT INTO identidades (usuario_id, estado, consentimiento_en, documento_hash, verificado_en)
         VALUES ($1, $2, now(), $3, $4)`,
        [
          id,
          estado,
          verificada ? `hash-${correo}` : null,
          verificada ? new Date() : null,
        ],
      );
    }
    return { id, token: await e().iniciar(correo) };
  };
  /** Billetera directa en BD: su creación ya la prueba HU-12. */
  const billetera = async (usuarioId: string) => {
    const direccion = Wallet.createRandom().address;
    const { rows } = await e().bd.query(
      `INSERT INTO billeteras (usuario_id, direccion, llave_custodia_ref) VALUES ($1, $2, 'cifrada') RETURNING id`,
      [usuarioId, direccion],
    );
    return { billetera: rows[0].id as string, direccion };
  };
  /** Asiento directo en BD; por omisión una recarga confirmada de hoy. */
  const asiento = async (
    billeteraId: string,
    o: {
      tipo?: string;
      monto?: string;
      estado?: string;
      reservaId?: string;
      creadoEn?: Date;
    } = {},
  ) => {
    const estado = o.estado ?? 'confirmado';
    const { rows } = await e().bd.query(
      `INSERT INTO movimientos_billetera (billetera_id, tipo, monto, estado, reserva_id, hash_tx, clave_idempotencia, creado_en)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        billeteraId,
        o.tipo ?? 'recarga',
        o.monto ?? '10.00',
        estado,
        o.reservaId ?? null,
        estado === 'confirmado' ? HASH : null,
        randomUUID(),
        o.creadoEn ?? new Date(),
      ],
    );
    return rows[0].id as string;
  };
  return {
    preparar,
    vincular,
    conToken,
    crear,
    mia,
    filas,
    auditorias,
    saldo,
    movimientos,
    persona,
    billetera,
    asiento,
  };
}
