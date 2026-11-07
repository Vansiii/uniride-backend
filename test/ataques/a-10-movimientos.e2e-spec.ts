import { randomUUID } from 'node:crypto';
import {
  DOMINIO,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import {
  ayudasBilletera,
  URC,
  type CadenaControlable,
} from '../billetera/ayudas-billetera.js';

/** A-10 (trazabilidad de fondos): cada persona solo ve lo suyo. La ruta no admite ningún id, solo vale el token. */
describe('A-10 · cada persona solo ve sus movimientos (e2e)', () => {
  let e: Entorno;
  let cadena: CadenaControlable;
  const b = ayudasBilletera(() => e);
  let n = 0;

  const persona = async () => {
    const p = await b.persona(`a10${++n}${DOMINIO}`);
    return { ...p, ...(await b.billetera(p.id)) };
  };

  beforeAll(async () => {
    e = await prepararEntorno();
  });
  beforeEach(() => {
    cadena = b.preparar();
  });
  afterAll(async () => {
    await e.cerrar();
  });

  it('el historial de una persona no trae nada de otra', async () => {
    const ana = await persona();
    const beto = await persona();
    const deAna = await b.asiento(ana.billetera, { monto: '11.00' });
    const deBeto = await b.asiento(beto.billetera, { monto: '22.00' });

    const r = await b.movimientos(ana.token).expect(200);
    expect(r.body.total).toBe(1);
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([deAna]);
    expect(JSON.stringify(r.body)).not.toContain(deBeto);
  });

  it.each(['billeteraId', 'usuarioId', 'usuario_id', 'billetera_id'])(
    'pedir los de otra con ?%s= se rechaza con 400',
    async (parametro) => {
      const ana = await persona();
      const beto = await persona();
      await b.asiento(beto.billetera);
      const r = await b
        .movimientos(ana.token, { [parametro]: beto.billetera })
        .expect(400);
      expect(r.body.codigo).toBe('VALIDACION_FALLIDA');
    },
  );

  it('el saldo de cada persona sale de su propia billetera y su propio bloqueo', async () => {
    const ana = await persona();
    const beto = await persona();
    await b.asiento(ana.billetera, {
      tipo: 'bloqueo_reserva',
      monto: '5.00',
      reservaId: randomUUID(),
    });
    await b.asiento(beto.billetera, {
      tipo: 'bloqueo_reserva',
      monto: '7.00',
      reservaId: randomUUID(),
    });
    cadena.saldos.set(ana.direccion, URC);
    cadena.saldos.set(beto.direccion, 2n * URC);

    expect((await b.saldo(ana.token).expect(200)).body).toMatchObject({
      saldoDisponible: '1.00',
      saldoBloqueadoEscrow: '5.00',
      saldoTotal: '6.00',
    });
    expect((await b.saldo(beto.token).expect(200)).body).toMatchObject({
      saldoDisponible: '2.00',
      saldoBloqueadoEscrow: '7.00',
      saldoTotal: '9.00',
    });
  });

  it('el caché de saldo es por dirección: no cruza a otra persona', async () => {
    const ana = await persona();
    const beto = await persona();
    cadena.saldos.set(ana.direccion, 3n * URC);
    cadena.saldos.set(beto.direccion, 4n * URC);
    await b.saldo(ana.token).expect(200);
    expect((await b.saldo(beto.token).expect(200)).body.saldoDisponible).toBe(
      '4.00',
    );
  });
});
