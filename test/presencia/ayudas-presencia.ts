import { generateKeyPairSync } from 'node:crypto';
import type { Entorno } from '../ayudas-organizaciones.js';
import { firmar } from '../billetera/ayudas-billetera.js';
import { ayudasReservas, type Persona } from '../reservas/ayudas-reservas.js';

export const INTEGRO = 'simulado:integro';
/** Plaza 24 de Septiembre: punto de encuentro de las pruebas. */
export const ENCUENTRO = { lat: -17.783327, lng: -63.182129 };
/** 0,00009° de latitud son ~10 m; 0,00054°, ~60 m. */
export const A_10_M = 0.00009;
export const A_60_M = 0.00054;

export const par = () =>
  generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
export const pem = (k: ReturnType<typeof par>) =>
  k.publicKey.export({ type: 'spki', format: 'pem' }).toString();

export interface LlaveTrayecto {
  id: string;
  llave: ReturnType<typeof par>;
}
export interface Pasajero extends Persona {
  reservaId: string;
}
export interface Escenario {
  conductor: Persona;
  viajeId: string;
  pasajeros: Pasajero[];
}

export const posicion = (extra: object = {}) => ({
  ...ENCUENTRO,
  precisionM: 8,
  tomadaEn: Date.now(),
  simulada: false,
  ...extra,
});

/** Cliente de prueba de HU-22: viajes en la ventana de abordaje, llave de trayecto, códigos y abordajes firmados. */
// Recibe el cliente de reservas del archivo, si ya tiene uno: dos contadores de correos crearían el mismo `conductor1@…`.
export function ayudasPresencia(
  e: () => Entorno,
  r: ReturnType<typeof ayudasReservas> = ayudasReservas(e),
) {
  const conToken = r.b.conToken;

  /** Cambia la hora de salida respecto de ahora: con +10 min el viaje está dentro de la ventana (RN-3). */
  const moverSalida = (viajeId: string, msDesdeAhora: number) =>
    e().bd.query(
      `UPDATE viajes SET fecha_hora_salida = now() + make_interval(secs => $2::double precision / 1000) WHERE id = $1`,
      [viajeId, msDesdeAhora],
    );

  /** Conductor y pasajeros con reserva confirmada, y el viaje sale en 10 min. */
  const escenario = async (
    organizacionId: string,
    cuantos = 1,
  ): Promise<Escenario> => {
    const conductor = await r.conductor(organizacionId);
    const viajeId = await r.publicar(conductor);
    const pasajeros: Pasajero[] = [];
    for (let i = 0; i < cuantos; i++) {
      const p = await r.pasajero(organizacionId);
      const { reservaId } = (await r.reservar(p, viajeId).expect(201)).body;
      pasajeros.push({ ...p, reservaId });
    }
    await r.procesar();
    await moverSalida(viajeId, 10 * 60_000);
    return { conductor, viajeId, pasajeros };
  };

  /** La app del conductor al abrir «Mostrar código»: firma del teléfono (huella) e integridad. */
  const registrarLlave = (
    c: Persona,
    viajeId: string,
    extra: object = {},
    llave = par(),
  ) => {
    const ruta = `/api/v1/viajes/${viajeId}/llave-trayecto`;
    const cuerpo = {
      llavePublicaPem: pem(llave),
      tokenIntegridad: INTEGRO,
      ...extra,
    };
    return {
      llave,
      peticion: e()
        .api()
        .post(ruta)
        .set(conToken(c.token))
        .set(firmar('POST', ruta, c.dispositivo, JSON.stringify(cuerpo)))
        .send(cuerpo),
    };
  };

  const llaveConductor = async (
    s: Escenario,
    c: Persona = s.conductor,
  ): Promise<LlaveTrayecto> => {
    const { llave, peticion } = registrarLlave(c, s.viajeId);
    const { body } = await peticion.expect(201);
    return { id: body.llaveTrayectoId, llave };
  };

  /** Firma de la llave de trayecto: las mismas cabeceras, con `X-Llave-Trayecto-Id`. */
  const firmarTrayecto = (ruta: string, l: LlaveTrayecto, cuerpo: string) => {
    const { 'X-Dispositivo-Id': id, ...resto } = firmar(
      'POST',
      ruta,
      l,
      cuerpo,
    );
    return { ...resto, 'X-Llave-Trayecto-Id': id };
  };

  const desafio = (
    token: string,
    viajeId: string,
    l: LlaveTrayecto,
    cuerpo: object = { tipo: 'abordaje', posicion: posicion() },
  ) => {
    const ruta = `/api/v1/viajes/${viajeId}/desafios`;
    return e()
      .api()
      .post(ruta)
      .set(conToken(token))
      .set(firmarTrayecto(ruta, l, JSON.stringify(cuerpo)))
      .send(cuerpo);
  };

  /** Un código vigente del viaje. */
  const codigo = async (s: Escenario, l: LlaveTrayecto) =>
    (await desafio(s.conductor.token, s.viajeId, l).expect(201)).body
      .nonce as string;

  const abordar = (
    p: Persona,
    reservaId: string,
    nonce: string,
    extra: object = {},
  ) => {
    const ruta = `/api/v1/reservas/${reservaId}/abordaje`;
    const cuerpo = {
      nonce,
      posicion: posicion({ lat: ENCUENTRO.lat + A_10_M }),
      tokenIntegridad: INTEGRO,
      llavePublicaTrayectoPem: pem(par()),
      ...extra,
    };
    return e()
      .api()
      .post(ruta)
      .set(conToken(p.token))
      .set(firmar('POST', ruta, p.dispositivo, JSON.stringify(cuerpo)))
      .send(cuerpo);
  };

  const pruebas = async (reservaId: string) =>
    (
      await e().bd.query(
        `SELECT resultado, motivo, desafio_id, distancia_m, veredicto_integridad, hash_prueba, organizacion_id
         FROM pruebas_presencia WHERE reserva_id = $1 ORDER BY creado_en`,
        [reservaId],
      )
    ).rows;
  const estadoReserva = async (reservaId: string) =>
    (
      await e().bd.query(`SELECT estado FROM reservas WHERE id = $1`, [
        reservaId,
      ])
    ).rows[0]?.estado as string;
  const estadoViaje = async (viajeId: string) =>
    (await r.viaje(viajeId)).estado;

  return {
    r,
    escenario,
    moverSalida,
    registrarLlave,
    llaveConductor,
    firmarTrayecto,
    desafio,
    codigo,
    abordar,
    pruebas,
    estadoReserva,
    estadoViaje,
  };
}
