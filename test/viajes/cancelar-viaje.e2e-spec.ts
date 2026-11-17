import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasReservas } from '../reservas/ayudas-reservas.js';
import { enMs, HORA_MS } from './ayudas-viajes.js';

describe('HU-20 CA-5 · Cancelación de viaje por el conductor (e2e)', () => {
  let e: Entorno;
  const r = ayudasReservas(() => e);
  let org: string;

  beforeAll(async () => {
    e = await prepararEntorno();
    org = (await r.v.organizacion('CancelarViaje')).id;
  });

  beforeEach(() => r.preparar());

  afterAll(async () => {
    await e?.cerrar();
  });

  it('cancela viaje reservado, cancela reservas confirmadas al 100 %, encola reembolsos y correos', async () => {
    const c = await r.conductor(org);
    const viajeId = await r.publicar(c, {
      fechaHoraSalida: enMs(HORA_MS),
      precioPorAsiento: '12.00',
      cuposTotales: 3,
    });

    const p1 = await r.pasajero(org, '50.00');
    const p2 = await r.pasajero(org, '50.00');

    const res1 = await r.reservar(p1, viajeId).expect(201);
    const res2 = await r.reservar(p2, viajeId).expect(201);

    // Confirmar reservas en cadena simulada
    await r.procesar();

    // Conductor cancela viaje
    const resCancela = await r.cancelarViaje(c, viajeId).expect(200);
    expect(resCancela.body).toEqual({
      estado: 'cancelado',
      reservasCanceladas: 2,
    });

    // Estado del viaje en base de datos
    expect((await r.viaje(viajeId)).estado).toBe('cancelado');

    // Procesar worker para efectivizar reembolsos
    await r.procesar();

    // Verificar reembolsos de ambas reservas
    for (const rId of [res1.body.reservaId, res2.body.reservaId]) {
      const movs = await r.movimientosDeReserva(rId);
      const reembolso = movs.find((m) => m.tipo === 'reembolso_reserva');
      expect(reembolso).toMatchObject({
        estado: 'confirmado',
        monto: '12.00',
      });
    }

    // Verificar correos encolados
    const { rows: correos } = await e.bd.query(
      `SELECT plantilla, destinatario FROM correos_pendientes WHERE plantilla = 'viaje_cancelado'`,
    );
    expect(correos).toHaveLength(2);

    // Auditoría registrada
    const { rows: auditoriaViaje } = await e.bd.query(
      `SELECT accion, resultado, actor_id FROM registros_auditoria WHERE entidad = 'viaje' AND entidad_id = $1`,
      [viajeId],
    );
    expect(auditoriaViaje).toContainEqual(
      expect.objectContaining({
        accion: 'viaje.cancelado',
        resultado: 'ok',
        actor_id: c.id,
      }),
    );
  });

  it('idempotencia: cancelar un viaje ya cancelado devuelve 200 sin efectos secundarios', async () => {
    const c = await r.conductor(org);
    const viajeId = await r.publicar(c, { fechaHoraSalida: enMs(HORA_MS) });

    await r.cancelarViaje(c, viajeId).expect(200);
    const rep = await r.cancelarViaje(c, viajeId).expect(200);
    expect(rep.body).toEqual({
      estado: 'cancelado',
      reservasCanceladas: 0,
    });
  });

  it('rechaza cancelar un viaje si ya tiene pasajeros abordados o en curso (CA-11)', async () => {
    const c = await r.conductor(org);
    const viajeId = await r.publicar(c, { fechaHoraSalida: enMs(HORA_MS) });

    // Modificar estado del viaje a 'en_curso'
    await e.bd.query(`UPDATE viajes SET estado = 'en_curso' WHERE id = $1`, [
      viajeId,
    ]);

    const res = await r.cancelarViaje(c, viajeId).expect(409);
    expect(res.body.codigo).toBe('NO_CANCELABLE');
  });
});
