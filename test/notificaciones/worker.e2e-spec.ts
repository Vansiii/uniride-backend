import {
  alta,
  DOMINIO,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';

describe('Worker de correos (e2e)', () => {
  let e: Entorno;
  let correo: string;
  const fila = async () =>
    (
      await e.bd.query(
        `SELECT estado, intentos, datos FROM correos_salientes WHERE destinatario = $1`,
        [correo],
      )
    ).rows[0];
  const vencer = () =>
    e.bd.query(
      `UPDATE correos_salientes SET proximo_intento_en = now() WHERE destinatario = $1`,
      [correo],
    );

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    const token = await e.iniciar(`super${DOMINIO}`);
    const cuerpo = alta('Worker');
    correo = cuerpo.adminCorreo;
    await e
      .api()
      .post('/api/v1/admin/organizaciones')
      .set('Authorization', `Bearer ${token}`)
      .send(cuerpo)
      .expect(201);
  });
  afterAll(() => e.cerrar());

  it('un fallo reintenta y tras 5 intentos queda fallido sin perder el correo', async () => {
    e.correos.enviador = {
      enviar: async () => {
        throw new Error('SES caído');
      },
    };
    for (let intento = 1; intento <= 5; intento++) {
      expect(await e.correos.procesarPendientes()).toBe(0);
      const f = await fila();
      expect(f.intentos).toBe(intento);
      expect(f.estado).toBe(intento === 5 ? 'fallido' : 'pendiente');
      expect(f.datos.enlace).toBeTruthy();
      await vencer();
    }
    // Un correo fallido ya no se vuelve a tomar.
    expect(await e.correos.procesarPendientes()).toBe(0);
  });

  it('un correo pendiente se envía una vez y se borra el enlace con el token', async () => {
    await e.bd.query(
      `UPDATE correos_salientes SET estado = 'pendiente', intentos = 0, proximo_intento_en = now() WHERE destinatario = $1`,
      [correo],
    );
    const enviados: string[] = [];
    e.correos.enviador = {
      enviar: async (para, c) => {
        enviados.push(`${para}|${c.asunto}`);
      },
    };
    expect(await e.correos.procesarPendientes()).toBe(1);
    expect(await e.correos.procesarPendientes()).toBe(0);
    expect(enviados).toEqual([
      `${correo}|Te invitaron a administrar HU01 Worker en UniRide`,
    ]);
    const f = await fila();
    expect(f.estado).toBe('enviado');
    expect(f.datos).toEqual({});
  });

  it('un correo con espera creciente aún vigente no se toma', async () => {
    await e.bd.query(
      `UPDATE correos_salientes SET estado = 'pendiente', proximo_intento_en = now() + interval '1 hour' WHERE destinatario = $1`,
      [correo],
    );
    expect(await e.correos.procesarPendientes()).toBe(0);
  });
});
