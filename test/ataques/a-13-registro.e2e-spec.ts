import { JwtService } from '@nestjs/jwt';
import {
  buzon,
  CONTRASENA,
  DOMINIO,
  organizacionConDominio,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';

describe('Ataque A-13 · HU-05 registro con otra organización (e2e)', () => {
  let e: Entorno;
  let correos: ReturnType<typeof buzon>;
  let a: Awaited<ReturnType<typeof organizacionConDominio>>;
  let b: Awaited<ReturnType<typeof organizacionConDominio>>;
  const ruta = (r: string) => `/api/v1/autenticacion/${r}`;
  const registrar = (correo: string, extra: object) =>
    e
      .api()
      .post(ruta('registro'))
      .send({
        nombreCompleto: 'Intrusa',
        correo,
        contrasena: CONTRASENA,
        aceptaTratamientoDatos: true,
        ...extra,
      });
  const membresiasDe = async (correo: string) =>
    (
      await e.bd.query(
        `SELECT m.organizacion_id, m.estado FROM membresias m JOIN usuarios u ON u.id = m.usuario_id WHERE u.correo = $1`,
        [correo],
      )
    ).rows;

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    const superToken = await e.iniciar(`super${DOMINIO}`);
    a = await organizacionConDominio(
      e,
      superToken,
      'Atq Reg A',
      'a.hu01.test',
      'manual',
    );
    b = await organizacionConDominio(
      e,
      superToken,
      'Atq Reg B',
      'b.hu01.test',
      'automatica',
    );
  }, 60_000); // dos altas con invitación y afiliación: bajo carga pasa de los 10 s por defecto
  beforeEach(() => {
    correos = buzon(e);
  });
  afterAll(() => e.cerrar());

  it('CA-8: un `organizacionId` de otra organización se ignora; la organización sale solo del dominio', async () => {
    // Correo de A (manual) que intenta caer en B (automática) para saltarse la aprobación.
    const correo = 'intrusa@a.hu01.test';
    await registrar(correo, { organizacionId: b.id }).expect(202);
    const { rows } = await e.bd.query(
      `SELECT datos->>'organizacionId' AS org FROM codigos_otp WHERE correo = $1`,
      [correo],
    );
    expect(rows).toEqual([{ org: a.id }]);

    const r = await e
      .api()
      .post(ruta('verificar-otp'))
      .send({ correo, codigo: correos.codigoPara(correo) })
      .expect(200);
    expect(r.body.estadoMembresia).toBe('pendiente');
    expect(await membresiasDe(correo)).toEqual([
      { organizacion_id: a.id, estado: 'pendiente' },
    ]);
    // El token no lleva organización activa: ni A (pendiente) ni B.
    const pago = await e.app
      .get(JwtService)
      .verifyAsync(r.body.tokenAcceso as string);
    expect(pago.org).toBeNull();
  });

  it('CA-8: al revés, un correo de B con el id de A queda en B y no en A', async () => {
    const correo = 'otra@b.hu01.test';
    await registrar(correo, { organizacionId: a.id }).expect(202);
    await e
      .api()
      .post(ruta('verificar-otp'))
      .send({ correo, codigo: correos.codigoPara(correo) })
      .expect(200);
    expect(await membresiasDe(correo)).toEqual([
      { organizacion_id: b.id, estado: 'aprobada' },
    ]);
  });

  it('otras formas de indicar la organización se rechazan sin enviar código', async () => {
    for (const extra of [
      { organizacion_id: b.id },
      { organizacion: b.id },
      { dominio: 'b.hu01.test' },
      { rol: 'admin_organizacion' },
    ]) {
      const r = await registrar('rechazo@a.hu01.test', extra).expect(400);
      expect(r.body.codigo).toBe('VALIDACION_FALLIDA');
    }
    expect(correos.enviados).toHaveLength(0);
    const r = await e
      .api()
      .post(ruta('verificar-otp'))
      .send({
        correo: 'rechazo@a.hu01.test',
        codigo: '123456',
        organizacionId: b.id,
      })
      .expect(400);
    expect(r.body.codigo).toBe('VALIDACION_FALLIDA');
  });
});
