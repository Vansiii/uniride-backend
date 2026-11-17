import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { enMs } from '../viajes/ayudas-viajes.js';
import { ayudasReservas } from '../reservas/ayudas-reservas.js';

describe('Ataque A-13 · Aislamiento multi-organización y por usuario en cancelaciones (e2e)', () => {
  let e: Entorno;
  const r = ayudasReservas(() => e);
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    e = await prepararEntorno();
    orgA = (await r.v.organizacion('OrgA-Cancelacion')).id;
    orgB = (await r.v.organizacion('OrgB-Cancelacion')).id;
  });

  beforeEach(() => r.preparar());

  afterAll(async () => {
    await e?.cerrar();
  });

  it('A-13 · un pasajero no puede cancelar la reserva de otro pasajero de su misma organización', async () => {
    const c = await r.conductor(orgA);
    const viajeId = await r.publicar(c, {
      fechaHoraSalida: enMs(60 * 60 * 1000),
    });
    const p1 = await r.pasajero(orgA, '50.00');
    const p2 = await r.pasajero(orgA, '50.00');

    const res1 = await r.reservar(p1, viajeId).expect(201);
    await r.procesar();

    // p2 intenta cancelar la reserva de p1
    await r.cancelarReserva(p2, res1.body.reservaId, 100).expect(404);
  });

  it('A-13 · un conductor no puede cancelar el viaje de otro conductor', async () => {
    const c1 = await r.conductor(orgA);
    const c2 = await r.conductor(orgA);
    const viajeId = await r.publicar(c1, {
      fechaHoraSalida: enMs(60 * 60 * 1000),
    });

    // c2 intenta cancelar el viaje de c1
    await r.cancelarViaje(c2, viajeId).expect(404);
  });

  it('A-13 · un usuario de orgB no puede cancelar reserva de orgA aunque conozca su ID', async () => {
    const c = await r.conductor(orgA);
    const viajeId = await r.publicar(c, {
      fechaHoraSalida: enMs(60 * 60 * 1000),
    });
    const pA = await r.pasajero(orgA, '50.00');
    const pB = await r.pasajero(orgB, '50.00');

    const res = await r.reservar(pA, viajeId).expect(201);
    await r.procesar();

    // pB (de orgB) intenta cancelar la reserva de orgA
    await r.cancelarReserva(pB, res.body.reservaId, 100).expect(404);
  });

  it('A-13 · un conductor de orgB no puede cancelar viaje de orgA', async () => {
    const cA = await r.conductor(orgA);
    const cB = await r.conductor(orgB);
    const viajeId = await r.publicar(cA, {
      fechaHoraSalida: enMs(60 * 60 * 1000),
    });

    await r.cancelarViaje(cB, viajeId).expect(404);
  });
});
