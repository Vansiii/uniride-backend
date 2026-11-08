import {
  DOMINIO,
  miembroCon,
  organizacionConAdmin,
  type Entorno,
} from '../ayudas-organizaciones.js';
import {
  ayudasBilletera,
  firmar,
  type Dispositivo,
} from '../billetera/ayudas-billetera.js';

export const RUTA_VIAJES = '/api/v1/viajes';
export const HORA_MS = 3_600_000;
export const enMs = (ms: number) => new Date(Date.now() + ms).toISOString();

export const cuerpoViaje = (extra: object = {}) => ({
  origenNombre: 'Plaza 24 de Septiembre',
  origenLat: -17.783327,
  origenLng: -63.182129,
  destinoNombre: 'UAGRM, Módulos',
  destinoLat: -17.775,
  destinoLng: -63.195,
  fechaHoraSalida: enMs(3 * HORA_MS),
  cuposTotales: 3,
  precioPorAsiento: 10.5,
  ...extra,
});

export interface Conductor {
  id: string;
  token: string;
  dispositivo: Dispositivo;
}

export function ayudasViajes(e: () => Entorno) {
  const b = ayudasBilletera(e);
  let n = 0;

  const organizacion = async (sufijo: string) => {
    const correo = `super.viajes${DOMINIO}`;
    const { rows } = await e().bd.query(
      `SELECT 1 FROM usuarios WHERE correo = $1`,
      [correo],
    );
    if (!rows.length) await e().crearUsuario(correo, 'super_admin');
    return organizacionConAdmin(e(), await e().iniciar(correo), sufijo);
  };

  /** Miembro aprobado; cada requisito de CA-1 se apaga por separado para probar CA-6 y CA-7. */
  const conductor = async (
    organizacionId: string,
    o: {
      identidad?: string | null;
      vehiculo?: boolean;
      capacidad?: number;
      membresia?: 'aprobada' | 'pendiente';
    } = {},
  ): Promise<Conductor> => {
    const correo = `conductor${++n}${DOMINIO}`;
    const token = await miembroCon(
      e(),
      organizacionId,
      correo,
      o.membresia ?? 'aprobada',
    );
    const { rows } = await e().bd.query(
      `SELECT id FROM usuarios WHERE correo = $1`,
      [correo],
    );
    const id = rows[0].id as string;
    const identidad = o.identidad === undefined ? 'verificada' : o.identidad;
    if (identidad)
      await e().bd.query(
        `INSERT INTO identidades (usuario_id, estado, consentimiento_en, documento_hash, verificado_en)
         VALUES ($1, $2, now(), $3, now())`,
        [id, identidad, `hash-${correo}`],
      );
    if (o.vehiculo !== false)
      await e().bd.query(
        `INSERT INTO vehiculos (propietario_id, placa, marca, modelo, color, capacidad, clave_s3_foto, consentimiento_foto_en)
         VALUES ($1, $2, 'Toyota', 'Corolla', 'Blanco', $3, 'clave-secreta-s3', now())`,
        [id, `${1000 + n}VJE`, o.capacidad ?? 4],
      );
    return { id, token, dispositivo: await b.vincular(id) };
  };

  /** Publica con firma válida del cuerpo exacto que se envía. */
  const publicar = (c: Conductor, cuerpo: object = cuerpoViaje()) =>
    e()
      .api()
      .post(RUTA_VIAJES)
      .set(b.conToken(c.token))
      .set(firmar('POST', RUTA_VIAJES, c.dispositivo, JSON.stringify(cuerpo)))
      .send(cuerpo);

  const misViajes = (token: string) =>
    e().api().get(`${RUTA_VIAJES}/mis-viajes`).set(b.conToken(token));
  const detalle = (token: string, id: string) =>
    e().api().get(`${RUTA_VIAJES}/${id}`).set(b.conToken(token));

  const filas = async (conductorId: string) =>
    (
      await e().bd.query(`SELECT * FROM viajes WHERE conductor_id = $1`, [
        conductorId,
      ])
    ).rows;

  /** El conductor también entra a `organizacionId`, que pasa a ser la activa en su nueva sesión. */
  const cambiarOrganizacion = async (c: Conductor, organizacionId: string) => {
    await e().bd.query(
      `INSERT INTO membresias (organizacion_id, usuario_id, rol, estado) VALUES ($1, $2, 'miembro', 'aprobada')
       ON CONFLICT (organizacion_id, usuario_id) DO NOTHING`,
      [organizacionId, c.id],
    );
    await e().bd.query(
      `UPDATE usuarios SET ultima_organizacion_id = $1 WHERE id = $2`,
      [organizacionId, c.id],
    );
    const { rows } = await e().bd.query(
      `SELECT correo FROM usuarios WHERE id = $1`,
      [c.id],
    );
    return { ...c, token: await e().iniciar(rows[0].correo) };
  };

  return {
    organizacion,
    conductor,
    publicar,
    misViajes,
    detalle,
    filas,
    cambiarOrganizacion,
    conToken: b.conToken,
  };
}
