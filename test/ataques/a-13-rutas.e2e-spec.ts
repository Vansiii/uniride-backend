import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { rutasRegistradas, type RutaRegistrada } from './catalogo-rutas.js';

/**
 * Rutas de módulos con datos de organización que NO llevan `OrganizacionGuard`, cada una con su motivo.
 * Una ruta nueva en estos módulos sin el guard (ni motivo aquí) hace fallar la prueba (PB-05 CA-7).
 */
const SIN_ORGANIZACION: Record<string, string> = {
  'POST /api/v1/membresias':
    'HU-07: pedir ser miembro de otra organización; la persona aún no tiene membresía en ella',
  'POST /api/v1/membresias/confirmar':
    'HU-07: confirma la solicitud con el código; la membresía todavía no existe',
  'GET /api/v1/viajes/mis-viajes':
    'de la persona en todas sus organizaciones; siempre filtrado por conductorId del token',
  'GET /api/v1/reservas/mias':
    'de la persona en todas sus organizaciones; siempre filtrado por pasajeroId del token',
};

/** Módulos donde cada dato pertenece a una organización. */
const CON_DATOS_DE_ORGANIZACION =
  /^\/api\/v1\/(viajes|reservas|presencia|membresias|organizaciones)(\/|$)/;

describe('PB-05 CA-7 · A-13 · catálogo de rutas con datos de organización (e2e)', () => {
  let e: Entorno;
  let rutas: RutaRegistrada[];

  beforeAll(async () => {
    e = await prepararEntorno();
    // El metadato de ruta de la clase aparece sin método HTTP: no es una ruta.
    rutas = rutasRegistradas(e.app).filter((r) => r.metodo !== undefined);
  });
  afterAll(async () => {
    await e.cerrar();
  });

  it('A-13: toda ruta con datos de organización exige membresía aprobada o tiene su excepción justificada', () => {
    const candidatas = rutas.filter((r) =>
      CON_DATOS_DE_ORGANIZACION.test(r.ruta),
    );
    expect(candidatas.length).toBeGreaterThan(20);
    const sinGuard = candidatas
      .filter((r) => !r.conOrganizacion && !(r.clave in SIN_ORGANIZACION))
      .map((r) => r.clave);
    expect(sinGuard).toEqual([]);
  });

  it('A-13: las excepciones justificadas existen de verdad (no queda ninguna obsoleta)', () => {
    const claves = rutas.map((r) => r.clave);
    for (const clave of Object.keys(SIN_ORGANIZACION))
      expect(claves).toContain(clave);
  });
});
