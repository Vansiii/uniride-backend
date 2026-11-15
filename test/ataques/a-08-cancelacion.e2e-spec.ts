import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { enMs } from '../viajes/ayudas-viajes.js';
import { ayudasReservas } from '../reservas/ayudas-reservas.js';
import { firmar } from '../billetera/ayudas-billetera.js';

describe('Ataque A-08 · Cancelación con datos alterados por el cliente (e2e)', () => {
  let e: Entorno;
  const r = ayudasReservas(() => e);
  let org: string;

  beforeAll(async () => {
    e = await prepararEntorno();
    org = (await r.v.organizacion('AtaqueA08Cancelacion')).id;
  });

  beforeEach(() => r.preparar());

  afterAll(async () => {
    await e?.cerrar();
  });

  it('A-08 · el cliente no puede forzar 100 % cuando la política del servidor dicta 50 %', async () => {
    const c = await r.conductor(org);
    // Salida en 10 minutos (<= 30 min -> aplica 50 %)
    const viajeId = await r.publicar(c, {
      fechaHoraSalida: enMs(10 * 60 * 1000),
      precioPorAsiento: '10.00',
    });
    const p = await r.pasajero(org, '50.00');
    const res = await r.reservar(p, viajeId).expect(201);
    const reservaId = res.body.reservaId as string;
    await r.procesar();

    // Cliente malicioso intenta enviar porcentajeEsperado: 100
    const cancelRes = await r.cancelarReserva(p, reservaId, 100).expect(409);

    expect(cancelRes.body.error).toBe('POLITICA_CAMBIO');
    expect(cancelRes.body.detalles.cancelacion.porcentajePasajero).toBe(50);
  });

  it('A-08 · el cliente no puede inyectar campos no permitidos (monto, estado) en el cuerpo', async () => {
    const c = await r.conductor(org);
    const viajeId = await r.publicar(c, {
      fechaHoraSalida: enMs(60 * 60 * 1000),
      precioPorAsiento: '10.00',
    });
    const p = await r.pasajero(org, '50.00');
    const res = await r.reservar(p, viajeId).expect(201);
    const reservaId = res.body.reservaId as string;
    await r.procesar();

    const cuerpoInvalido = {
      porcentajeEsperado: 100,
      monto: '1000.00',
      estado: 'pagada',
    };
    const ruta = r.rutaCancelarReserva(reservaId);

    // ValidationPipe con whitelist o forbidenNonWhitelisted debe rechazar campos extra
    await e()
      .api()
      .post(ruta)
      .set(r.b.conToken(p.token))
      .set(firmar('POST', ruta, p.dispositivo, JSON.stringify(cuerpoInvalido)))
      .send(cuerpoInvalido)
      .expect(400);
  });
});
