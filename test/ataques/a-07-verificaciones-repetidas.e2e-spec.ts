import { PrismaService } from '../../src/comun/prisma.service.js';
import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasFraude, HORA_MS } from '../fraude/ayudas-fraude.js';
import { cuerpoViaje } from '../viajes/ayudas-viajes.js';
import { rutasRegistradas } from './catalogo-rutas.js';
import pg from 'pg';

/** HU-25 CA-4, CA-6, CA-7, CA-12 · A-07 y A-08: insistir en falsificar el GPS bloquea la cuenta y nadie la desbloquea. */
describe('A-07 · verificaciones fallidas repetidas (e2e)', () => {
  let e: Entorno;
  const f = ayudasFraude(() => e);
  let org: string;
  const hace = (ms: number) => new Date(Date.now() - ms);

  beforeAll(async () => {
    e = await prepararEntorno();
    org = (await f.r.v.organizacion('Fraude A07')).id;
  });
  beforeEach(() => f.r.preparar());
  afterAll(async () => {
    await e.cerrar();
  });

  /** Una persona con 3 verificaciones fallidas en 7 días con conductores distintos, y una reserva previa confirmada. */
  const bloqueada = async () => {
    const p = await f.persona(org);
    const previa = await f.r.publicar(await f.persona(org));
    const { reservaId } = (await f.r.reservar(p, previa).expect(201)).body;
    await f.r.procesar();
    for (const h of [30, 20, 2])
      await f.viajeNormal(
        org,
        await f.persona(org),
        p,
        hace(h * HORA_MS),
        'verificacion_fallida',
      );
    await f.tic();
    expect(await f.bloqueos(p.id)).toHaveLength(1);
    return { p, reservaId };
  };

  it('A-07: con el bloqueo, publicar, reservar y recargar se rechazan con la fecha de fin', async () => {
    const { p } = await bloqueada();
    const otro = await f.r.publicar(await f.persona(org));

    const reservar = await f.r.reservar(p, otro).expect(403);
    expect(reservar.body.codigo).toBe('BLOQUEO_PREVENTIVO');
    expect(new Date(reservar.body.hasta).getTime()).toBeGreaterThan(Date.now());

    expect(
      (await f.r.v.publicar(p, cuerpoViaje()).expect(403)).body.codigo,
    ).toBe('BLOQUEO_PREVENTIVO');
    expect(
      (await f.r.b.crearRecarga(p.token, 20).expect(403)).body.codigo,
    ).toBe('BLOQUEO_PREVENTIVO');
    // Nada se movió.
    expect((await f.r.viaje(otro)).cupos_disponibles).toBe(3);
  });

  it('A-07: lo ya reservado sigue disponible: consultar saldo y reserva, y cancelar', async () => {
    const { p, reservaId } = await bloqueada();
    await f.r.saldo(p).expect(200);
    await f.r.reserva(p.token, reservaId).expect(200);
    await f.r.mias(p.token).expect(200);
    await f.r.cancelarReserva(p, reservaId, 100).expect(200);
  });

  it('A-07: el conductor con bloqueo de cuenta deja de aparecer para reservar (como una cuenta suspendida)', async () => {
    const c = await f.persona(org);
    const viajeId = await f.r.publicar(c);
    const pasajero = await f.persona(org);
    const { reservaId } = await f.viajeNormal(
      org,
      await f.persona(org),
      pasajero,
      hace(HORA_MS),
    );
    await e.bd.query(
      `INSERT INTO bloqueos_preventivos (tipo, usuario_id, patron, reserva_id, vence_en)
       VALUES ('cuenta', $1, 'verificaciones_fallidas', $2, now() + interval '1 day')
       ON CONFLICT DO NOTHING`,
      [c.id, reservaId],
    );
    const rechazo = await f.r.reservar(pasajero, viajeId).expect(409);
    expect(rechazo.body.codigo).toBe('VIAJE_NO_DISPONIBLE');
  });

  it('A-08: ninguna ruta de la API toca los bloqueos y el rol de la API no puede cambiarlos ni borrarlos', async () => {
    const rutas = rutasRegistradas(e.app).map((r) => r.clave.toLowerCase());
    expect(rutas.filter((r) => r.includes('bloqueo'))).toEqual([]);

    const { p } = await bloqueada();
    const api = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await api.connect();
    try {
      await expect(
        api.query(
          `UPDATE bloqueos_preventivos SET vence_en = now() WHERE usuario_id = $1`,
          [p.id],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        api.query(`DELETE FROM bloqueos_preventivos WHERE usuario_id = $1`, [
          p.id,
        ]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await api.end();
    }
    expect(e.app.get(PrismaService)).toBeDefined();
    expect(await f.bloqueos(p.id)).toHaveLength(1);
  });
});
