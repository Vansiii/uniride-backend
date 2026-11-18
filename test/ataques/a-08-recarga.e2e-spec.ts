import { sign } from 'node:crypto';
import {
  DOMINIO,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import {
  ayudasBilletera,
  firmar,
  RUTA_RECARGAS,
  type CadenaControlable,
} from '../billetera/ayudas-billetera.js';

/**
 * A-08 (llamar a la API sin la app) y A-11 (mover dinero por voz): confirmar una recarga exige la firma del dispositivo
 * vinculado, que pide la huella. Sin esa firma nada autoriza, aunque la sesión sea válida.
 */
describe('A-08 y A-11 · confirmar una recarga sin firma de dispositivo (e2e)', () => {
  let e: Entorno;
  let cadena: CadenaControlable;
  const b = ayudasBilletera(() => e);
  let n = 0;

  beforeAll(async () => {
    e = await prepararEntorno();
  });
  beforeEach(async () => {
    cadena = b.preparar();
    await b.vaciarCola();
  });
  afterAll(async () => {
    await e.cerrar();
  });

  const preparar = async () => {
    const u = await b.recargador(`a08${++n}${DOMINIO}`);
    const { body } = await b.crearRecarga(u.token).expect(201);
    const ruta = `${RUTA_RECARGAS}/${body.ordenId}/confirmar`;
    return { u, ruta, id: body.ordenId as string };
  };
  const sinEfecto = async (id: string) => {
    expect((await b.filaOrden(id)).estado).toBe('pendiente');
    expect(await b.filasDeOrden(id)).toEqual([]);
    await b.worker().procesarPendientes();
    expect(cadena.acunaciones).toBe(0);
  };

  it('sin firma: 401 FIRMA_DISPOSITIVO_INVALIDA, como un comando de voz sin interacción física', async () => {
    const { u, ruta, id } = await preparar();
    const r = await e.api().post(ruta).set(b.conToken(u.token)).expect(401);
    expect(r.body.codigo).toBe('FIRMA_DISPOSITIVO_INVALIDA');
    await sinEfecto(id);
  });

  it('sin sesión: 401', async () => {
    const { u, ruta, id } = await preparar();
    await e
      .api()
      .post(ruta)
      .set(firmar('POST', ruta, u.dispositivo))
      .expect(401);
    await sinEfecto(id);
  });

  it('firma de otra llave con el id del dispositivo vinculado: 401', async () => {
    const { u, ruta, id } = await preparar();
    const otra = await b.recargador(`a08otra${++n}${DOMINIO}`);
    const cabeceras = firmar('POST', ruta, otra.dispositivo);
    await e
      .api()
      .post(ruta)
      .set(b.conToken(u.token))
      .set({ ...cabeceras, 'X-Dispositivo-Id': u.dispositivo.id })
      .expect(401);
    await sinEfecto(id);
  });

  it('dispositivo de otra persona: 401', async () => {
    const { u, ruta, id } = await preparar();
    const otra = await b.recargador(`a08otra${++n}${DOMINIO}`);
    await e
      .api()
      .post(ruta)
      .set(b.conToken(u.token))
      .set(firmar('POST', ruta, otra.dispositivo))
      .expect(401);
    await sinEfecto(id);
  });

  it('firma de otra ruta: 401', async () => {
    const { u, ruta, id } = await preparar();
    await e
      .api()
      .post(ruta)
      .set(b.conToken(u.token))
      .set(firmar('POST', `${ruta}/otra`, u.dispositivo))
      .expect(401);
    await sinEfecto(id);
  });

  it('firma basura: 401', async () => {
    const { u, ruta, id } = await preparar();
    await e
      .api()
      .post(ruta)
      .set(b.conToken(u.token))
      .set({
        ...firmar('POST', ruta, u.dispositivo),
        'X-Firma': sign(
          'sha256',
          Buffer.from('otro mensaje'),
          u.dispositivo.llave.privateKey,
        ).toString('base64'),
      })
      .expect(401);
    await sinEfecto(id);
  });

  it('repetir una petición firmada capturada no pasa del nonce', async () => {
    const { u, ruta, id } = await preparar();
    const cabeceras = firmar('POST', ruta, u.dispositivo);
    await e
      .api()
      .post(ruta)
      .set(b.conToken(u.token))
      .set(cabeceras)
      .expect(202);
    await e
      .api()
      .post(ruta)
      .set(b.conToken(u.token))
      .set(cabeceras)
      .expect(401);
    expect(await b.filasDeOrden(id)).toHaveLength(1);
  });
});
