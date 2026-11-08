import { Logger } from '@nestjs/common';
import { Wallet } from 'ethers';
import pg from 'pg';
import { descifrarLlave } from '../../src/billetera/custodia.js';
import {
  DOMINIO,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import { ayudasIdentidad } from '../identidad/ayudas-identidad.js';
import {
  ayudasBilletera,
  firmar,
  RUTA,
  RUTA_MIA,
  URC,
  type CadenaControlable,
  type Dispositivo,
} from './ayudas-billetera.js';

const ES_LLAVE_CLARA = /(^|[^0-9a-fA-F])(0x)?[0-9a-fA-F]{64}($|[^0-9a-fA-F])/;

describe('HU-12 · creación de billetera (e2e)', () => {
  let e: Entorno;
  let cadena: CadenaControlable;
  const b = ayudasBilletera(() => e);
  const i = ayudasIdentidad(() => e);
  let n = 0;

  /** Usuario con la identidad en ese estado, sesión iniciada y dispositivo vinculado. */
  const usuario = async (estado: string | null = 'verificada') => {
    const correo = `billetera${++n}${DOMINIO}`;
    const id = await e.crearUsuario(correo);
    if (estado)
      await e.bd.query(
        `INSERT INTO identidades (usuario_id, estado, consentimiento_en, documento_hash, verificado_en)
         VALUES ($1, $2, now(), $3, $4)`,
        [
          id,
          estado,
          estado === 'verificada' ? `hash-billetera-${n}` : null,
          estado === 'verificada' ? new Date() : null,
        ],
      );
    const token = await e.iniciar(correo);
    const dispositivo: Dispositivo = await b.vincular(id);
    return { id, token, dispositivo };
  };
  type Usuario = Awaited<ReturnType<typeof usuario>>;
  const crearOk = async (u: Usuario) =>
    (await b.crear(u.token, u.dispositivo).expect(201)).body;

  beforeAll(async () => {
    e = await prepararEntorno();
  });
  beforeEach(() => {
    cadena = b.preparar();
    i.preparar();
  });
  afterAll(async () => {
    await e.cerrar();
  });

  describe('CA-1: creación automática al aprobarse la identidad', () => {
    it('al verificarse queda la billetera con saldo 0, sin pedir nada más', async () => {
      const p = await i.persona();
      expect((await b.filas(p.id)).length).toBe(0);
      (await i.intento(p)).expect(200);

      const [fila] = await b.filas(p.id);
      expect(fila.direccion).toMatch(/^0x[0-9a-fA-F]{40}$/);
      const [auditoria] = await b.auditorias(p.id);
      expect(auditoria).toMatchObject({
        resultado: 'ok',
        entidad_id: fila.id,
      });
      const d = await b.vincular(p.id);
      const r = await b.mia(p.token, d).expect(200);
      expect(r.body).toEqual({
        id: fila.id,
        direccion: fila.direccion,
        saldoUrc: '0.00',
        exploradorUrl: null,
      });
    });

    it('si la cadena falla no revierte la verificación, queda registrado y POST reintenta', async () => {
      const p = await i.persona();
      cadena.fallar = true;
      (await i.intento(p)).expect(200);

      expect((await i.estado(p).expect(200)).body.estado).toBe('verificada');
      expect(await b.filas(p.id)).toEqual([]);
      const [auditoria] = await b.auditorias(p.id);
      expect(auditoria).toMatchObject({
        resultado: 'fallo',
        detalle: { motivo: 'SERVICIO_BLOCKCHAIN_NO_DISPONIBLE' },
      });

      cadena.fallar = false;
      const d = await b.vincular(p.id);
      await b.mia(p.token, d).expect(404);
      await b.crear(p.token, d).expect(201);
      expect((await b.filas(p.id)).length).toBe(1);
    });

    it('la identidad rechazada no crea billetera', async () => {
      const p = await i.persona();
      (await i.intento(p, { foto: null })).expect(400);
      expect(await b.filas(p.id)).toEqual([]);
    });

    it('una cuenta suspendida se verifica pero no recibe billetera', async () => {
      const p = await i.persona();
      await e.bd.query(
        `UPDATE usuarios SET suspendida_en = now() WHERE id = $1`,
        [p.id],
      );
      (await i.intento(p)).expect(200);
      expect(await b.filas(p.id)).toEqual([]);
      expect((await b.auditorias(p.id))[0].detalle.motivo).toBe(
        'CUENTA_SUSPENDIDA',
      );
    });
  });

  describe('CA-2 y A-02: una sola billetera por usuario', () => {
    it('POST repetido responde 200 con la misma billetera', async () => {
      const u = await usuario();
      const primera = await crearOk(u);
      const otra = await b.crear(u.token, u.dispositivo).expect(200);
      expect(otra.body).toEqual(primera);
      expect((await b.filas(u.id)).length).toBe(1);
      expect((await b.auditorias(u.id)).length).toBe(1);
    });

    it('A-02: peticiones simultáneas dejan una sola billetera', async () => {
      const u = await usuario();
      const respuestas = await Promise.all(
        Array.from({ length: 5 }, () => b.crear(u.token, u.dispositivo)),
      );
      const estados = respuestas.map((r) => r.status).sort();
      expect(estados).toEqual([200, 200, 200, 200, 201]);
      expect(new Set(respuestas.map((r) => r.body.direccion)).size).toBe(1);
      expect((await b.filas(u.id)).length).toBe(1);
      expect((await b.auditorias(u.id)).length).toBe(1);
    });

    it('A-02: la BD rechaza una segunda billetera y una dirección repetida', async () => {
      const u = await usuario();
      const o = await usuario();
      const { direccion } = await crearOk(u);
      const insertar = (usuarioId: string, dir: string) =>
        e.bd.query(
          `INSERT INTO billeteras (usuario_id, direccion, llave_custodia_ref) VALUES ($1, $2, 'x')`,
          [usuarioId, dir],
        );
      await expect(insertar(u.id, `0x${'a'.repeat(40)}`)).rejects.toThrow(
        /billeteras_usuario_id_key/,
      );
      await expect(insertar(o.id, direccion)).rejects.toThrow(
        /billeteras_direccion_key/,
      );
      await expect(insertar(o.id, '0x123')).rejects.toThrow(
        /billeteras_direccion_chk/,
      );
    });

    it('el rol de la API no puede modificar ni borrar billeteras', async () => {
      const u = await usuario();
      await crearOk(u);
      const app = new pg.Client({
        connectionString: process.env.DATABASE_URL,
      });
      await app.connect();
      try {
        await expect(
          app.query(
            `UPDATE billeteras SET llave_custodia_ref = 'x' WHERE usuario_id = $1`,
            [u.id],
          ),
        ).rejects.toThrow(/permission denied/);
        await expect(
          app.query(`DELETE FROM billeteras WHERE usuario_id = $1`, [u.id]),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await app.end();
      }
    });
  });

  describe('CA-3 y A-12: la llave privada nunca es legible', () => {
    it('en BD solo está cifrada, descifra a la llave de esa dirección y nunca aparece', async () => {
      const u = await usuario();
      const registrado: unknown[][] = [];
      const anotar = (...args: unknown[]) => {
        registrado.push(args);
      };
      const espias = [
        vi.spyOn(Logger.prototype, 'log').mockImplementation(anotar),
        vi.spyOn(Logger.prototype, 'warn').mockImplementation(anotar),
        vi.spyOn(Logger.prototype, 'error').mockImplementation(anotar),
        vi.spyOn(process.stdout, 'write').mockImplementation((t) => {
          anotar(t);
          return true;
        }),
        vi.spyOn(process.stderr, 'write').mockImplementation((t) => {
          anotar(t);
          return true;
        }),
      ];
      let creada;
      let consultada;
      try {
        creada = await b.crear(u.token, u.dispositivo).expect(201);
        consultada = await b.mia(u.token, u.dispositivo).expect(200);
      } finally {
        espias.forEach((espia) => espia.mockRestore());
      }

      const [fila] = await b.filas(u.id);
      const llave = descifrarLlave(fila.llave_custodia_ref, fila.direccion);
      expect(new Wallet(llave).address).toBe(fila.direccion);

      const sinPrefijo = llave.slice(2);
      const auditoria = JSON.stringify(await b.auditorias(u.id));
      for (const texto of [
        JSON.stringify(creada.body),
        JSON.stringify(consultada.body),
        JSON.stringify(registrado),
        auditoria,
        fila.llave_custodia_ref,
      ]) {
        expect(texto).not.toContain(sinPrefijo);
        expect(texto).not.toMatch(ES_LLAVE_CLARA);
      }
      // Tampoco el material cifrado sale de la base.
      for (const texto of [
        JSON.stringify(creada.body),
        JSON.stringify(consultada.body),
        JSON.stringify(registrado),
        auditoria,
      ]) {
        expect(texto).not.toContain(fila.llave_custodia_ref);
        expect(texto).not.toContain(fila.llave_custodia_ref.split('.').at(-1));
      }
    });

    it('las respuestas traen solo los cuatro campos públicos', async () => {
      const u = await usuario();
      const creada = await crearOk(u);
      const consultada = (await b.mia(u.token, u.dispositivo).expect(200)).body;
      for (const cuerpo of [creada, consultada])
        expect(Object.keys(cuerpo).sort()).toEqual([
          'direccion',
          'exploradorUrl',
          'id',
          'saldoUrc',
        ]);
    });

    it('ninguna columna de la fila guarda una frase semilla ni la llave en claro', async () => {
      const u = await usuario();
      await crearOk(u);
      const [fila] = await b.filas(u.id);
      expect(Object.keys(fila).sort()).toEqual([
        'actualizado_en',
        'creado_en',
        'direccion',
        'id',
        'llave_custodia_ref',
        'usuario_id',
      ]);
      expect(fila.llave_custodia_ref.split('.')).toHaveLength(3);
      expect(fila.llave_custodia_ref).not.toMatch(ES_LLAVE_CLARA);
      expect(fila.llave_custodia_ref).not.toMatch(/\s/);
    });

    it('dos billeteras nunca comparten dirección ni material cifrado', async () => {
      const [u, o] = [await usuario(), await usuario()];
      await crearOk(u);
      await crearOk(o);
      const [fu] = await b.filas(u.id);
      const [fo] = await b.filas(o.id);
      expect(fu.direccion).not.toBe(fo.direccion);
      expect(fu.llave_custodia_ref).not.toBe(fo.llave_custodia_ref);
    });

    it('una caída de la cadena no filtra datos del nodo en la respuesta', async () => {
      const u = await usuario();
      cadena.fallar = true;
      const r = await b.crear(u.token, u.dispositivo).expect(503);
      expect(JSON.stringify(r.body)).not.toContain('clave-rpc');
    });
  });

  describe('CA-4: identidad no verificada', () => {
    it.each([
      ['sin fila', null],
      ['no_verificada', 'no_verificada'],
      ['en_revision (pendiente)', 'en_revision'],
      ['rechazada', 'rechazada'],
      ['bloqueada_temporal', 'bloqueada_temporal'],
    ])('%s: 403 en POST y GET, sin crear nada', async (_, estado) => {
      const u = await usuario(estado);
      const creada = await b.crear(u.token, u.dispositivo).expect(403);
      const consultada = await b.mia(u.token, u.dispositivo).expect(403);
      expect(creada.body.codigo).toBe('IDENTIDAD_NO_VERIFICADA');
      expect(consultada.body.codigo).toBe('IDENTIDAD_NO_VERIFICADA');
      expect(await b.filas(u.id)).toEqual([]);
    });

    it('sin dispositivo vinculado también responde 403 (identidad antes que firma)', async () => {
      const correo = `billetera${++n}${DOMINIO}`;
      await e.crearUsuario(correo);
      const token = await e.iniciar(correo);
      const r = await e.api().post(RUTA).set(b.conToken(token)).expect(403);
      expect(r.body.codigo).toBe('IDENTIDAD_NO_VERIFICADA');
    });
  });

  describe('CA-5: consulta de dirección y saldo', () => {
    it('devuelve la dirección y el saldo leído de la cadena, truncado', async () => {
      const u = await usuario();
      const { direccion } = await crearOk(u);
      cadena.saldos.set(direccion, (URC * 1239n) / 100n);
      const r = await b.mia(u.token, u.dispositivo).expect(200);
      expect(r.body.saldoUrc).toBe('12.39');
      cadena.saldos.set(direccion, (URC * 12399n) / 1000n);
      const truncado = await b.mia(u.token, u.dispositivo).expect(200);
      expect(truncado.body.saldoUrc).toBe('12.39');
    });

    it('expone el enlace al explorador que da la cadena', async () => {
      const u = await usuario();
      cadena.explorador = 'https://amoy.polygonscan.com/address/x';
      const r = await b.crear(u.token, u.dispositivo).expect(201);
      expect(r.body.exploradorUrl).toBe(cadena.explorador);
    });

    it('sin billetera: 404 BILLETERA_NO_ENCONTRADA', async () => {
      const u = await usuario();
      const r = await b.mia(u.token, u.dispositivo).expect(404);
      expect(r.body.codigo).toBe('BILLETERA_NO_ENCONTRADA');
    });

    it('cada persona ve solo su billetera: la de otro no existe para ella', async () => {
      const [duena, otra] = [await usuario(), await usuario()];
      await crearOk(duena);
      const r = await b.mia(otra.token, otra.dispositivo).expect(404);
      expect(r.body.codigo).toBe('BILLETERA_NO_ENCONTRADA');
    });
  });

  describe('CA-6: fallas de la cadena', () => {
    it('POST responde 503 recuperable y no deja filas a medias', async () => {
      const u = await usuario();
      cadena.fallar = true;
      const r = await b.crear(u.token, u.dispositivo).expect(503);
      expect(r.body.codigo).toBe('SERVICIO_BLOCKCHAIN_NO_DISPONIBLE');
      expect(await b.filas(u.id)).toEqual([]);
      expect(await b.auditorias(u.id)).toEqual([]);

      cadena.fallar = false;
      await b.crear(u.token, u.dispositivo).expect(201);
    });

    it('con billetera existente y la cadena caída, GET y POST responden 503 y la fila sigue igual', async () => {
      const u = await usuario();
      await crearOk(u);
      const antes = await b.filas(u.id);
      cadena.fallar = true;
      for (const r of [
        await b.mia(u.token, u.dispositivo).expect(503),
        await b.crear(u.token, u.dispositivo).expect(503),
      ])
        expect(r.body.codigo).toBe('SERVICIO_BLOCKCHAIN_NO_DISPONIBLE');
      expect(await b.filas(u.id)).toEqual(antes);
    });

    it('sin clave de custodia responde 503 sin insertar', async () => {
      const u = await usuario();
      const clave = process.env.WALLET_ENCRYPTION_KEY;
      process.env.WALLET_ENCRYPTION_KEY = '';
      try {
        const r = await b.crear(u.token, u.dispositivo).expect(503);
        expect(r.body.codigo).toBe('SERVICIO_BLOCKCHAIN_NO_DISPONIBLE');
      } finally {
        process.env.WALLET_ENCRYPTION_KEY = clave;
      }
      expect(await b.filas(u.id)).toEqual([]);
    });
  });

  describe('spec §4: cuenta suspendida', () => {
    it('POST y GET responden 403 CUENTA_SUSPENDIDA, sin crear nada', async () => {
      const u = await usuario();
      await e.bd.query(
        `UPDATE usuarios SET suspendida_en = now() WHERE id = $1`,
        [u.id],
      );
      const creada = await b.crear(u.token, u.dispositivo).expect(403);
      const consultada = await b.mia(u.token, u.dispositivo).expect(403);
      expect(creada.body.codigo).toBe('CUENTA_SUSPENDIDA');
      expect(consultada.body.codigo).toBe('CUENTA_SUSPENDIDA');
      expect(await b.filas(u.id)).toEqual([]);
    });

    it('también con billetera ya creada y sin firma de dispositivo', async () => {
      const u = await usuario();
      await crearOk(u);
      await e.bd.query(
        `UPDATE usuarios SET suspendida_en = now() WHERE id = $1`,
        [u.id],
      );
      const r = await e
        .api()
        .get(RUTA_MIA)
        .set(b.conToken(u.token))
        .expect(403);
      expect(r.body.codigo).toBe('CUENTA_SUSPENDIDA');
    });
  });

  describe('A-08: sesión y firma de dispositivo', () => {
    it('sin sesión responde 401', async () => {
      await e.api().post(RUTA).expect(401);
      await e.api().get(RUTA_MIA).expect(401);
    });

    it('verificado pero sin firma responde 401 y no crea nada', async () => {
      const u = await usuario();
      const creada = await e
        .api()
        .post(RUTA)
        .set(b.conToken(u.token))
        .expect(401);
      const consultada = await e
        .api()
        .get(RUTA_MIA)
        .set(b.conToken(u.token))
        .expect(401);
      expect(creada.body.codigo).toBe('FIRMA_DISPOSITIVO_INVALIDA');
      expect(consultada.body.codigo).toBe('FIRMA_DISPOSITIVO_INVALIDA');
      expect(await b.filas(u.id)).toEqual([]);
    });

    it('la firma con el dispositivo de otra persona responde 401', async () => {
      const [u, o] = [await usuario(), await usuario()];
      const r = await b.crear(u.token, o.dispositivo).expect(401);
      expect(r.body.codigo).toBe('FIRMA_DISPOSITIVO_INVALIDA');
      expect(await b.filas(u.id)).toEqual([]);
    });

    it('repetir una petición firmada (mismo nonce) responde 401', async () => {
      const u = await usuario();
      const cabeceras = firmar('POST', RUTA, u.dispositivo);
      await e
        .api()
        .post(RUTA)
        .set(b.conToken(u.token))
        .set(cabeceras)
        .expect(201);
      const r = await e
        .api()
        .post(RUTA)
        .set(b.conToken(u.token))
        .set(cabeceras)
        .expect(401);
      expect(r.body.codigo).toBe('PETICION_EXPIRADA');
    });
  });
});
