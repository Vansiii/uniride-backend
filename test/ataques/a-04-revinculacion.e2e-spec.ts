import { generateKeyPairSync, sign } from 'node:crypto';
import { Body, Controller, HttpCode, Module, Post } from '@nestjs/common';
import {
  FirmaDispositivoModule,
  mensajeCanonico,
  RequiereFirmaDispositivo,
} from '../../src/comun/firma-dispositivo.guard.js';
import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasIdentidad } from '../identidad/ayudas-identidad.js';

@Controller('prueba-firma-a04')
class PruebaFirmaController {
  @Post('eco')
  @HttpCode(200)
  @RequiereFirmaDispositivo()
  eco(@Body() cuerpo: object) {
    return { recibido: cuerpo };
  }
}

@Module({
  imports: [FirmaDispositivoModule],
  controllers: [PruebaFirmaController],
})
class PruebaFirmaModule {}

const par = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pemPublico = (k: ReturnType<typeof par>) =>
  k.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const INTEGRO = 'simulado:integro';

let nonce = 0;
function firmar(
  llave: ReturnType<typeof par>,
  dispositivoId: string,
  o: { ruta: string; cuerpo: string; marca?: number; nonce?: string },
) {
  const marca = String(o.marca ?? Date.now());
  const n = o.nonce ?? `nonce-a04-${Date.now()}-${++nonce}`;
  const mensaje = mensajeCanonico(
    'POST',
    o.ruta,
    marca,
    n,
    Buffer.from(o.cuerpo),
  );
  return {
    'X-Dispositivo-Id': dispositivoId,
    'X-Timestamp': marca,
    'X-Nonce': n,
    'X-Firma': sign('sha256', Buffer.from(mensaje), llave.privateKey).toString(
      'base64',
    ),
  };
}

describe('A-04 · Revinculación de dispositivo y suplantación (e2e)', () => {
  let e: Entorno;
  const a = ayudasIdentidad(() => e);

  beforeAll(async () => {
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno([PruebaFirmaModule]);
  });

  beforeEach(() => {
    a.preparar();
  });

  afterAll(async () => {
    await e.cerrar();
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const vincular = async (token: string, llave = par()) => {
    const des = (
      await e
        .api()
        .post('/api/v1/dispositivos/desafio-atestacion')
        .set(auth(token))
        .expect(201)
    ).body.desafio;

    const r = await e
      .api()
      .post('/api/v1/dispositivos/vincular')
      .set(auth(token))
      .send({
        desafio: des,
        tokenIntegridad: INTEGRO,
        llavePublicaPem: pemPublico(llave),
        modelo: 'Pixel 7',
      })
      .expect(200);

    return { id: r.body.id as string, llave };
  };

  const pedirDesafioRevinculacion = (token: string) =>
    e.api().post('/api/v1/dispositivos/revinculacion').set(auth(token));

  const revincular = (token: string, cuerpo: object) =>
    e
      .api()
      .post('/api/v1/dispositivos/revincular')
      .set(auth(token))
      .send(cuerpo);

  it('CA-3 / A-04: peticion firmada con la llave del telefono anterior es rechazada con 401 tras revincular', async () => {
    const p = await a.persona();
    const d1 = await vincular(p.token);

    // Endpoint sensible funciona con el teléfono 1
    const ruta = '/api/v1/prueba-firma-a04/eco';
    const cuerpo = JSON.stringify({ mensaje: 'hola' });
    await e
      .api()
      .post(ruta)
      .set(auth(p.token))
      .set(firmar(d1.llave, d1.id, { ruta, cuerpo }))
      .send({ mensaje: 'hola' })
      .expect(200);

    // Usuario revincula a teléfono 2
    const des = (await pedirDesafioRevinculacion(p.token).expect(201)).body
      .desafio;
    const d2Llave = par();
    const rRev = await revincular(p.token, {
      desafio: des,
      tokenIntegridad: INTEGRO,
      llavePublicaPem: pemPublico(d2Llave),
      modelo: 'Pixel 8',
    }).expect(201);

    // Petición con teléfono 2 funciona
    await e
      .api()
      .post(ruta)
      .set(auth(p.token))
      .set(firmar(d2Llave, rRev.body.id, { ruta, cuerpo }))
      .send({ mensaje: 'hola' })
      .expect(200);

    // ATAQUE: Alguien intenta firmar con el teléfono anterior d1
    const ataque = await e
      .api()
      .post(ruta)
      .set(auth(p.token))
      .set(firmar(d1.llave, d1.id, { ruta, cuerpo }))
      .send({ mensaje: 'hola' })
      .expect(401);

    expect(ataque.body.codigo).toBe('FIRMA_DISPOSITIVO_INVALIDA');
  });

  it('CA-4 / A-01: atacante con contraseña intenta revincular con su propio rostro o foto ajena -> rechazado y el dueño sigue vinculado', async () => {
    const dueno = await a.persona();
    await a.intento(dueno, { rostro: 'dueno-real' });
    const dDueno = await vincular(dueno.token);

    // Atacante tiene la sesión del dueño, pide desafío
    const des = (await pedirDesafioRevinculacion(dueno.token).expect(201)).body;
    expect(des.requiereIdentidad).toBe(true);

    // Atacante intenta con rostro ajeno "atacante"
    const rAtaque = await revincular(dueno.token, {
      desafio: des.desafio,
      tokenIntegridad: INTEGRO,
      llavePublicaPem: pemPublico(par()),
      modelo: 'Telefono Atacante',
      sesionLivenessId: `${des.sesionLivenessId}~atacante`,
    }).expect(422);

    expect(rAtaque.body.codigo).toBe('ROSTRO_NO_COINCIDE');

    // El teléfono del dueño sigue activo
    const disp = (
      await e.bd.query(`SELECT * FROM dispositivos WHERE id = $1`, [dDueno.id])
    ).rows[0];
    expect(disp.activo).toBe(true);
    expect(disp.desactivado_en).toBeNull();
  });

  it('CA-5 / A-02: atacante intenta usar el rostro de otra cuenta verificada para apropiarse de la cuenta -> rechazado', async () => {
    // Cuenta A (víctima)
    const victima = await a.persona();
    await a.intento(victima, { rostro: 'rostro-victima' });
    const dVictima = await vincular(victima.token);

    // Cuenta B (atacante) verificada con su propio rostro
    const atacante = await a.persona();
    await a.intento(atacante, { rostro: 'rostro-atacante' });

    // Atacante intenta revincular la cuenta de la víctima presentando el rostro de la cuenta B
    const des = (await pedirDesafioRevinculacion(victima.token).expect(201))
      .body;

    const rAtaque = await revincular(victima.token, {
      desafio: des.desafio,
      tokenIntegridad: INTEGRO,
      llavePublicaPem: pemPublico(par()),
      modelo: 'Telefono B',
      sesionLivenessId: `${des.sesionLivenessId}~rostro-atacante`,
    }).expect(422);

    expect(rAtaque.body.codigo).toBe('ROSTRO_NO_COINCIDE');

    // Teléfono de la víctima sigue vinculado e intacto
    const disp = (
      await e.bd.query(`SELECT * FROM dispositivos WHERE id = $1`, [
        dVictima.id,
      ])
    ).rows[0];
    expect(disp.activo).toBe(true);
  });
});
