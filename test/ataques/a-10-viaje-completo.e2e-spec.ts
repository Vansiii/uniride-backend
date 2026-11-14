import { CadenaSimulada } from '../../src/blockchain/blockchain.service.js';
import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasPresencia } from '../presencia/ayudas-presencia.js';
import type { Persona } from '../reservas/ayudas-reservas.js';

/** HU-24 CA-7 · A-10: un viaje pagado mueve el pasaje del pasajero al conductor; el total no cambia. */
describe('A-10 · el viaje completo no crea saldo (e2e)', () => {
  let e: Entorno;
  const h = ayudasPresencia(() => e);
  const r = h.r;
  let org: string;

  beforeAll(async () => {
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno();
    org = (await r.v.organizacion('Viaje A10')).id;
  });
  beforeEach(() => r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  /** En la cadena: pasajeros + conductor + escrow. */
  const totalCadena = async (personas: Persona[]) => {
    let total = await r.cadena().leerSaldo(CadenaSimulada.ESCROW);
    for (const p of personas) total += await r.cadena().leerSaldo(p.direccion);
    return total;
  };
  /** En la API: saldo total (disponible + en garantía) de cada uno. */
  const totalApi = async (personas: Persona[]) => {
    let centavos = 0;
    for (const p of personas)
      centavos += Math.round(
        Number((await r.saldo(p).expect(200)).body.saldoTotal) * 100,
      );
    return centavos;
  };

  it('CA-7: pasajeros, conductor y garantía suman lo mismo antes de reservar y después de pagar, en la cadena y en la API', async () => {
    const conductor = await r.conductor(org);
    const pasajeros = [await r.pasajero(org), await r.pasajero(org)];
    const todos = [conductor, ...pasajeros];
    const antes = {
      cadena: await totalCadena(todos),
      api: await totalApi(todos),
    };
    expect(antes.api).toBe(10_000);

    // El mismo viaje de punta a punta, con estas personas ya creadas.
    const v = await h.verificado(org, 2, { conductor, pasajeros });
    await r.procesar();
    expect(await h.estadoViaje(v.s.viajeId)).toBe('pagado');

    expect(await totalCadena(todos)).toBe(antes.cadena);
    expect(await totalApi(todos)).toBe(antes.api);
    expect(await r.cadena().leerSaldo(CadenaSimulada.ESCROW)).toBe(0n);
    expect(
      Math.round(
        Number((await r.saldo(conductor).expect(200)).body.saldoTotal) * 100,
      ),
    ).toBe(2_100);
  });
});
