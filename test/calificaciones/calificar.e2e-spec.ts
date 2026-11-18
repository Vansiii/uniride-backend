import {
  DOMINIO,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import { ayudasCalificaciones } from './ayudas-calificaciones.js';

/** HU-21: calificación mutua de reservas pagadas. */
describe('HU-21 · calificación mutua (e2e)', () => {
  let e: Entorno;
  const a = ayudasCalificaciones(() => e);
  let org: Awaited<ReturnType<typeof organizacionConAdmin>>;

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    org = await organizacionConAdmin(
      e,
      await e.iniciar(`super${DOMINIO}`),
      'Calificaciones A',
    );
  });
  beforeEach(() => a.f.r.preparar());
  afterAll(() => e.cerrar());

  const par = async () => ({
    c: await a.f.persona(org.id),
    p: await a.f.persona(org.id),
  });

  it('CA-1, CA-2: el pasajero califica al conductor y el conductor al pasajero', async () => {
    const { c, p } = await par();
    const r = await a.reserva(org.id, c, p);
    expect((await a.estado(p.token, r).expect(200)).body).toMatchObject({
      puedoCalificar: true,
    });
    const hecha = await a
      .calificar(p.token, r, { estrellas: 4, comentario: 'Puntual' })
      .expect(201);
    expect(hecha.body.id).toBeTruthy();
    await a.calificar(c.token, r, { estrellas: 5 }).expect(201);
    const filas = await a.filas(r);
    expect(filas).toHaveLength(2);
    expect(filas).toContainEqual(
      expect.objectContaining({
        autor_id: p.id,
        destinatario_id: c.id,
        estrellas: 4,
        comentario: 'Puntual',
      }),
    );
    expect(filas).toContainEqual(
      expect.objectContaining({ autor_id: c.id, destinatario_id: p.id }),
    );
  });

  it('CA-3: calificar otra vez se rechaza y no cambia ni duplica', async () => {
    const { c, p } = await par();
    const r = await a.reserva(org.id, c, p);
    await a.calificar(p.token, r, { estrellas: 2 }).expect(201);
    const otra = await a.calificar(p.token, r, { estrellas: 5 }).expect(409);
    expect(otra.body.codigo).toBe('YA_CALIFICADA');
    const filas = await a.filas(r);
    expect(filas).toHaveLength(1);
    expect(filas[0].estrellas).toBe(2);
  });

  it('CA-12: dos envíos a la vez dejan una sola calificación', async () => {
    const { c, p } = await par();
    const r = await a.reserva(org.id, c, p);
    const res = await Promise.all([
      a.calificar(p.token, r, { estrellas: 3 }),
      a.calificar(p.token, r, { estrellas: 3 }),
    ]);
    expect(res.map((x) => x.status).sort()).toEqual([201, 409]);
    expect(await a.filas(r)).toHaveLength(1);
  });

  it('CA-4: el plazo de 7 días es inclusivo en el borde y vence después', async () => {
    const { c, p } = await par();
    const dentro = await a.reserva(org.id, c, p, 6.99);
    await a.calificar(p.token, dentro).expect(201);
    const fuera = await a.reserva(org.id, c, p, 7.01);
    const r = await a.calificar(p.token, fuera).expect(409);
    expect(r.body.codigo).toBe('PLAZO_VENCIDO');
    expect(await a.filas(fuera)).toHaveLength(0);
  });

  it('CA-5: una reserva que no está pagada no se califica', async () => {
    const { c, p } = await par();
    const r = await a.reserva(org.id, c, p, 1, 'verificacion_fallida');
    const res = await a.calificar(p.token, r).expect(409);
    expect(res.body.codigo).toBe('RESERVA_NO_PAGADA');
    expect(await a.filas(r)).toHaveLength(0);
  });

  it('validación: estrellas de 1 a 5 y comentario de hasta 140', async () => {
    const { c, p } = await par();
    const r = await a.reserva(org.id, c, p);
    for (const cuerpo of [
      { estrellas: 0 },
      { estrellas: 6 },
      { estrellas: 3.5 },
      {},
      { estrellas: 4, comentario: 'x'.repeat(141) },
    ])
      await a.calificar(p.token, r, cuerpo).expect(400);
    await a
      .calificar(p.token, r, { estrellas: 4, comentario: 'x'.repeat(140) })
      .expect(201);
  });

  it('CA-7: calificación ciega; se revela al calificar o al vencer el plazo', async () => {
    const { c, p } = await par();
    const r = await a.reserva(org.id, c, p);
    await a
      .calificar(c.token, r, { estrellas: 1, comentario: 'Tarde' })
      .expect(201);
    const antes = (await a.estado(p.token, r).expect(200)).body;
    expect(antes.recibida).toBeUndefined();
    await a.calificar(p.token, r, { estrellas: 5 }).expect(201);
    const despues = (await a.estado(p.token, r).expect(200)).body;
    expect(despues.recibida).toEqual({ estrellas: 1, comentario: 'Tarde' });
    const { c: c2, p: p2 } = await par();
    const vencida = await a.reserva(org.id, c2, p2, 7.5);
    await e.bd.query(
      `INSERT INTO calificaciones (organizacion_id, reserva_id, autor_id, destinatario_id, estrellas, comentario)
       VALUES ($1, $2, $3, $4, 2, 'Regular')`,
      [org.id, vencida, c2.id, p2.id],
    );
    const ve = (await a.estado(p2.token, vencida).expect(200)).body;
    expect(ve.puedoCalificar).toBe(false);
    expect(ve.recibida).toEqual({ estrellas: 2, comentario: 'Regular' });
  });

  it('CA-6, CA-11: con menos de 3 calificaciones es «Nuevo»; desde 3, promedio con 1 decimal y sin autor ni comentario', async () => {
    const c = await a.f.persona(org.id);
    const comentarios = ['uno', 'dos', 'tres'];
    const estrellas = [5, 4, 4];
    // A 6 h de la salida temporal (+1 h) que usan las ayudas, para no solaparse con ella.
    const salida = new Date(Date.now() + 6 * 3_600_000).toISOString();
    const viajeId = await a.f.r.publicar(c, { fechaHoraSalida: salida });
    const buscar = async () => {
      const lector = await a.f.persona(org.id);
      const r = await e
        .api()
        .get('/api/v1/viajes/buscar')
        .set({ Authorization: `Bearer ${lector.token}` })
        .query({
          origenLat: -17.783327,
          origenLng: -63.182129,
          horaSalida: salida,
        })
        .expect(200);
      return (
        r.body as { id: string; conductor: Record<string, unknown> }[]
      ).find((x) => x.id === viajeId)!.conductor;
    };
    for (let i = 0; i < 3; i++) {
      const p = await a.f.persona(org.id);
      const r = await a.reserva(org.id, c, p);
      await a
        .calificar(p.token, r, {
          estrellas: estrellas[i],
          comentario: comentarios[i],
        })
        .expect(201);
      const conductor = await buscar();
      if (i < 2) {
        expect(conductor).toMatchObject({
          calificacionPromedio: null,
          esNuevo: true,
          calificaciones: i + 1,
        });
      } else {
        expect(conductor).toMatchObject({
          calificacionPromedio: 4.3,
          esNuevo: false,
          calificaciones: 3,
        });
        const texto = JSON.stringify(conductor);
        for (const palabra of comentarios) expect(texto).not.toContain(palabra);
        expect(texto).not.toContain(p.id);
      }
    }
  });

  it('CA-4 (servicio): la fecha de pago manda, no la de la reserva', async () => {
    const { c, p } = await par();
    const r = await a.reserva(org.id, c, p, 3);
    const estado = (await a.estado(p.token, r).expect(200)).body;
    const fin = new Date(estado.plazoHasta).getTime();
    expect(Math.abs(fin - (Date.now() + 4 * 86_400_000))).toBeLessThan(60_000);
  });
});
