import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Wallet } from 'ethers';
import {
  BlockchainService,
  CadenaSimulada,
} from '../../src/blockchain/blockchain.service.js';
import { TrabajosOnchainService } from '../../src/blockchain/trabajos-onchain.service.js';
import { mensajeCanonico } from '../../src/comun/firma-dispositivo.guard.js';
import { DOMINIO, type Entorno } from '../ayudas-organizaciones.js';

export const URC = 10n ** 18n;

/** La cadena simulada con saldos y una falla activable. Su error lleva la URL del nodo a propósito: no debe llegar a logs ni respuestas. */
export class CadenaControlable extends CadenaSimulada {
  fallar = false;
  colgar = false;
  explorador: string | null = null;
  /** El nodo acuña pero la respuesta no llega; se apaga sola tras una vez. */
  perderRespuesta = false;
  lecturas = 0;
  acunaciones = 0;
  override saldos = new Map<string, bigint>();

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

  override async acunarRecarga(
    destino: string,
    monto: bigint,
    idOrden: string,
  ): Promise<string> {
    this.acunaciones++;
    if (this.fallar)
      throw Object.assign(
        new Error('nodo caído en https://nodo.test/clave-rpc'),
        { code: 'SERVER_ERROR' },
      );
    const hash = await super.acunarRecarga(destino, monto, idOrden);
    if (this.perderRespuesta) {
      this.perderRespuesta = false;
      throw Object.assign(new Error('sin respuesta'), { code: 'TIMEOUT' });
    }
    return hash;
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
/** Lo que haría la app: firma METODO, RUTA, TIMESTAMP, NONCE y SHA256(cuerpo) con la llave del Keystore. */
export function firmar(
  metodo: string,
  ruta: string,
  d: Dispositivo,
  cuerpo = '',
) {
  const marca = String(Date.now());
  const n = `nonce-billetera-${marca}-${++nonce}`;
  const mensaje = mensajeCanonico(metodo, ruta, marca, n, Buffer.from(cuerpo));
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
export const RUTA_RECARGAS = `${RUTA}/recargas`;
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
  /** Persona lista para recargar: verificada, con billetera y dispositivo. */
  const recargador = async (correo: string) => {
    const p = await persona(correo);
    return {
      ...p,
      ...(await billetera(p.id)),
      dispositivo: await vincular(p.id),
    };
  };
  const crearRecarga = (token: string, monto: unknown = 50) =>
    e().api().post(RUTA_RECARGAS).set(conToken(token)).send({ monto });
  const confirmarRecarga = (token: string, id: string, d: Dispositivo) => {
    const ruta = `${RUTA_RECARGAS}/${id}/confirmar`;
    return e()
      .api()
      .post(ruta)
      .set(conToken(token))
      .set(firmar('POST', ruta, d));
  };
  const consultarRecarga = (token: string, id: string) =>
    e().api().get(`${RUTA_RECARGAS}/${id}`).set(conToken(token));
  const worker = () => e().app.get(TrabajosOnchainService, { strict: false });
  /** Adelanta el reintento, como si la espera ya hubiera pasado. */
  const vencerEspera = (ordenId: string) =>
    e().bd.query(
      `UPDATE trabajos_onchain SET proximo_intento_en = now()
       WHERE movimiento_id = (SELECT id FROM movimientos_billetera WHERE clave_idempotencia = $1)`,
      [`recarga:${ordenId}`],
    );
  /** Quita lo que dejó la prueba anterior: el worker procesa toda la cola, no solo la orden de la prueba. */
  const vaciarCola = () =>
    e().bd.query(
      `DELETE FROM trabajos_onchain WHERE movimiento_id IN (
         SELECT m.id FROM movimientos_billetera m
         JOIN billeteras b ON b.id = m.billetera_id
         JOIN usuarios u ON u.id = b.usuario_id
         WHERE u.correo LIKE '%${DOMINIO.slice(1)}')`,
    );
  const filaOrden = async (id: string) =>
    (await e().bd.query(`SELECT * FROM ordenes_recarga WHERE id = $1`, [id]))
      .rows[0];
  const filasDeOrden = async (ordenId: string) => {
    const { rows } = await e().bd.query(
      `SELECT m.estado, m.hash_tx, m.monto, t.estado AS trabajo, t.intentos
       FROM movimientos_billetera m LEFT JOIN trabajos_onchain t ON t.movimiento_id = m.id
       WHERE m.clave_idempotencia = $1`,
      [`recarga:${ordenId}`],
    );
    return rows;
  };
  return {
    recargador,
    crearRecarga,
    confirmarRecarga,
    consultarRecarga,
    worker,
    vencerEspera,
    vaciarCola,
    filaOrden,
    filasDeOrden,
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
