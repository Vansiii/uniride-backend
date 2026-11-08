import { generateKeyPairSync, sign } from 'node:crypto';
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
  explorador: string | null = null;
  lecturas = 0;
  saldos = new Map<string, bigint>();

  override async leerSaldo(direccion?: string): Promise<bigint> {
    this.lecturas++;
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
  return { preparar, vincular, conToken, crear, mia, filas, auditorias };
}
