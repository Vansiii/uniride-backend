import { generateKeyPairSync } from 'node:crypto';
import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { firmar } from '../billetera/ayudas-billetera.js';
import { ayudasPresencia, posicion } from '../presencia/ayudas-presencia.js';

/** HU-22 CA-8 · A-04, A-08: firmas del conductor y del pasajero alteradas, ajenas o de un teléfono inactivo. */
describe('A-08 · firmas del abordaje (e2e)', () => {
  let e: Entorno;
  const h = ayudasPresencia(() => e);
  let org: string;

  beforeAll(async () => {
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno();
    org = (await h.r.v.organizacion('Atq A08 Abordaje')).id;
  });
  beforeEach(() => h.r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  const otraLlave = () =>
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  describe('código del conductor', () => {
    it('cuerpo alterado después de firmar (otra posición): 401', async () => {
      const s = await h.escenario(org);
      const l = await h.llaveConductor(s);
      const ruta = `/api/v1/viajes/${s.viajeId}/desafios`;
      const firmado = { tipo: 'abordaje', posicion: posicion() };
      const enviado = { tipo: 'abordaje', posicion: posicion({ lat: -17.7 }) };
      const res = await e
        .api()
        .post(ruta)
        .set(h.r.b.conToken(s.conductor.token))
        .set(h.firmarTrayecto(ruta, l, JSON.stringify(firmado)))
        .send(enviado)
        .expect(401);
      expect(res.body.codigo).toBe('FIRMA_TRAYECTO_INVALIDA');
    });

    it('firmado con una llave que no es la registrada: 401', async () => {
      const s = await h.escenario(org);
      const l = await h.llaveConductor(s);
      await h
        .desafio(s.conductor.token, s.viajeId, { id: l.id, llave: otraLlave() })
        .expect(401);
    });

    it('la llave de trayecto de otro conductor, aun firmando bien, no sirve con otra sesión: 401', async () => {
      const s = await h.escenario(org);
      const ajena = await h.llaveConductor(await h.escenario(org));
      await h.desafio(s.conductor.token, s.viajeId, ajena).expect(401);
    });

    it('la llave de otro viaje del mismo conductor no emite códigos de este: 401', async () => {
      const s = await h.escenario(org);
      const l = await h.llaveConductor(s);
      const otroViaje = await h.r.publicar(s.conductor, {
        fechaHoraSalida: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      });
      await h.desafio(s.conductor.token, otroViaje, l).expect(401);
    });

    it('la llave de trayecto de un pasajero no emite códigos: 401', async () => {
      const s = await h.escenario(org, 2);
      const [p1] = s.pasajeros;
      const llave = otraLlave();
      const pemPasajero = llave.publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString();
      await h
        .abordar(
          p1,
          p1.reservaId,
          await h.codigo(s, await h.llaveConductor(s)),
          {
            llavePublicaTrayectoPem: pemPasajero,
          },
        )
        .expect(200);
      const { rows } = await e.bd.query(
        `SELECT id FROM llaves_trayecto WHERE usuario_id = $1`,
        [p1.id],
      );
      await h
        .desafio(p1.token, s.viajeId, { id: rows[0].id, llave })
        .expect(401);
    });

    it('HU-10 CA-9: si el teléfono se desactiva (revinculación), su llave de trayecto deja de valer', async () => {
      const s = await h.escenario(org);
      const l = await h.llaveConductor(s);
      await e.bd.query(
        `UPDATE dispositivos SET activo = false, desactivado_en = now() WHERE id = $1`,
        [s.conductor.dispositivo.id],
      );
      await h.desafio(s.conductor.token, s.viajeId, l).expect(401);
    });

    it('sin cabeceras de firma: 401', async () => {
      const s = await h.escenario(org);
      await e
        .api()
        .post(`/api/v1/viajes/${s.viajeId}/desafios`)
        .set(h.r.b.conToken(s.conductor.token))
        .send({ tipo: 'abordaje', posicion: posicion() })
        .expect(401);
    });

    it('registrar la llave sin la firma biométrica del teléfono: 401', async () => {
      const s = await h.escenario(org);
      const ruta = `/api/v1/viajes/${s.viajeId}/llave-trayecto`;
      const cuerpo = {
        llavePublicaPem: 'x',
        tokenIntegridad: 'simulado:integro',
      };
      await e
        .api()
        .post(ruta)
        .set(h.r.b.conToken(s.conductor.token))
        .set(
          firmar(
            'POST',
            ruta,
            { id: s.conductor.dispositivo.id, llave: otraLlave() },
            JSON.stringify(cuerpo),
          ),
        )
        .send(cuerpo)
        .expect(401);
    });
  });

  describe('escaneo del pasajero', () => {
    it('sin la firma biométrica válida del pasajero (otra llave): 401 y el código no se gasta', async () => {
      const s = await h.escenario(org);
      const p = s.pasajeros[0];
      const nonce = await h.codigo(s, await h.llaveConductor(s));
      const ruta = `/api/v1/reservas/${p.reservaId}/abordaje`;
      const cuerpo = {
        nonce,
        posicion: posicion(),
        tokenIntegridad: 'simulado:integro',
        llavePublicaTrayectoPem: 'x',
      };
      await e
        .api()
        .post(ruta)
        .set(h.r.b.conToken(p.token))
        .set(
          firmar(
            'POST',
            ruta,
            { id: p.dispositivo.id, llave: otraLlave() },
            JSON.stringify(cuerpo),
          ),
        )
        .send(cuerpo)
        .expect(401);
      await h.abordar(p, p.reservaId, nonce).expect(200);
    });

    it('el estado no se fija desde el cliente: un campo `estado` da 400', async () => {
      const s = await h.escenario(org);
      const p = s.pasajeros[0];
      const nonce = await h.codigo(s, await h.llaveConductor(s));
      const res = await h
        .abordar(p, p.reservaId, nonce, { estado: 'abordada' })
        .expect(400);
      expect(res.body.codigo).toBe('VALIDACION_FALLIDA');
      expect(await h.estadoReserva(p.reservaId)).toBe('confirmada');
    });

    it('una llave de trayecto que no es EC P-256: 400 sin gastar el código', async () => {
      const s = await h.escenario(org);
      const p = s.pasajeros[0];
      const nonce = await h.codigo(s, await h.llaveConductor(s));
      const res = await h
        .abordar(p, p.reservaId, nonce, {
          llavePublicaTrayectoPem: 'no es una llave',
        })
        .expect(400);
      expect(res.body.codigo).toBe('LLAVE_INVALIDA');
      await h.abordar(p, p.reservaId, nonce).expect(200);
    });
  });
});
