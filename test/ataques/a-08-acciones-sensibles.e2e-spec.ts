import {
  prepararEntorno,
  DOMINIO,
  type Entorno,
} from '../ayudas-organizaciones.js';
import {
  ayudasBilletera,
  firmar,
  RUTA,
  RUTA_RECARGAS,
  type Dispositivo,
} from '../billetera/ayudas-billetera.js';
import {
  ayudasViajes,
  cuerpoViaje,
  RUTA_VIAJES,
} from '../viajes/ayudas-viajes.js';
import { rutasRegistradas } from './catalogo-rutas.js';

interface Caso {
  usuarioId: string;
  token: string;
  dispositivo: Dispositivo;
  ruta: string;
  cuerpo?: object;
  /** Respuesta de la acción hecha con la huella del dueño. */
  exito: number;
  /** Lo que la acción audita al ejecutarse (CA-3). */
  auditoria: string;
  /** Falla si la acción dejó algo. */
  sinEfecto: () => Promise<void>;
}

/**
 * HU-29 CA-3, CA-6 y A-08: con una sesión válida, ninguna acción del catálogo se ejecuta sin la firma del teléfono
 * vinculado de esa cuenta, con la firma de otro teléfono o repitiendo una firma ya usada.
 * Cada acción sensible nueva agrega aquí cómo prepararla; la última prueba falla si falta.
 */
describe('A-08 · acciones sensibles sin la firma del teléfono del dueño (e2e)', () => {
  let e: Entorno;
  const b = ayudasBilletera(() => e);
  const v = ayudasViajes(() => e);
  let organizacionId: string;
  let n = 0;

  const ACCIONES: Record<string, () => Promise<Caso>> = {
    'billetera.crear': async () => {
      const p = await b.persona(`a08s${++n}${DOMINIO}`);
      return {
        usuarioId: p.id,
        token: p.token,
        dispositivo: await b.vincular(p.id),
        ruta: RUTA,
        exito: 201,
        auditoria: 'billetera.creacion',
        sinEfecto: async () => expect(await b.filas(p.id)).toEqual([]),
      };
    },
    'recarga.confirmar': async () => {
      const u = await b.recargador(`a08s${++n}${DOMINIO}`);
      const { body } = await b.crearRecarga(u.token).expect(201);
      return {
        usuarioId: u.id,
        token: u.token,
        dispositivo: u.dispositivo,
        ruta: `${RUTA_RECARGAS}/${body.ordenId}/confirmar`,
        exito: 202,
        auditoria: 'billetera.recarga.confirmada',
        sinEfecto: async () =>
          expect(await b.filasDeOrden(body.ordenId)).toEqual([]),
      };
    },
    'viaje.publicar': async () => {
      const c = await v.conductor(organizacionId);
      return {
        usuarioId: c.id,
        token: c.token,
        dispositivo: c.dispositivo,
        ruta: RUTA_VIAJES,
        cuerpo: cuerpoViaje(),
        exito: 201,
        auditoria: 'viaje.publicacion',
        sinEfecto: async () => expect(await v.filas(c.id)).toEqual([]),
      };
    },
  };

  beforeAll(async () => {
    e = await prepararEntorno();
    organizacionId = (await v.organizacion('Acciones A08')).id;
  });
  beforeEach(async () => {
    b.preparar();
    await b.vaciarCola();
  });
  afterAll(async () => {
    await e.cerrar();
  });

  const enviar = (c: Caso, cabeceras: Record<string, string> = {}) => {
    const peticion = e
      .api()
      .post(c.ruta)
      .set(b.conToken(c.token))
      .set(cabeceras);
    return c.cuerpo ? peticion.send(c.cuerpo) : peticion;
  };
  const firma = (c: Caso, d = c.dispositivo) =>
    firmar('POST', c.ruta, d, c.cuerpo ? JSON.stringify(c.cuerpo) : '');
  const auditorias = async (actorId: string, accion: string) =>
    (
      await e.bd.query(
        `SELECT resultado, detalle FROM registros_auditoria WHERE actor_id = $1 AND accion = $2`,
        [actorId, accion],
      )
    ).rows;
  /** El guard audita el rechazo sin esperar: se da un momento a que llegue la fila. */
  const falloAuditado = async (c: Caso, accionSensible: string) => {
    for (let i = 0; i < 20; i++) {
      const filas = await auditorias(c.usuarioId, 'dispositivo.firma');
      if (filas.length) {
        expect(filas[0]).toMatchObject({
          resultado: 'fallo',
          detalle: { accionSensible },
        });
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('el rechazo no quedó en auditoría');
  };

  describe.each(Object.keys(ACCIONES))('%s', (accion) => {
    it('sin firma (un comando de voz o un script con el token): 401 y nada cambia', async () => {
      const c = await ACCIONES[accion]();
      const r = await enviar(c).expect(401);
      expect(r.body.codigo).toBe('FIRMA_DISPOSITIVO_INVALIDA');
      await c.sinEfecto();
      await falloAuditado(c, accion);
    });

    it('firmada por el teléfono de otra persona: 401 y nada cambia', async () => {
      const c = await ACCIONES[accion]();
      const otra = await b.persona(`a08otra${++n}${DOMINIO}`);
      await enviar(c, firma(c, await b.vincular(otra.id))).expect(401);
      await c.sinEfecto();
    });

    it('A-04: otra llave con el id del teléfono del dueño (no la de su huella): 401 y nada cambia', async () => {
      const c = await ACCIONES[accion]();
      const otra = await b.persona(`a08otra${++n}${DOMINIO}`);
      const ajeno = await b.vincular(otra.id);
      await enviar(c, {
        ...firma(c, ajeno),
        'X-Dispositivo-Id': c.dispositivo.id,
      }).expect(401);
      await c.sinEfecto();
    });

    it('CA-3: con la firma del dueño se ejecuta y se audita; repetir esa firma da 401', async () => {
      const c = await ACCIONES[accion]();
      const cabeceras = firma(c);
      await enviar(c, cabeceras).expect(c.exito);
      expect(await auditorias(c.usuarioId, c.auditoria)).toEqual([
        expect.objectContaining({ resultado: 'ok' }),
      ]);
      const r = await enviar(c, cabeceras).expect(401);
      expect(r.body.codigo).toBe('PETICION_EXPIRADA');
      expect(await auditorias(c.usuarioId, c.auditoria)).toHaveLength(1);
    });
  });

  it('cada acción sensible registrada tiene aquí su prueba de ataque', () => {
    const registradas = rutasRegistradas(e.app)
      .map((r) => r.accionSensible)
      .filter(Boolean);
    expect(registradas.sort()).toEqual(Object.keys(ACCIONES).sort());
  });
});
