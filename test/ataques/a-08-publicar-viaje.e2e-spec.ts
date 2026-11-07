import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { firmar } from '../billetera/ayudas-billetera.js';
import {
  ayudasViajes,
  cuerpoViaje,
  RUTA_VIAJES,
  type Conductor,
} from '../viajes/ayudas-viajes.js';

/** CA-7, A-08: con una sesión válida, publicar sin la firma del teléfono vinculado no crea nada. */
describe('A-08 · publicar un viaje sin la firma del teléfono (e2e)', () => {
  let e: Entorno;
  const v = ayudasViajes(() => e);
  let organizacionId: string;

  beforeAll(async () => {
    e = await prepararEntorno();
    organizacionId = (await v.organizacion('Viajes A08')).id;
  });
  afterAll(async () => {
    await e.cerrar();
  });

  const enviar = (c: Conductor, cuerpo: object) =>
    e.api().post(RUTA_VIAJES).set(v.conToken(c.token)).send(cuerpo);
  const rechazada = async (
    c: Conductor,
    r: { status: number; body: { codigo: string } },
  ) => {
    expect(r.status).toBe(401);
    expect(r.body.codigo).toBe('FIRMA_DISPOSITIVO_INVALIDA');
    expect(await v.filas(c.id)).toEqual([]);
  };

  it('sin firma: 401 FIRMA_DISPOSITIVO_INVALIDA', async () => {
    const c = await v.conductor(organizacionId);
    await rechazada(c, await enviar(c, cuerpoViaje()));
  });

  it('sin sesión: 401, aunque la firma sea válida', async () => {
    const c = await v.conductor(organizacionId);
    const cuerpo = cuerpoViaje();
    await e
      .api()
      .post(RUTA_VIAJES)
      .set(firmar('POST', RUTA_VIAJES, c.dispositivo, JSON.stringify(cuerpo)))
      .send(cuerpo)
      .expect(401);
    expect(await v.filas(c.id)).toEqual([]);
  });

  it('otro cuerpo que el firmado (subir el precio o cambiar la hora): 401', async () => {
    const c = await v.conductor(organizacionId);
    const firmado = cuerpoViaje();
    const r = await enviar(c, { ...firmado, precioPorAsiento: 20 }).set(
      firmar('POST', RUTA_VIAJES, c.dispositivo, JSON.stringify(firmado)),
    );
    await rechazada(c, r);
  });

  it('firmado con la llave de otra persona, con el id de su dispositivo: 401', async () => {
    const c = await v.conductor(organizacionId);
    const otra = await v.conductor(organizacionId);
    const cuerpo = cuerpoViaje();
    const r = await enviar(c, cuerpo).set({
      ...firmar('POST', RUTA_VIAJES, otra.dispositivo, JSON.stringify(cuerpo)),
      'X-Dispositivo-Id': c.dispositivo.id,
    });
    await rechazada(c, r);
  });

  it('dispositivo de otra persona: 401', async () => {
    const c = await v.conductor(organizacionId);
    const otra = await v.conductor(organizacionId);
    const cuerpo = cuerpoViaje();
    const r = await enviar(c, cuerpo).set(
      firmar('POST', RUTA_VIAJES, otra.dispositivo, JSON.stringify(cuerpo)),
    );
    await rechazada(c, r);
  });

  it('dispositivo desactivado: 401', async () => {
    const c = await v.conductor(organizacionId);
    await e.bd.query(`UPDATE dispositivos SET activo = false WHERE id = $1`, [
      c.dispositivo.id,
    ]);
    const cuerpo = cuerpoViaje();
    const r = await enviar(c, cuerpo).set(
      firmar('POST', RUTA_VIAJES, c.dispositivo, JSON.stringify(cuerpo)),
    );
    await rechazada(c, r);
  });

  it('firma de otra ruta: 401', async () => {
    const c = await v.conductor(organizacionId);
    const cuerpo = cuerpoViaje();
    const r = await enviar(c, cuerpo).set(
      firmar('POST', '/api/v1/otra', c.dispositivo, JSON.stringify(cuerpo)),
    );
    await rechazada(c, r);
  });

  it('repetir una publicación firmada capturada no crea otro viaje', async () => {
    const c = await v.conductor(organizacionId);
    const cuerpo = cuerpoViaje();
    const cabeceras = firmar(
      'POST',
      RUTA_VIAJES,
      c.dispositivo,
      JSON.stringify(cuerpo),
    );
    await enviar(c, cuerpo).set(cabeceras).expect(201);
    const r = await enviar(c, cuerpo).set(cabeceras).expect(401);
    expect(r.body.codigo).toBe('PETICION_EXPIRADA');
    expect(await v.filas(c.id)).toHaveLength(1);
  });

  it('las lecturas no gastan firma, pero sí exigen sesión', async () => {
    await e.api().get(`${RUTA_VIAJES}/mis-viajes`).expect(401);
    await e
      .api()
      .get(`${RUTA_VIAJES}/11111111-1111-4111-8111-111111111111`)
      .expect(401);
  });
});
