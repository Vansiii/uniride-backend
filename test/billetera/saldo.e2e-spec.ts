import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  DOMINIO,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import {
  ayudasBilletera,
  RUTA,
  RUTA_MIA,
  RUTA_SALDO,
  URC,
  type CadenaControlable,
} from './ayudas-billetera.js';

describe('HU-14 · saldo de la billetera (e2e)', () => {
  let e: Entorno;
  let cadena: CadenaControlable;
  const b = ayudasBilletera(() => e);
  let n = 0;

  const usuario = (estado?: string | null) =>
    b.persona(`saldo${++n}${DOMINIO}`, estado);
  const conBilletera = async () => {
    const u = await usuario();
    return { ...u, ...(await b.billetera(u.id)) };
  };
  const bloqueo = (monto: string, reservaId = randomUUID()) => ({
    tipo: 'bloqueo_reserva',
    monto,
    reservaId,
  });
  const diferencias = async (actorId: string) =>
    (
      await e.bd.query(
        `SELECT * FROM registros_auditoria WHERE accion = 'billetera.conciliacion' AND actor_id = $1`,
        [actorId],
      )
    ).rows;

  beforeAll(async () => {
    e = await prepararEntorno();
  });
  beforeEach(() => {
    cadena = b.preparar();
  });
  afterAll(async () => {
    await e.cerrar();
  });

  describe('CA-1: saldo desglosado', () => {
    it('disponible = balanceOf; total = balanceOf + bloqueado (plan §3)', async () => {
      const u = await conBilletera();
      await b.asiento(u.billetera, { monto: '150.00' });
      await b.asiento(u.billetera, bloqueo('15.00'));
      cadena.saldos.set(u.direccion, 135n * URC);

      const r = await b.saldo(u.token).expect(200);
      expect(r.body).toEqual({
        saldoTotal: '150.00',
        saldoDisponible: '135.00',
        saldoBloqueadoEscrow: '15.00',
        moneda: 'URC',
        enLinea: true,
      });
      expect(await diferencias(u.id)).toEqual([]);
    });

    it('sin movimientos todo da 0.00', async () => {
      const u = await conBilletera();
      const r = await b.saldo(u.token).expect(200);
      expect(r.body).toMatchObject({
        saldoTotal: '0.00',
        saldoDisponible: '0.00',
        saldoBloqueadoEscrow: '0.00',
        enLinea: true,
      });
    });

    it.each([
      ['reembolso_reserva', 'confirmado', '0.00'],
      ['liberacion_viaje', 'confirmado', '0.00'],
      ['reembolso_reserva', 'pendiente', '15.00'],
      ['reembolso_reserva', 'fallido', '15.00'],
    ])('un %s %s deja bloqueado %s', async (tipo, estado, bloqueado) => {
      const u = await conBilletera();
      const reservaId = randomUUID();
      await b.asiento(u.billetera, bloqueo('15.00', reservaId));
      await b.asiento(u.billetera, { tipo, monto: '15.00', estado, reservaId });
      const r = await b.saldo(u.token).expect(200);
      expect(r.body.saldoBloqueadoEscrow).toBe(bloqueado);
    });

    it('un bloqueo aún pendiente no cuenta como retenido', async () => {
      const u = await conBilletera();
      await b.asiento(u.billetera, {
        ...bloqueo('15.00'),
        estado: 'pendiente',
      });
      const r = await b.saldo(u.token).expect(200);
      expect(r.body.saldoBloqueadoEscrow).toBe('0.00');
    });

    it('la liberación en la billetera del conductor resuelve el bloqueo del pasajero', async () => {
      const pasajero = await conBilletera();
      const conductor = await conBilletera();
      const reservaId = randomUUID();
      await b.asiento(pasajero.billetera, bloqueo('15.00', reservaId));
      expect(
        (await b.saldo(pasajero.token).expect(200)).body.saldoBloqueadoEscrow,
      ).toBe('15.00');

      await b.asiento(conductor.billetera, {
        tipo: 'liberacion_viaje',
        monto: '15.00',
        reservaId,
      });
      expect(
        (await b.saldo(pasajero.token).expect(200)).body.saldoBloqueadoEscrow,
      ).toBe('0.00');
    });

    it('el reembolso de una reserva no resuelve el bloqueo de otra', async () => {
      const u = await conBilletera();
      const reservaId = randomUUID();
      await b.asiento(u.billetera, bloqueo('15.00', reservaId));
      await b.asiento(u.billetera, bloqueo('20.00'));
      await b.asiento(u.billetera, {
        tipo: 'reembolso_reserva',
        monto: '15.00',
        reservaId,
      });
      const r = await b.saldo(u.token).expect(200);
      expect(r.body.saldoBloqueadoEscrow).toBe('20.00');
    });
  });

  describe('nodo caído o colgado: 200 con enLinea false, nunca 503', () => {
    const libro = async () => {
      const u = await conBilletera();
      await b.asiento(u.billetera, { monto: '150.00' });
      await b.asiento(u.billetera, bloqueo('15.00'));
      await b.asiento(u.billetera, { monto: '500.00', estado: 'pendiente' });
      await b.asiento(u.billetera, { monto: '700.00', estado: 'fallido' });
      return u;
    };
    const CONTABLE = {
      saldoTotal: '150.00',
      saldoDisponible: '135.00',
      saldoBloqueadoEscrow: '15.00',
      moneda: 'URC',
      enLinea: false,
    };

    it('caído: el saldo contable solo cuenta lo confirmado, y sin filtrar la URL del nodo', async () => {
      const u = await libro();
      const avisos = vi.spyOn(Logger.prototype, 'warn');
      cadena.fallar = true;
      const r = await b.saldo(u.token).expect(200);
      expect(r.body).toEqual(CONTABLE);
      expect(avisos).toHaveBeenCalled();
      expect(JSON.stringify(avisos.mock.calls)).not.toContain('nodo.test');
      expect(await diferencias(u.id)).toEqual([]);
      avisos.mockRestore();
    });

    it(
      'colgado: corta al tiempo máximo y responde igual',
      { timeout: 10_000 },
      async () => {
        const u = await libro();
        cadena.colgar = true;
        const r = await b.saldo(u.token).expect(200);
        expect(r.body).toEqual(CONTABLE);
      },
    );

    it('un libro negativo sin nodo no muestra saldo negativo', async () => {
      const u = await conBilletera();
      await b.asiento(u.billetera, bloqueo('15.50'));
      cadena.fallar = true;
      const r = await b.saldo(u.token).expect(200);
      expect(r.body).toMatchObject({
        saldoDisponible: '0.00',
        saldoBloqueadoEscrow: '15.50',
        saldoTotal: '15.50',
      });
    });

    it('caído y sin billetera sigue siendo 404 (CA-6)', async () => {
      cadena.fallar = true;
      const u = await usuario();
      const r = await b.saldo(u.token).expect(404);
      expect(r.body.codigo).toBe('BILLETERA_NO_ENCONTRADA');
    });

    it('caché: 15 s sin volver a leer la cadena; pasado ese tiempo lee de nuevo', async () => {
      const u = await conBilletera();
      cadena.saldos.set(u.direccion, 10n * URC);
      await b.asiento(u.billetera, { monto: '10.00' });
      await b.saldo(u.token).expect(200);
      cadena.fallar = true;
      const cacheado = await b.saldo(u.token).expect(200);
      expect(cacheado.body).toMatchObject({
        saldoDisponible: '10.00',
        enLinea: true,
      });
      expect(cadena.lecturas).toBe(1);

      const reloj = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15_001);
      const vencido = await b.saldo(u.token).expect(200);
      reloj.mockRestore();
      expect(vencido.body.enLinea).toBe(false);
      expect(cadena.lecturas).toBe(2);
    });

    it('A-09: un movimiento confirmado invalida el caché; no se ve como disponible lo ya retenido', async () => {
      const u = await conBilletera();
      await b.asiento(u.billetera, { monto: '150.00' });
      cadena.saldos.set(u.direccion, 150n * URC);
      await b.saldo(u.token).expect(200);

      await b.asiento(u.billetera, bloqueo('15.00'));
      cadena.saldos.set(u.direccion, 135n * URC);
      const r = await b.saldo(u.token).expect(200);

      expect(r.body).toMatchObject({
        saldoTotal: '150.00',
        saldoDisponible: '135.00',
        saldoBloqueadoEscrow: '15.00',
        enLinea: true,
      });
      expect(cadena.lecturas).toBe(2);
      expect(await diferencias(u.id)).toEqual([]);
    });

    it('un movimiento aún pendiente no gasta otra lectura de la cadena', async () => {
      const u = await conBilletera();
      await b.saldo(u.token).expect(200);
      await b.asiento(u.billetera, { monto: '10.00', estado: 'pendiente' });
      await b.saldo(u.token).expect(200);
      expect(cadena.lecturas).toBe(1);
    });
  });

  describe('CA-4: conciliación', () => {
    it('con diferencia audita y avisa, sin cambiar la respuesta', async () => {
      const u = await conBilletera();
      await b.asiento(u.billetera, { monto: '100.00' });
      cadena.saldos.set(u.direccion, 90n * URC);
      const avisos = vi.spyOn(Logger.prototype, 'warn');

      const r = await b.saldo(u.token).expect(200);
      expect(r.body).toMatchObject({ saldoDisponible: '90.00', enLinea: true });
      const [fila, ...resto] = await diferencias(u.id);
      expect(resto).toEqual([]);
      expect(fila).toMatchObject({
        entidad: 'billetera',
        entidad_id: u.billetera,
        resultado: 'fallo',
        detalle: { saldoCadena: '90.0', saldoContable: '100.0' },
      });
      expect(JSON.stringify(avisos.mock.calls)).toContain(u.billetera);
      avisos.mockRestore();

      await b.saldo(u.token).expect(200); // del caché: no repite el reporte
      expect((await diferencias(u.id)).length).toBe(1);
    });

    it('con un movimiento pendiente no concilia', async () => {
      const u = await conBilletera();
      await b.asiento(u.billetera, { monto: '100.00', estado: 'pendiente' });
      cadena.saldos.set(u.direccion, 100n * URC);
      await b.saldo(u.token).expect(200);
      expect(await diferencias(u.id)).toEqual([]);
    });

    it('cuadra un viaje completo: recarga, bloqueo y reembolso', async () => {
      const u = await conBilletera();
      const reservaId = randomUUID();
      await b.asiento(u.billetera, { monto: '100.00' });
      await b.asiento(u.billetera, bloqueo('15.00', reservaId));
      await b.asiento(u.billetera, {
        tipo: 'reembolso_reserva',
        monto: '15.00',
        reservaId,
      });
      cadena.saldos.set(u.direccion, 100n * URC);
      const r = await b.saldo(u.token).expect(200);
      expect(r.body).toMatchObject({
        saldoTotal: '100.00',
        saldoBloqueadoEscrow: '0.00',
      });
      expect(await diferencias(u.id)).toEqual([]);
    });
  });

  describe('CA-6 y guards', () => {
    it('verificada sin billetera: 404 BILLETERA_NO_ENCONTRADA', async () => {
      const u = await usuario();
      const r = await b.saldo(u.token).expect(404);
      expect(r.body.codigo).toBe('BILLETERA_NO_ENCONTRADA');
    });

    it.each([null, 'no_verificada', 'en_revision', 'rechazada'])(
      'identidad %s: 403 IDENTIDAD_NO_VERIFICADA',
      async (estado) => {
        const u = await usuario(estado);
        const r = await b.saldo(u.token).expect(403);
        expect(r.body.codigo).toBe('IDENTIDAD_NO_VERIFICADA');
      },
    );

    it('cuenta suspendida: 403 CUENTA_SUSPENDIDA', async () => {
      const u = await conBilletera();
      await e.bd.query(
        `UPDATE usuarios SET suspendida_en = now() WHERE id = $1`,
        [u.id],
      );
      const r = await b.saldo(u.token).expect(403);
      expect(r.body.codigo).toBe('CUENTA_SUSPENDIDA');
    });

    it('sin token: 401 NO_AUTENTICADO', async () => {
      const r = await e.api().get(RUTA_SALDO).expect(401);
      expect(r.body.codigo).toBe('NO_AUTENTICADO');
    });

    it('POST /billetera y GET /mia siguen exigiendo firma, después de identidad', async () => {
      const u = await conBilletera();
      await b.saldo(u.token).expect(200); // esta lectura pasa sin firma
      const sinVerificar = await usuario('en_revision');
      for (const peticion of [
        () => e.api().get(RUTA_MIA),
        () => e.api().post(RUTA),
      ]) {
        const sinFirma = await peticion().set(b.conToken(u.token)).expect(401);
        expect(sinFirma.body.codigo).toBe('FIRMA_DISPOSITIVO_INVALIDA');
        const r = await peticion()
          .set(b.conToken(sinVerificar.token))
          .expect(403);
        expect(r.body.codigo).toBe('IDENTIDAD_NO_VERIFICADA');
      }
    });
  });
});
