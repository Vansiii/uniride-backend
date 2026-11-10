import { TEXTO_ACCION_SENSIBLE } from '../../src/comun/firma-dispositivo.guard.js';
import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import {
  CATALOGO,
  rutasRegistradas,
  type RutaRegistrada,
} from './catalogo-rutas.js';

/** Las que ya existen: si una cambia de ruta sin actualizar el catálogo, esta prueba lo dice. */
const CONSTRUIDAS = [
  'POST /api/v1/billetera',
  'POST /api/v1/billetera/recargas/:id/confirmar',
  'POST /api/v1/viajes',
];

/** Escrituras de estos módulos que NO piden biometría, cada una con su motivo (RN-2). */
const SIN_BIOMETRIA: Record<string, string> = {
  'POST /api/v1/billetera/recargas':
    'crea una orden pendiente: el dinero solo se mueve al confirmarla, que sí pide la huella',
};

/** Donde viven las acciones de dinero y de viaje; una escritura nueva aquí debe estar en el catálogo o justificada. */
const MODULOS_DE_DINERO_Y_VIAJE =
  /^\/api\/v1\/(billetera|viajes|reservas|presencia)(\/|$)/;
const ESCRITURA = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

describe('HU-29 CA-7, CA-4 y A-11 · catálogo de acciones sensibles (e2e)', () => {
  let e: Entorno;
  let rutas: RutaRegistrada[];

  beforeAll(async () => {
    e = await prepararEntorno();
    rutas = rutasRegistradas(e.app);
  });
  afterAll(async () => {
    await e.cerrar();
  });

  it('lee las rutas de verdad (si devolviera pocas, las demás pruebas pasarían en vacío)', () => {
    expect(rutas.length).toBeGreaterThan(30);
    for (const clave of CONSTRUIDAS)
      expect(rutas.map((r) => r.clave)).toContain(clave);
  });

  it('CA-7: cada acción del catálogo que existe exige la firma biométrica con su nombre', () => {
    const delCatalogo = rutas.filter((r) => r.clave in CATALOGO);
    expect(delCatalogo.length).toBeGreaterThanOrEqual(CONSTRUIDAS.length);
    for (const r of delCatalogo)
      expect({
        ruta: r.clave,
        accion: r.accionSensible,
        firma: r.conFirma,
      }).toEqual({ ruta: r.clave, accion: CATALOGO[r.clave], firma: true });
  });

  it('CA-7: una escritura de billetera, viajes, reservas o presencia sin firma ni motivo hace fallar', () => {
    const sueltas = rutas
      .filter(
        (r) =>
          ESCRITURA.has(r.metodo) &&
          MODULOS_DE_DINERO_Y_VIAJE.test(r.ruta) &&
          !(r.clave in CATALOGO) &&
          !(r.clave in SIN_BIOMETRIA),
      )
      .map((r) => r.clave);
    expect(sueltas).toEqual([]);
  });

  it('toda ruta marcada como sensible está en el catálogo y lleva el guard de firma', () => {
    for (const r of rutas.filter((x) => x.accionSensible)) {
      expect(CATALOGO[r.clave]).toBe(r.accionSensible);
      expect(r.conFirma).toBe(true);
    }
  });

  it('CA-4 / A-11: ninguna acción sensible tiene otra ruta sin firma (la voz no tiene atajo)', () => {
    for (const nombre of Object.values(CATALOGO)) {
      const suyas = rutas.filter((r) => r.accionSensible === nombre);
      expect(suyas.length).toBeLessThanOrEqual(1);
    }
    expect(rutas.filter((r) => /(^|\/)(voz|comando)/i.test(r.ruta))).toEqual(
      [],
    );
  });

  it('Swagger dice en cada acción sensible que requiere la firma biométrica', async () => {
    const { body } = await e.api().get('/api/docs-json').expect(200);
    for (const clave of CONSTRUIDAS) {
      const [metodo, ruta] = clave.split(' ');
      const operacion =
        body.paths[ruta.replace(/:(\w+)/g, '{$1}')][metodo.toLowerCase()];
      expect(operacion.description).toContain(TEXTO_ACCION_SENSIBLE);
    }
  });
});
