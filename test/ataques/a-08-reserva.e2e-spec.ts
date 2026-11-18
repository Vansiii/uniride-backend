import { randomUUID } from 'node:crypto';
import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { firmar } from '../billetera/ayudas-billetera.js';
import {
  ayudasReservas,
  rutaReservar,
  type Persona,
} from '../reservas/ayudas-reservas.js';

/**
 * HU-19 CA-6, CA-7 · A-08 y A-11: con una sesión válida, reservar sin la firma biométrica del teléfono vinculado
 * no crea nada, y lo que el cliente diga del monto, el conductor o el estado no cuenta.
 */
describe('A-08 / A-11 · reservar sin la firma del teléfono (e2e)', () => {
  let e: Entorno;
  const r = ayudasReservas(() => e);
  let org: string;
  let viajeId: string;
  let conductorId: string;

  beforeAll(async () => {
    e = await prepararEntorno();
    org = (await r.v.organizacion('Reservas A08')).id;
  });
  beforeEach(async () => {
    await r.preparar();
    const c = await r.conductor(org);
    conductorId = c.id;
    viajeId = await r.publicar(c);
  });
  afterAll(async () => {
    await e.cerrar();
  });

  const enviar = (
    p: Persona,
    cuerpo: object = { claveIdempotencia: randomUUID() },
  ) =>
    e.api().post(rutaReservar(viajeId)).set(r.b.conToken(p.token)).send(cuerpo);
  const nadaCambio = async (p: Persona) => {
    expect(await r.huella(p.id)).toEqual({ reservas: 0, bloqueos: 0 });
    expect((await r.viaje(viajeId)).cupos_disponibles).toBe(3);
  };

  describe('CA-6 · sin la firma válida del teléfono vinculado', () => {
    it('sin firma: 401 FIRMA_DISPOSITIVO_INVALIDA y no reserva nada', async () => {
      const p = await r.pasajero(org);
      const res = await enviar(p);
      expect(res.status).toBe(401);
      expect(res.body.codigo).toBe('FIRMA_DISPOSITIVO_INVALIDA');
      await nadaCambio(p);
    });

    it('sin sesión, aunque la firma sea válida: 401', async () => {
      const p = await r.pasajero(org);
      const cuerpo = { claveIdempotencia: randomUUID() };
      await e
        .api()
        .post(rutaReservar(viajeId))
        .set(
          firmar(
            'POST',
            rutaReservar(viajeId),
            p.dispositivo,
            JSON.stringify(cuerpo),
          ),
        )
        .send(cuerpo)
        .expect(401);
      await nadaCambio(p);
    });

    it('sin teléfono vinculado: 401', async () => {
      const p = await r.pasajero(org);
      await e.bd.query(`DELETE FROM dispositivos WHERE usuario_id = $1`, [
        p.id,
      ]);
      await r.reservar(p, viajeId).expect(401);
      await nadaCambio(p);
    });

    it('el teléfono de otra persona con mi sesión (A-04): 401', async () => {
      const p = await r.pasajero(org);
      const otra = await r.pasajero(org);
      const cuerpo = { claveIdempotencia: randomUUID() };
      const res = await enviar(p, cuerpo).set(
        firmar(
          'POST',
          rutaReservar(viajeId),
          otra.dispositivo,
          JSON.stringify(cuerpo),
        ),
      );
      expect(res.status).toBe(401);
      expect(res.body.codigo).toBe('FIRMA_DISPOSITIVO_INVALIDA');
      await nadaCambio(p);
      await nadaCambio(otra);
    });

    it('la llave de otra persona con el id de mi teléfono: 401', async () => {
      const p = await r.pasajero(org);
      const otra = await r.pasajero(org);
      const cuerpo = { claveIdempotencia: randomUUID() };
      const res = await enviar(p, cuerpo).set(
        firmar(
          'POST',
          rutaReservar(viajeId),
          { id: p.dispositivo.id, llave: otra.dispositivo.llave },
          JSON.stringify(cuerpo),
        ),
      );
      expect(res.status).toBe(401);
      await nadaCambio(p);
    });

    it('una firma de otro cuerpo no sirve: no se puede cambiar la clave después de firmar', async () => {
      const p = await r.pasajero(org);
      const firmado = { claveIdempotencia: randomUUID() };
      const res = await enviar(p, { claveIdempotencia: randomUUID() }).set(
        firmar(
          'POST',
          rutaReservar(viajeId),
          p.dispositivo,
          JSON.stringify(firmado),
        ),
      );
      expect(res.status).toBe(401);
      await nadaCambio(p);
    });

    it('una firma de otro viaje no sirve: la ruta va dentro del mensaje firmado', async () => {
      const p = await r.pasajero(org);
      const cuerpo = { claveIdempotencia: randomUUID() };
      const res = await enviar(p, cuerpo).set(
        firmar(
          'POST',
          rutaReservar(randomUUID()),
          p.dispositivo,
          JSON.stringify(cuerpo),
        ),
      );
      expect(res.status).toBe(401);
      await nadaCambio(p);
    });

    it('la misma petición firmada repetida palabra por palabra: 401 PETICION_EXPIRADA y una sola reserva', async () => {
      const p = await r.pasajero(org);
      const cuerpo = { claveIdempotencia: randomUUID() };
      const firma = firmar(
        'POST',
        rutaReservar(viajeId),
        p.dispositivo,
        JSON.stringify(cuerpo),
      );
      await enviar(p, cuerpo).set(firma).expect(201);
      const repetida = await enviar(p, cuerpo).set(firma);
      expect(repetida.status).toBe(401);
      expect(repetida.body.codigo).toBe('PETICION_EXPIRADA');
      expect(await r.huella(p.id)).toEqual({ reservas: 1, bloqueos: 1 });
    });

    it('un rechazo por otro motivo no gasta la firma: con la cuenta suspendida, 403 antes que 401', async () => {
      const p = await r.pasajero(org);
      await e.bd.query(
        `UPDATE usuarios SET suspendida_en = now() WHERE id = $1`,
        [p.id],
      );
      const res = await r.reservar(p, viajeId).expect(403);
      expect(res.body.codigo).toBe('CUENTA_SUSPENDIDA');
      await nadaCambio(p);
    });
  });

  describe('CA-7 · monto, conductor y estado los fija el servidor', () => {
    it.each([
      ['monto', { monto: 0.02 }],
      ['precio', { precioPorAsiento: 0.02 }],
      ['conductor', { conductorId: randomUUID() }],
      ['pasajero', { pasajeroId: randomUUID() }],
      ['estado', { estado: 'confirmada' }],
      ['organización', { organizacionId: randomUUID() }],
      ['viaje', { viajeId: randomUUID() }],
    ])(
      'un %s en el cuerpo se rechaza y no se reserva nada',
      async (_, extra) => {
        const p = await r.pasajero(org);
        const res = await r.reservar(p, viajeId, randomUUID(), extra);
        expect(res.status).toBe(400);
        expect(res.body.codigo).toBe('VALIDACION_FALLIDA');
        await nadaCambio(p);
      },
    );

    it('la reserva cobra el precio publicado del viaje y paga a su conductor, no a quien diga el cliente', async () => {
      const p = await r.pasajero(org);
      const { body } = await r.reservar(p, viajeId).expect(201);
      expect(body.monto).toBe('10.50');
      expect(body.estado).toBe('pendiente');
      await r.procesar();
      const [fila] = await r.filasReserva(viajeId);
      expect(fila).toMatchObject({
        monto: '10.50',
        pasajero_id: p.id,
        estado: 'confirmada',
      });
      const { rows } = await e.bd.query(
        `SELECT c.usuario_id FROM reservas rs JOIN viajes v ON v.id = rs.viaje_id
         JOIN billeteras c ON c.usuario_id = v.conductor_id WHERE rs.id = $1`,
        [fila.id],
      );
      expect(rows[0].usuario_id).toBe(conductorId);
    });
  });

  describe('A-11 · la voz no es un camino', () => {
    it('no existe ninguna ruta de reserva distinta de la firmada', async () => {
      const p = await r.pasajero(org);
      for (const ruta of [
        `/api/v1/voz/reservar`,
        `/api/v1/reservas`,
        `/api/v1/viajes/${viajeId}/reservar`,
      ])
        await e
          .api()
          .post(ruta)
          .set(r.b.conToken(p.token))
          .send({ claveIdempotencia: randomUUID() })
          .expect(404);
      await nadaCambio(p);
    });
  });
});
