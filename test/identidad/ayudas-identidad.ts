import type { Almacen } from '../../src/comun/almacenamiento.service.js';
import { AlmacenamientoService } from '../../src/comun/almacenamiento.service.js';
import { MotorFacialSimulado } from '../../src/comun/motor-facial-simulado.js';
import { RekognitionService } from '../../src/comun/rekognition.service.js';
import { DOMINIO, type Entorno } from '../ayudas-organizaciones.js';

/** S3 simulado. Sus errores llevan la clave a propósito: no debe llegar a logs ni respuestas. */
export class AlmacenFalso implements Almacen {
  archivos = new Map<string, { contenido: Buffer; tipo: string }>();
  fallarSubida = false;
  demoraMs = 0;

  async subir(clave: string, contenido: Buffer, tipo: string) {
    await new Promise((listo) => setTimeout(listo, this.demoraMs));
    if (this.fallarSubida) throw new Error(`S3 caído al subir ${clave}`);
    this.archivos.set(clave, { contenido, tipo });
  }

  async borrar(clave: string) {
    this.archivos.delete(clave);
  }
}

/** El motor simulado (ver sus convenciones) con contadores de llamadas y una falla activable. */
export class MotorControlable extends MotorFacialSimulado {
  llamadas = { liveness: 0, comparar: 0, buscar: 0, indexar: 0 };
  fallar = false;

  override async obtenerResultadoLiveness(sesionId: string) {
    this.llamadas.liveness++;
    this.caer(sesionId);
    return super.obtenerResultadoLiveness(sesionId);
  }
  override async compararRostros(referencia: Buffer, carnet: Buffer) {
    this.llamadas.comparar++;
    this.caer(carnet.toString('latin1'));
    return super.compararRostros(referencia, carnet);
  }
  override async buscarRostroDuplicado(imagen: Buffer, usuarioId: string) {
    this.llamadas.buscar++;
    this.caer(usuarioId);
    return super.buscarRostroDuplicado(imagen, usuarioId);
  }
  override async indexarRostro(imagen: Buffer, usuarioId: string) {
    this.llamadas.indexar++;
    this.caer(usuarioId);
    return super.indexarRostro(imagen, usuarioId);
  }
  override async crearSesionLiveness() {
    this.caer('sesion');
    return super.crearSesionLiveness();
  }
  /** El error del motor lleva datos sensibles a propósito: no debe llegar a logs ni respuestas. */
  private caer(dato: string) {
    if (this.fallar) throw new Error(`Rekognition caído con ${dato}`);
  }
}

export const MARCA = 'CONTENIDO-PRIVADO-DEL-CARNET';
/** JPEG falso con el rostro `ROSTRO:<id>` que entiende el motor simulado. */
export const carnet = (rostro = 'generico', extra = '') =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from(`ROSTRO:${rostro} ${MARCA} ${extra}`),
  ]);

export interface Persona {
  id: string;
  token: string;
  correo: string;
  /** Carnet propio, distinto en cada persona (el documento es único en toda la plataforma). */
  numero: string;
}

/** Cliente de prueba de los endpoints de identidad, con motor y almacén falsos reiniciados por prueba. */
export function ayudasIdentidad(e: () => Entorno) {
  let n = 0;
  const preparar = () => {
    const motor = new MotorControlable();
    const almacen = new AlmacenFalso();
    e().app.get(RekognitionService, { strict: false }).motor = motor;
    e().app.get(AlmacenamientoService, { strict: false }).almacen = almacen;
    return { motor, almacen };
  };
  const persona = async (): Promise<Persona> => {
    const correo = `identidad${++n}${DOMINIO}`;
    const id = await e().crearUsuario(correo);
    return {
      id,
      correo,
      numero: `${2000000 + n}-1A`,
      token: await e().iniciar(correo),
    };
  };
  const conToken = (t: string) => ({ Authorization: `Bearer ${t}` });
  const sesion = async (p: Persona, sufijo = '') => {
    const r = await e()
      .api()
      .post('/api/v1/identidad/liveness-sesion')
      .set(conToken(p.token))
      .expect(201);
    return `${r.body.sesionId}${sufijo}`;
  };
  const verificar = (
    p: Persona,
    campos: Record<string, string | undefined>,
    foto: { contenido: Buffer; nombre?: string } | null = {
      contenido: carnet(),
    },
  ) => {
    let r = e()
      .api()
      .post('/api/v1/identidad/verificar')
      .set(conToken(p.token));
    for (const [campo, valor] of Object.entries(campos))
      if (valor !== undefined) r = r.field(campo, valor);
    if (foto)
      r = r.attach('fotoCarnet', foto.contenido, {
        filename: foto.nombre ?? 'carnet.jpg',
        contentType: 'image/jpeg',
      });
    return r;
  };
  /** Un intento completo y válido salvo lo que se cambie: sesión nueva y carnet del mismo rostro. */
  const intento = async (
    p: Persona,
    o: {
      rostro?: string;
      numero?: string;
      foto?: Buffer | null;
      sesionSufijo?: string;
      consentimiento?: string;
    } = {},
  ) => {
    const respuesta = await verificar(
      p,
      {
        numeroDocumento: o.numero ?? p.numero,
        aceptaConsentimiento: o.consentimiento ?? 'true',
        sesionId: await sesion(
          p,
          o.sesionSufijo ?? `~${o.rostro ?? 'generico'}`,
        ),
      },
      o.foto === null
        ? null
        : { contenido: o.foto ?? carnet(o.rostro ?? 'generico') },
    );
    // Como `supertest`, pero sobre la respuesta ya recibida (la sesión se pide antes del envío).
    return Object.assign(respuesta, {
      expect(estado: number) {
        expect(respuesta.status, JSON.stringify(respuesta.body)).toBe(estado);
        return respuesta;
      },
    });
  };
  const estado = (p: Persona) =>
    e().api().get('/api/v1/identidad/estado').set(conToken(p.token));
  const fila = async (usuarioId: string) =>
    (
      await e().bd.query(`SELECT * FROM identidades WHERE usuario_id = $1`, [
        usuarioId,
      ])
    ).rows[0];
  const auditoriasDe = async (actorId: string) =>
    (
      await e().bd.query(
        `SELECT * FROM registros_auditoria WHERE accion = 'identidad.verificacion' AND actor_id = $1 ORDER BY creado_en`,
        [actorId],
      )
    ).rows;
  return {
    preparar,
    persona,
    conToken,
    sesion,
    verificar,
    intento,
    estado,
    fila,
    auditoriasDe,
  };
}
