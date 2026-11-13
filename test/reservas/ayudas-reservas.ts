import { randomUUID } from 'node:crypto';
import { Wallet } from 'ethers';
import { urcAUnidades } from '../../src/blockchain/blockchain.service.js';
import { cifrarLlave } from '../../src/billetera/custodia.js';
import type { Entorno } from '../ayudas-organizaciones.js';
import {
  ayudasBilletera,
  firmar,
  type CadenaControlable,
} from '../billetera/ayudas-billetera.js';
import {
  ayudasViajes,
  cuerpoViaje,
  type Conductor,
} from '../viajes/ayudas-viajes.js';

export const RUTA_RESERVAS = '/api/v1/reservas';
export const rutaReservar = (viajeId: string) =>
  `/api/v1/viajes/${viajeId}/reservas`;

export interface Persona extends Conductor {
  billetera: string;
  direccion: string;
}

/** Cliente de prueba de HU-19: personas con billetera y saldo, viajes publicados, reservas firmadas y el worker. */
export function ayudasReservas(e: () => Entorno) {
  const v = ayudasViajes(e);
  const b = ayudasBilletera(e);
  let cadena: CadenaControlable;

  /** Cadena nueva por prueba: el escrow simulado y los saldos empiezan vacíos. */
  const preparar = async () => {
    // El worker procesa toda la cola: sin esto, una prueba cargaría los trabajos que dejó la anterior.
    await b.vaciarCola();
    cadena = b.preparar();
  };

  /** Con la llave cifrada de verdad: el worker la descifra para firmar el permit. */
  const billeteraConLlave = async (usuarioId: string) => {
    const cuenta = Wallet.createRandom();
    const { rows } = await e().bd.query(
      `INSERT INTO billeteras (usuario_id, direccion, llave_custodia_ref) VALUES ($1, $2, $3) RETURNING id`,
      [
        usuarioId,
        cuenta.address,
        cifrarLlave(cuenta.privateKey, cuenta.address),
      ],
    );
    return { billetera: rows[0].id as string, direccion: cuenta.address };
  };

  /** Recarga confirmada en el libro y los mismos URC en la cadena simulada. */
  const fondear = async (p: Persona, monto: string) => {
    await b.asiento(p.billetera, { monto });
    cadena.saldos.set(
      p.direccion,
      (cadena.saldos.get(p.direccion) ?? 0n) + urcAUnidades(monto),
    );
  };

  /** Miembro verificado con teléfono, billetera y saldo; sin vehículo, es solo pasajero. */
  const pasajero = async (
    organizacionId: string,
    saldo = '50.00',
  ): Promise<Persona> => {
    const c = await v.conductor(organizacionId, { vehiculo: false });
    const p = { ...c, ...(await billeteraConLlave(c.id)) };
    if (saldo !== '0.00') await fondear(p, saldo);
    return p;
  };

  /** Conductor con vehículo y billetera (sin saldo: cobra al liberar, HU-24). */
  const conductor = async (organizacionId: string): Promise<Persona> => {
    const c = await v.conductor(organizacionId);
    return { ...c, ...(await billeteraConLlave(c.id)) };
  };

  const publicar = async (c: Persona, extra: object = {}): Promise<string> =>
    (await v.publicar(c, cuerpoViaje(extra)).expect(201)).body.id as string;

  /** Reserva con la firma del teléfono sobre el cuerpo exacto que se envía. */
  const reservar = (
    p: Conductor,
    viajeId: string,
    claveIdempotencia: string = randomUUID(),
    extra: object = {},
  ) => {
    const cuerpo = { claveIdempotencia, ...extra };
    const ruta = rutaReservar(viajeId);
    return e()
      .api()
      .post(ruta)
      .set(b.conToken(p.token))
      .set(firmar('POST', ruta, p.dispositivo, JSON.stringify(cuerpo)))
      .send(cuerpo);
  };

  const reserva = (token: string, id: string) =>
    e().api().get(`${RUTA_RESERVAS}/${id}`).set(b.conToken(token));
  const mias = (token: string) =>
    e().api().get(`${RUTA_RESERVAS}/mias`).set(b.conToken(token));
  const pasajeros = (token: string, viajeId: string) =>
    e().api().get(`/api/v1/viajes/${viajeId}/pasajeros`).set(b.conToken(token));

  const procesar = () => b.worker().procesarPendientes();
  /** Adelanta el reintento, como si la espera ya hubiera pasado. */
  const vencerEspera = (reservaId: string) =>
    e().bd.query(
      `UPDATE trabajos_onchain SET proximo_intento_en = now()
       WHERE movimiento_id IN (SELECT id FROM movimientos_billetera WHERE reserva_id = $1)`,
      [reservaId],
    );

  const filasReserva = async (viajeId: string) =>
    (
      await e().bd.query(
        `SELECT * FROM reservas WHERE viaje_id = $1 ORDER BY creado_en`,
        [viajeId],
      )
    ).rows;
  const viaje = async (id: string) =>
    (
      await e().bd.query(
        `SELECT estado, cupos_disponibles, cupos_totales FROM viajes WHERE id = $1`,
        [id],
      )
    ).rows[0] as { estado: string; cupos_disponibles: number };
  const movimientosDeReserva = async (reservaId: string) =>
    (
      await e().bd.query(
        `SELECT m.tipo, m.estado, m.hash_tx, m.monto::text AS monto, m.billetera_id, t.estado AS trabajo, t.intentos, t.ultimo_error
         FROM movimientos_billetera m LEFT JOIN trabajos_onchain t ON t.movimiento_id = m.id
         WHERE m.reserva_id = $1 ORDER BY m.creado_en`,
        [reservaId],
      )
    ).rows;
  const auditorias = async (reservaId: string) =>
    (
      await e().bd.query(
        `SELECT accion, resultado, actor_id, detalle FROM registros_auditoria
         WHERE entidad = 'reserva' AND entidad_id = $1 ORDER BY creado_en`,
        [reservaId],
      )
    ).rows;
  /** Todo lo que dejó el pasajero: reservas, movimientos de bloqueo y trabajos en cola. */
  const huella = async (usuarioId: string) => {
    const { rows } = await e().bd.query(
      `SELECT
         (SELECT count(*) FROM reservas WHERE pasajero_id = $1)::int AS reservas,
         (SELECT count(*) FROM movimientos_billetera m JOIN billeteras b ON b.id = m.billetera_id
            WHERE b.usuario_id = $1 AND m.tipo = 'bloqueo_reserva')::int AS bloqueos`,
      [usuarioId],
    );
    return rows[0] as { reservas: number; bloqueos: number };
  };
  const saldo = (p: Persona) => b.saldo(p.token);

  return {
    v,
    b,
    preparar,
    cadena: () => cadena,
    pasajero,
    conductor,
    publicar,
    reservar,
    reserva,
    mias,
    pasajeros,
    procesar,
    vencerEspera,
    filasReserva,
    viaje,
    movimientosDeReserva,
    auditorias,
    huella,
    saldo,
    fondear,
  };
}
