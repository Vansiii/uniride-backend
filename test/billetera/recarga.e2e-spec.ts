import { randomUUID } from 'node:crypto';
import {
  DOMINIO,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import {
  ayudasBilletera,
  firmar,
  RUTA_RECARGAS,
  URC,
  type CadenaControlable,
} from './ayudas-billetera.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('hex');

describe('HU-13 · recarga de saldo (e2e)', () => {
  let e: Entorno;
  let cadena: CadenaControlable;
  const b = ayudasBilletera(() => e);
  let n = 0;
  const recargador = () => b.recargador(`recarga${++n}${DOMINIO}`);
  const ordenes = async (usuarioId: string) =>
    (
      await e.bd.query(`SELECT * FROM ordenes_recarga WHERE usuario_id = $1`, [
        usuarioId,
      ])
    ).rows;

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

  describe('CA-1: recarga completa', () => {
    it('orden con QR, confirmación firmada, acuñación y saldo actualizado con su hash', async () => {
      const u = await recargador();
      const creada = await b.crearRecarga(u.token, 50).expect(201);
      expect(creada.body).toMatchObject({
        monto: '50.00',
        estado: 'pendiente',
        hashTx: null,
        qrTexto: `uniride://recarga/${creada.body.ordenId}`,
      });
      expect(
        Buffer.from(creada.body.qrImagenBase64, 'base64')
          .subarray(0, 4)
          .toString('hex'),
      ).toBe(PNG);
      const vida = new Date(creada.body.expiraEn).getTime() - Date.now();
      expect(vida).toBeGreaterThan(14 * 60_000);
      expect(vida).toBeLessThanOrEqual(15 * 60_000);
      const id = creada.body.ordenId as string;

      const confirmada = await b
        .confirmarRecarga(u.token, id, u.dispositivo)
        .expect(202);
      expect(confirmada.body).toMatchObject({
        ordenId: id,
        estado: 'procesando',
        monto: '50.00',
      });
      expect(cadena.saldos.get(u.direccion)).toBeUndefined();
      expect(await b.filasDeOrden(id)).toMatchObject([
        { estado: 'pendiente', hash_tx: null, trabajo: 'pendiente' },
      ]);

      await expect(b.worker().procesarPendientes()).resolves.toBeGreaterThan(0);

      const final = await b.consultarRecarga(u.token, id).expect(200);
      expect(final.body.estado).toBe('completada');
      expect(final.body.hashTx).toMatch(/^0x[0-9a-f]{64}$/);
      expect(cadena.saldos.get(u.direccion)).toBe(50n * URC);
      expect(await b.filasDeOrden(id)).toEqual([
        {
          estado: 'confirmado',
          hash_tx: final.body.hashTx,
          monto: '50.00',
          trabajo: 'terminado',
          intentos: 0,
        },
      ]);

      const saldo = await b.saldo(u.token).expect(200);
      expect(saldo.body).toMatchObject({
        saldoDisponible: '50.00',
        enLinea: true,
      });
      const movs = await b.movimientos(u.token).expect(200);
      expect(movs.body.items).toMatchObject([
        { tipo: 'recarga', estado: 'confirmado', hashTx: final.body.hashTx },
      ]);

      const { rows } = await e.bd.query(
        `SELECT accion FROM registros_auditoria WHERE entidad_id = $1 ORDER BY creado_en`,
        [id],
      );
      expect(rows.map((r) => r.accion)).toEqual([
        'billetera.recarga.confirmada',
        'billetera.recarga.acreditada',
      ]);
    });

    it('no acredita antes de confirmar', async () => {
      const u = await recargador();
      await b.crearRecarga(u.token, 50).expect(201);
      await b.worker().procesarPendientes();
      expect(cadena.acunaciones).toBe(0);
    });
  });

  describe('CA-2 y RN-7: montos', () => {
    it.each([9.99, 500.01, 0, -5])(
      '%d: rechazado con los límites',
      async (monto) => {
        const u = await recargador();
        const r = await b.crearRecarga(u.token, monto).expect(400);
        expect(r.body.codigo).toBe('MONTO_FUERA_DE_RANGO');
        expect(r.body.mensaje).toContain('10 y 500');
        expect(await ordenes(u.id)).toEqual([]);
      },
    );

    it.each([10.999, 50.001])('%d: más de 2 decimales', async (monto) => {
      const u = await recargador();
      const r = await b.crearRecarga(u.token, monto).expect(400);
      expect(r.body.codigo).toBe('MONTO_INVALIDO');
      expect(await ordenes(u.id)).toEqual([]);
    });

    it.each(['50', null, true])('%j: validación', async (monto) => {
      const u = await recargador();
      const r = await b.crearRecarga(u.token, monto).expect(400);
      expect(r.body.codigo).toBe('VALIDACION_FALLIDA');
    });

    it.each([
      [10, '10.00'],
      [500, '500.00'],
      [12.35, '12.35'],
    ])('%d: los límites y los centavos se aceptan', async (monto, texto) => {
      const u = await recargador();
      const r = await b.crearRecarga(u.token, monto).expect(201);
      expect(r.body.monto).toBe(texto);
    });

    it('acuña la cantidad exacta con centavos', async () => {
      const u = await recargador();
      const { body } = await b.crearRecarga(u.token, 12.35).expect(201);
      await b
        .confirmarRecarga(u.token, body.ordenId, u.dispositivo)
        .expect(202);
      await b.worker().procesarPendientes();
      expect(cadena.saldos.get(u.direccion)).toBe(1235n * 10n ** 16n);
    });
  });

  describe('CA-5: orden vencida', () => {
    const vencer = (id: string) =>
      e.bd.query(
        `UPDATE ordenes_recarga SET expira_en = now() - interval '1 second' WHERE id = $1`,
        [id],
      );

    it('confirmarla responde 410 y no acredita', async () => {
      const u = await recargador();
      const { body } = await b.crearRecarga(u.token).expect(201);
      await vencer(body.ordenId);
      const r = await b
        .confirmarRecarga(u.token, body.ordenId, u.dispositivo)
        .expect(410);
      expect(r.body.codigo).toBe('ORDEN_EXPIRADA');
      expect((await b.filaOrden(body.ordenId)).estado).toBe('expirada');
      expect(await b.filasDeOrden(body.ordenId)).toEqual([]);
      await b.worker().procesarPendientes();
      expect(cadena.acunaciones).toBe(0);
    });

    it('consultarla la deja en expirada, y ya no se puede confirmar', async () => {
      const u = await recargador();
      const { body } = await b.crearRecarga(u.token).expect(201);
      await vencer(body.ordenId);
      const r = await b.consultarRecarga(u.token, body.ordenId).expect(200);
      expect(r.body.estado).toBe('expirada');
      await b
        .confirmarRecarga(u.token, body.ordenId, u.dispositivo)
        .expect(410);
    });

    it('a un minuto de vencer todavía se puede confirmar', async () => {
      const u = await recargador();
      const { body } = await b.crearRecarga(u.token).expect(201);
      await e.bd.query(
        `UPDATE ordenes_recarga SET expira_en = now() + interval '1 minute' WHERE id = $1`,
        [body.ordenId],
      );
      await b
        .confirmarRecarga(u.token, body.ordenId, u.dispositivo)
        .expect(202);
    });

    it('una orden en procesando ya no vence y se acredita', async () => {
      const u = await recargador();
      const { body } = await b.crearRecarga(u.token).expect(201);
      await b
        .confirmarRecarga(u.token, body.ordenId, u.dispositivo)
        .expect(202);
      await vencer(body.ordenId);
      const r = await b.consultarRecarga(u.token, body.ordenId).expect(200);
      expect(r.body.estado).toBe('procesando');
      await b.worker().procesarPendientes();
      expect(cadena.saldos.get(u.direccion)).toBe(50n * URC);
    });
  });

  describe('CA-6: quién puede recargar', () => {
    it.each([
      ['sin identidad', null],
      ['con identidad en revisión', 'en_revision'],
      ['con identidad rechazada', 'rechazada'],
    ])('%s: 403', async (_, estado) => {
      const u = await b.persona(`recarga${++n}${DOMINIO}`, estado);
      const r = await b.crearRecarga(u.token).expect(403);
      expect(r.body.codigo).toBe('IDENTIDAD_NO_VERIFICADA');
      expect(await ordenes(u.id)).toEqual([]);
    });

    it('verificada y sin billetera: 404', async () => {
      const u = await b.persona(`recarga${++n}${DOMINIO}`);
      const r = await b.crearRecarga(u.token).expect(404);
      expect(r.body.codigo).toBe('BILLETERA_NO_ENCONTRADA');
    });

    it('cuenta suspendida: 403', async () => {
      const u = await recargador();
      await e.bd.query(
        `UPDATE usuarios SET suspendida_en = now() WHERE id = $1`,
        [u.id],
      );
      const r = await b.crearRecarga(u.token).expect(403);
      expect(r.body.codigo).toBe('CUENTA_SUSPENDIDA');
    });

    it('sin sesión: 401', async () => {
      await e.api().post(RUTA_RECARGAS).send({ monto: 50 }).expect(401);
    });
  });

  describe('A-10: la orden de otra persona no existe para ti', () => {
    it('leerla o confirmarla da 404 y la orden no cambia', async () => {
      const [duena, ajena] = [await recargador(), await recargador()];
      const { body } = await b.crearRecarga(duena.token).expect(201);
      const lectura = await b
        .consultarRecarga(ajena.token, body.ordenId)
        .expect(404);
      expect(lectura.body.codigo).toBe('NO_ENCONTRADO');
      const confirmacion = await b
        .confirmarRecarga(ajena.token, body.ordenId, ajena.dispositivo)
        .expect(404);
      expect(confirmacion.body.codigo).toBe('NO_ENCONTRADO');
      expect((await b.filaOrden(body.ordenId)).estado).toBe('pendiente');
    });

    it('una orden inexistente da 404, y un id mal formado 400', async () => {
      const u = await recargador();
      await b.consultarRecarga(u.token, randomUUID()).expect(404);
      await b
        .confirmarRecarga(u.token, randomUUID(), u.dispositivo)
        .expect(404);
      await b.consultarRecarga(u.token, 'no-es-uuid').expect(400);
    });
  });

  describe('RN-6: falla del nodo', () => {
    it('sigue procesando, reintenta sola y no descarta nada', async () => {
      const u = await recargador();
      const { body } = await b.crearRecarga(u.token).expect(201);
      const id = body.ordenId as string;
      await b.confirmarRecarga(u.token, id, u.dispositivo).expect(202);

      cadena.fallar = true;
      await expect(b.worker().procesarPendientes()).resolves.toBe(0);
      const r = await b.consultarRecarga(u.token, id).expect(200);
      expect(r.body.estado).toBe('procesando');
      const [fila] = await b.filasDeOrden(id);
      expect(fila).toMatchObject({
        estado: 'pendiente',
        trabajo: 'pendiente',
        intentos: 1,
      });

      // Todavía en espera: no se vuelve a intentar antes de tiempo.
      await b.worker().procesarPendientes();
      expect(cadena.acunaciones).toBe(1);

      cadena.fallar = false;
      await b.vencerEspera(id);
      await expect(b.worker().procesarPendientes()).resolves.toBe(1);
      const fin = await b.consultarRecarga(u.token, id).expect(200);
      expect(fin.body.estado).toBe('completada');
      expect(cadena.saldos.get(u.direccion)).toBe(50n * URC);
    });

    it('al quinto intento alerta una vez en auditoría y sigue reintentando', async () => {
      const u = await recargador();
      const { body } = await b.crearRecarga(u.token).expect(201);
      const id = body.ordenId as string;
      await b.confirmarRecarga(u.token, id, u.dispositivo).expect(202);
      cadena.fallar = true;
      for (let i = 0; i < 7; i++) {
        await b.vencerEspera(id);
        await b.worker().procesarPendientes();
      }
      const { rows } = await e.bd.query(
        `SELECT detalle FROM registros_auditoria WHERE accion = 'billetera.recarga.atascada' AND entidad_id = $1`,
        [id],
      );
      expect(rows).toEqual([
        { detalle: { intentos: 5, motivo: 'SERVER_ERROR' } },
      ]);
      expect(await b.filasDeOrden(id)).toMatchObject([
        { estado: 'pendiente', trabajo: 'pendiente', intentos: 7 },
      ]);
      const [trabajo] = (
        await e.bd.query(
          `SELECT t.ultimo_error FROM trabajos_onchain t JOIN movimientos_billetera m ON m.id = t.movimiento_id WHERE m.clave_idempotencia = $1`,
          [`recarga:${id}`],
        )
      ).rows;
      expect(trabajo.ultimo_error).toBe('SERVER_ERROR');

      cadena.fallar = false;
      await b.vencerEspera(id);
      await b.worker().procesarPendientes();
      expect((await b.filaOrden(id)).estado).toBe('completada');
    });
  });

  it('la firma de una recarga no sirve para otra ruta', async () => {
    const u = await recargador();
    const { body } = await b.crearRecarga(u.token).expect(201);
    await e
      .api()
      .post(`${RUTA_RECARGAS}/${body.ordenId}/confirmar`)
      .set(b.conToken(u.token))
      .set(firmar('POST', '/api/v1/billetera', u.dispositivo))
      .expect(401);
  });
});
