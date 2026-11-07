import { randomUUID } from 'node:crypto';
import { MovimientosService } from '../../src/billetera/movimientos.service.js';
import {
  DOMINIO,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import {
  ayudasBilletera,
  HASH,
  RUTA_MOVIMIENTOS,
  type CadenaControlable,
} from './ayudas-billetera.js';

describe('HU-14 · historial de movimientos (e2e)', () => {
  let e: Entorno;
  let cadena: CadenaControlable;
  const b = ayudasBilletera(() => e);
  let n = 0;

  const usuario = (estado?: string | null) =>
    b.persona(`movimientos${++n}${DOMINIO}`, estado);
  const conBilletera = async () => {
    const u = await usuario();
    return { ...u, ...(await b.billetera(u.id)) };
  };
  const hace = (dias: number) => new Date(Date.now() - dias * 86_400_000);

  beforeAll(async () => {
    e = await prepararEntorno();
  });
  beforeEach(() => {
    cadena = b.preparar();
  });
  afterAll(async () => {
    await e.cerrar();
  });

  describe('CA-2: lista con todos sus datos', () => {
    it('cronología inversa, con tipo, monto, fecha, estado y enlace; sin metadatos internos', async () => {
      const u = await conBilletera();
      cadena.explorador = 'https://explorador.test';
      const antiguo = await b.asiento(u.billetera, { creadoEn: hace(2) });
      const reciente = await b.asiento(u.billetera, {
        monto: '10.50',
        creadoEn: hace(0),
      });
      const medio = await b.asiento(u.billetera, {
        tipo: 'bloqueo_reserva',
        reservaId: randomUUID(),
        creadoEn: hace(1),
      });

      const r = await b.movimientos(u.token).expect(200);
      expect(r.body).toMatchObject({ total: 3, pagina: 1, paginas: 1 });
      expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([
        reciente,
        medio,
        antiguo,
      ]);
      expect(r.body.items[0]).toEqual({
        id: reciente,
        tipo: 'recarga',
        monto: '10.50',
        estado: 'confirmado',
        hashTx: HASH,
        exploradorUrl: `https://explorador.test/tx/${HASH}`,
        creadoEn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:/),
      });
    });

    it('historial vacío: 200 con lista vacía', async () => {
      const u = await conBilletera();
      const r = await b.movimientos(u.token).expect(200);
      expect(r.body).toEqual({ items: [], total: 0, pagina: 1, paginas: 0 });
    });

    it('filtra por uno o varios tipos', async () => {
      const u = await conBilletera();
      const reservaId = randomUUID();
      await b.asiento(u.billetera);
      await b.asiento(u.billetera, { tipo: 'bloqueo_reserva', reservaId });
      await b.asiento(u.billetera, { tipo: 'reembolso_reserva', reservaId });

      const uno = await b.movimientos(u.token, { tipo: 'recarga' }).expect(200);
      expect(uno.body.total).toBe(1);
      const varios = await b
        .movimientos(u.token, { tipo: 'recarga,reembolso_reserva' })
        .expect(200);
      expect(
        varios.body.items.map((i: { tipo: string }) => i.tipo).sort(),
      ).toEqual(['recarga', 'reembolso_reserva']);
    });

    it.each([
      [{ tipo: 'retiro' }],
      [{ tipo: '' }],
      [{ pagina: 0 }],
      [{ pagina: 'x' }],
      [{ pagina: 999999999999 }],
      [{ limite: 0 }],
      [{ limite: 101 }],
    ])('%j: 400 VALIDACION_FALLIDA', async (consulta) => {
      const u = await conBilletera();
      const r = await b.movimientos(u.token, consulta).expect(400);
      expect(r.body.codigo).toBe('VALIDACION_FALLIDA');
    });
  });

  it('CA-3: una transacción en minado sale pendiente, sin hash ni enlace, y al confirmarse los muestra', async () => {
    const u = await conBilletera();
    cadena.explorador = 'https://explorador.test';
    const servicio = e.app.get(MovimientosService, { strict: false });
    const { movimiento } = await servicio.registrar({
      billeteraId: u.billetera,
      tipo: 'recarga',
      monto: '20.00',
      claveIdempotencia: randomUUID(),
    });

    const pendiente = await b.movimientos(u.token).expect(200);
    expect(pendiente.body.items[0]).toMatchObject({
      id: movimiento.id,
      estado: 'pendiente',
      hashTx: null,
      exploradorUrl: null,
    });
    // No congela el saldo no comprometido: el pendiente no entra en la cuenta.
    expect((await b.saldo(u.token).expect(200)).body).toMatchObject({
      saldoBloqueadoEscrow: '0.00',
      enLinea: true,
    });

    // Con el rol real de la API: el GRANT de columnas permite este UPDATE.
    await servicio.actualizarEstado(movimiento.id, 'confirmado', HASH);
    const confirmado = await b.movimientos(u.token).expect(200);
    expect(confirmado.body.items[0]).toMatchObject({
      estado: 'confirmado',
      hashTx: HASH,
      exploradorUrl: `https://explorador.test/tx/${HASH}`,
    });
  });

  it('CA-5: más de 20 movimientos se recorren por páginas, sin repetir ni saltar', async () => {
    const u = await conBilletera();
    // Misma fecha a propósito: el orden tiene que ser estable también en el empate.
    const creadoEn = hace(1);
    const ids: string[] = [];
    for (let i = 0; i < 45; i++)
      ids.push(await b.asiento(u.billetera, { creadoEn }));

    const primera = await b.movimientos(u.token).expect(200);
    expect(primera.body).toMatchObject({ total: 45, pagina: 1, paginas: 3 });
    expect(primera.body.items.length).toBe(20);

    const vistos = [...primera.body.items];
    for (const pagina of [2, 3]) {
      const r = await b.movimientos(u.token, { pagina }).expect(200);
      expect(r.body.pagina).toBe(pagina);
      vistos.push(...r.body.items);
    }
    expect(vistos.length).toBe(45);
    expect(new Set(vistos.map((i: { id: string }) => i.id))).toEqual(
      new Set(ids),
    );

    const corta = await b.movimientos(u.token, { limite: 5 }).expect(200);
    expect(corta.body).toMatchObject({ paginas: 9 });
    expect(corta.body.items.length).toBe(5);
    const lejos = await b.movimientos(u.token, { pagina: 4 }).expect(200);
    expect(lejos.body.items).toEqual([]);
  });

  describe('CA-6 y guards', () => {
    it('verificada sin billetera: 404 BILLETERA_NO_ENCONTRADA', async () => {
      const u = await usuario();
      const r = await b.movimientos(u.token).expect(404);
      expect(r.body.codigo).toBe('BILLETERA_NO_ENCONTRADA');
    });

    it('sin verificar: 403 IDENTIDAD_NO_VERIFICADA', async () => {
      const u = await usuario('en_revision');
      const r = await b.movimientos(u.token).expect(403);
      expect(r.body.codigo).toBe('IDENTIDAD_NO_VERIFICADA');
    });

    it('suspendida: 403 CUENTA_SUSPENDIDA', async () => {
      const u = await conBilletera();
      await e.bd.query(
        `UPDATE usuarios SET suspendida_en = now() WHERE id = $1`,
        [u.id],
      );
      const r = await b.movimientos(u.token).expect(403);
      expect(r.body.codigo).toBe('CUENTA_SUSPENDIDA');
    });

    it('sin token: 401 NO_AUTENTICADO', async () => {
      const r = await e.api().get(RUTA_MOVIMIENTOS).expect(401);
      expect(r.body.codigo).toBe('NO_AUTENTICADO');
    });
  });
});
