import { generateKeyPairSync } from 'node:crypto';
import {
  DOMINIO,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import { ayudasIdentidad } from '../identidad/ayudas-identidad.js';

const par = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pemPublico = (k: ReturnType<typeof par>) =>
  k.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const INTEGRO = 'simulado:integro';

describe('HU-10 · Volver a vincular o cambiar de teléfono (e2e)', () => {
  let e: Entorno;
  const a = ayudasIdentidad(() => e);
  let n = 0;

  beforeAll(async () => {
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno();
  });

  beforeEach(() => {
    a.preparar();
  });

  afterAll(async () => {
    await e.cerrar();
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const usuarioNuevo = async (correoPrefix = 'revinculacion') => {
    const correo = `${correoPrefix}${++n}${DOMINIO}`;
    const id = await e.crearUsuario(correo);
    const token = await e.iniciar(correo);
    return { id, correo, token };
  };

  const vincularPrimero = async (token: string) => {
    const des = (
      await e
        .api()
        .post('/api/v1/dispositivos/desafio-atestacion')
        .set(auth(token))
        .expect(201)
    ).body.desafio;

    const llave = par();
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

  const dispositivosDe = async (usuarioId: string) =>
    (
      await e.bd.query(
        `SELECT * FROM dispositivos WHERE usuario_id = $1 ORDER BY vinculado_en ASC`,
        [usuarioId],
      )
    ).rows;

  const correosDe = async (destinatario: string) =>
    (
      await e.bd.query(
        `SELECT * FROM correos_salientes WHERE destinatario = $1 ORDER BY creado_en DESC`,
        [destinatario],
      )
    ).rows;

  const auditoriasDe = async (actorId: string) =>
    (
      await e.bd.query(
        `SELECT * FROM registros_auditoria WHERE accion = 'dispositivo.revinculacion' AND actor_id = $1 ORDER BY creado_en DESC`,
        [actorId],
      )
    ).rows;

  describe('CA-10 · Usuario sin identidad verificada', () => {
    it('permite revincular sin prueba facial; desactiva el anterior y activa el nuevo', async () => {
      const u = await usuarioNuevo('sin-identidad');
      const d1 = await vincularPrimero(u.token);

      const rDes = await pedirDesafioRevinculacion(u.token).expect(201);
      expect(rDes.body.requiereIdentidad).toBe(false);
      expect(rDes.body.sesionLivenessId).toBeUndefined();
      expect(rDes.body.desafio).toBeDefined();

      const llave2 = par();
      const rRev = await revincular(u.token, {
        desafio: rDes.body.desafio,
        tokenIntegridad: INTEGRO,
        llavePublicaPem: pemPublico(llave2),
        modelo: 'Galaxy S24',
      }).expect(201);

      expect(rRev.body.estado).toBe('vinculado');
      expect(rRev.body.id).toBeDefined();
      expect(rRev.body.id).not.toBe(d1.id);

      const disp = await dispositivosDe(u.id);
      expect(disp).toHaveLength(2);
      expect(disp[0].id).toBe(d1.id);
      expect(disp[0].activo).toBe(false);
      expect(disp[0].desactivado_en).not.toBeNull();

      expect(disp[1].id).toBe(rRev.body.id);
      expect(disp[1].activo).toBe(true);
      expect(disp[1].desactivado_en).toBeNull();
      expect(disp[1].modelo_dispositivo).toBe('Galaxy S24');

      // CA-8: Correo encolado
      const correos = await correosDe(u.correo);
      expect(correos.length).toBeGreaterThanOrEqual(1);
      expect(correos[0].plantilla).toBe('dispositivo_revinculado');
      expect(correos[0].datos).toMatchObject({ modelo: 'Galaxy S24' });

      // CA-12: Auditoría registrada sin datos biométricos
      const aud = await auditoriasDe(u.id);
      expect(aud.length).toBeGreaterThanOrEqual(1);
      expect(aud[0].resultado).toBe('ok');
      expect(JSON.stringify(aud[0].detalle)).not.toMatch(
        /foto|carnet|rostro|biometria/i,
      );
    });
  });

  describe('CA-2 · Usuario con identidad verificada', () => {
    it('exige prueba facial, compara con carnet verificado y reemplaza el dispositivo', async () => {
      const p = await a.persona();
      // Verificar identidad primero (HU-08)
      await a.intento(p, { rostro: 'carlos' });
      const d1 = await vincularPrimero(p.token);

      const rDes = await pedirDesafioRevinculacion(p.token).expect(201);
      expect(rDes.body.requiereIdentidad).toBe(true);
      expect(rDes.body.sesionLivenessId).toBeDefined();

      // Revincular con el mismo rostro carlos (sufijo en sesión liveness)
      const llave2 = par();
      const sesionConRostro = `${rDes.body.sesionLivenessId}~carlos`;
      const rRev = await revincular(p.token, {
        desafio: rDes.body.desafio,
        tokenIntegridad: INTEGRO,
        llavePublicaPem: pemPublico(llave2),
        modelo: 'Xiaomi 14',
        sesionLivenessId: sesionConRostro,
      }).expect(201);

      expect(rRev.body.estado).toBe('vinculado');

      const disp = await dispositivosDe(p.id);
      expect(disp).toHaveLength(2);
      expect(disp[0].id).toBe(d1.id);
      expect(disp[0].activo).toBe(false);
      expect(disp[1].activo).toBe(true);
      expect(disp[1].modelo_dispositivo).toBe('Xiaomi 14');
    });
  });

  describe('CA-7 · Bloqueo de 24 horas tras 3 intentos biométricos fallidos', () => {
    it('al 3.º fallo bloquea durante 24 h y responde 429 INTENTOS_AGOTADOS; el anterior sigue activo', async () => {
      const p = await a.persona();
      await a.intento(p, { rostro: 'elena' });
      const d1 = await vincularPrimero(p.token);

      // Intento 1: rostro ajeno (beto != elena)
      const des1 = (await pedirDesafioRevinculacion(p.token).expect(201)).body;
      await revincular(p.token, {
        desafio: des1.desafio,
        tokenIntegridad: INTEGRO,
        llavePublicaPem: pemPublico(par()),
        modelo: 'HackerPhone',
        sesionLivenessId: `${des1.sesionLivenessId}~beto`,
      }).expect(422);

      // Intento 2: rostro ajeno
      const des2 = (await pedirDesafioRevinculacion(p.token).expect(201)).body;
      await revincular(p.token, {
        desafio: des2.desafio,
        tokenIntegridad: INTEGRO,
        llavePublicaPem: pemPublico(par()),
        modelo: 'HackerPhone',
        sesionLivenessId: `${des2.sesionLivenessId}~beto`,
      }).expect(422);

      // Intento 3: tercer fallo -> 429 INTENTOS_AGOTADOS
      const des3 = (await pedirDesafioRevinculacion(p.token).expect(201)).body;
      const r3 = await revincular(p.token, {
        desafio: des3.desafio,
        tokenIntegridad: INTEGRO,
        llavePublicaPem: pemPublico(par()),
        modelo: 'HackerPhone',
        sesionLivenessId: `${des3.sesionLivenessId}~beto`,
      }).expect(429);
      expect(r3.body.codigo).toBe('INTENTOS_AGOTADOS');

      // Intento 4: pedir desafío da 429 directamente
      const r4 = await pedirDesafioRevinculacion(p.token).expect(429);
      expect(r4.body.codigo).toBe('INTENTOS_AGOTADOS');

      // El dispositivo original sigue activo
      const disp = await dispositivosDe(p.id);
      expect(disp).toHaveLength(1);
      expect(disp[0].id).toBe(d1.id);
      expect(disp[0].activo).toBe(true);
    });
  });

  describe('Concurrencia', () => {
    it('dos revinculaciones simultáneas con distintos desafíos: una gana y la otra falla sin romper integridad', async () => {
      const u = await usuarioNuevo('concurrente');
      await vincularPrimero(u.token);

      const des1 = (await pedirDesafioRevinculacion(u.token).expect(201)).body
        .desafio;
      const des2 = (await pedirDesafioRevinculacion(u.token).expect(201)).body
        .desafio;

      await Promise.allSettled([
        revincular(u.token, {
          desafio: des1,
          tokenIntegridad: INTEGRO,
          llavePublicaPem: pemPublico(par()),
          modelo: 'Telefono A',
        }),
        revincular(u.token, {
          desafio: des2,
          tokenIntegridad: INTEGRO,
          llavePublicaPem: pemPublico(par()),
          modelo: 'Telefono B',
        }),
      ]);

      // Nunca quedan dos dispositivos activos
      const dispActivos = (await dispositivosDe(u.id)).filter((d) => d.activo);
      expect(dispActivos).toHaveLength(1);
    });
  });
});
