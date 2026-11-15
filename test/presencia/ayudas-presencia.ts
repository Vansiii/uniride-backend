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
/** Personas ya creadas para un escenario (HU-24 A-10 mide sus saldos antes de reservar). */
export interface Personas {
  conductor: Persona;
  pasajeros: Persona[];
}

export interface Escenario {
  conductor: Persona;
  viajeId: string;
  pasajeros: Pasajero[];
}

/** Grados de latitud que miden `m` metros sobre un meridiano. */
export const gradosLat = (m: number) => ((m / 6_371_008.8) * 180) / Math.PI;

/**
 * HU-23: `n` posiciones cada 15 s hacia el norte desde el encuentro, la última hace `hastaHaceS` segundos, a `kmh` y
 * corridas `desplazamientoM` hacia el norte.
 */
export const traza = (
  n: number,
  { kmh = 30, hastaHaceS = 5, desplazamientoM = 0, simulada = false } = {},
) => {
  const ahora = Date.now();
  const metrosPorPaso = (kmh * 1000 * 15) / 3600;
  return Array.from({ length: n }, (_, i) => ({
    lat: ENCUENTRO.lat + gradosLat(i * metrosPorPaso + desplazamientoM),
    lng: ENCUENTRO.lng,
    precisionM: 8,
    tomadaEn: ahora - (hastaHaceS + (n - 1 - i) * 15) * 1000,
    simulada,
  }));
};

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
    personas?: Personas,
  ): Promise<Escenario> => {
    const conductor =
      personas?.conductor ?? (await r.conductor(organizacionId));
    const viajeId = await r.publicar(conductor);
    const pasajeros: Pasajero[] = [];
    for (let i = 0; i < cuantos; i++) {
      const p = personas?.pasajeros[i] ?? (await r.pasajero(organizacionId));
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

  /** Aborda y devuelve la llave de trayecto del pasajero, la que firma sus posiciones (HU-23). */
  const abordarConLlave = async (
    s: Escenario,
    p: Pasajero,
    l: LlaveTrayecto,
  ): Promise<LlaveTrayecto> => {
    const llave = par();
    const { body } = await abordar(p, p.reservaId, await codigo(s, l), {
      llavePublicaTrayectoPem: pem(llave),
    }).expect(200);
    return { id: body.llaveTrayectoId, llave };
  };

  /** HU-23: el abordaje pasó hace `ms`, así las posiciones con hora anterior a ahora entran en el trayecto. */
  const retrasarAbordaje = (reservaId: string, ms: number) =>
    e().bd.query(
      `UPDATE pruebas_presencia SET creado_en = creado_en - make_interval(secs => $2::double precision / 1000)
       WHERE reserva_id = $1 AND tipo = 'abordaje'`,
      [reservaId, ms],
    );

  /** Lote de posiciones firmado con una llave de trayecto: `viajes/:id` (conductor) o `reservas/:id` (pasajero). */
  const posiciones = (
    token: string,
    ruta: string,
    l: LlaveTrayecto,
    puntos: object[],
  ) => {
    const cuerpo = { puntos };
    return e()
      .api()
      .post(ruta)
      .set(conToken(token))
      .set(firmarTrayecto(ruta, l, JSON.stringify(cuerpo)))
      .send(cuerpo);
  };
  const rutaConductor = (viajeId: string) =>
    `/api/v1/viajes/${viajeId}/posiciones`;
  const rutaPasajero = (reservaId: string) =>
    `/api/v1/reservas/${reservaId}/posiciones`;

  /** Un código de bajada vigente (HU-23 RN-7). */
  const codigoBajada = async (s: Escenario, l: LlaveTrayecto) =>
    (
      await desafio(s.conductor.token, s.viajeId, l, {
        tipo: 'bajada',
        posicion: posicion(),
      }).expect(201)
    ).body.nonce as string;

  const bajar = (
    p: Persona,
    reservaId: string,
    nonce: string,
    extra: object = {},
  ) => {
    const ruta = `/api/v1/reservas/${reservaId}/bajada`;
    const cuerpo = {
      nonce,
      posicion: posicion({ lat: ENCUENTRO.lat + A_10_M }),
      tokenIntegridad: INTEGRO,
      ...extra,
    };
    return e()
      .api()
      .post(ruta)
      .set(conToken(p.token))
      .set(firmar('POST', ruta, p.dispositivo, JSON.stringify(cuerpo)))
      .send(cuerpo);
  };

  /**
   * Viaje de 5 min ya abordado: llaves del conductor y del pasajero, y el abordaje movido 5 min atrás. Con `n` puntos
   * cada 15 s de cada uno, juntos (a 20 m), salvo lo que se cambie.
   */
  const enViaje = async (
    organizacionId: string,
    cuantos = 1,
    personas?: Personas,
  ) => {
    const s = await escenario(organizacionId, cuantos, personas);
    const conductor = await llaveConductor(s);
    const pasajeros: LlaveTrayecto[] = [];
    for (const p of s.pasajeros) {
      pasajeros.push(await abordarConLlave(s, p, conductor));
      await retrasarAbordaje(p.reservaId, 5 * 60_000);
    }
    return { s, conductor, pasajeros };
  };

  type Viaje = Awaited<ReturnType<typeof enViaje>>;
  /** Las dos trazas por la API, como las envían las apps (20 puntos, 5 min, a 20 m). */
  const recorrer = async (
    v: Viaje,
    i = 0,
    pasajero = traza(20, { desplazamientoM: 20 }),
    conductor = traza(20),
  ) => {
    const p = v.s.pasajeros[i];
    await posiciones(
      v.s.conductor.token,
      rutaConductor(v.s.viajeId),
      v.conductor,
      conductor,
    ).expect(202);
    await posiciones(
      p.token,
      rutaPasajero(p.reservaId),
      v.pasajeros[i],
      pasajero,
    ).expect(202);
  };

  /** HU-24: viaje completo hasta la bajada verificada de cada pasajero; el pago queda en la cola. */
  const verificado = async (
    organizacionId: string,
    cuantos = 1,
    personas?: Personas,
  ) => {
    const v = await enViaje(organizacionId, cuantos, personas);
    for (const [i, p] of v.s.pasajeros.entries()) {
      await recorrer(v, i);
      await bajar(p, p.reservaId, await codigoBajada(v.s, v.conductor)).expect(
        200,
      );
    }
    return v;
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
    abordarConLlave,
    retrasarAbordaje,
    posiciones,
    rutaConductor,
    rutaPasajero,
    codigoBajada,
    bajar,
    enViaje,
    recorrer,
    verificado,
    pruebas,
    estadoReserva,
    estadoViaje,
  };
}
