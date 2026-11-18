import {
  DOMINIO,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import { ayudasCalificaciones } from '../calificaciones/ayudas-calificaciones.js';
import { DIA_MS } from '../fraude/ayudas-fraude.js';

/** HU-21 CA-10 · A-10: las calificaciones de un par bloqueado por HU-25 se guardan pero no suben el promedio público. */
describe('A-10 · calificaciones entre un par bloqueado (e2e)', () => {
  let e: Entorno;
  const a = ayudasCalificaciones(() => e);
  let org: Awaited<ReturnType<typeof organizacionConAdmin>>;

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    org = await organizacionConAdmin(
      e,
      await e.iniciar(`super${DOMINIO}`),
      'Atq Calif 10',
    );
  });
  beforeEach(() => a.f.r.preparar());
  afterAll(() => e.cerrar());

  /** Un bloqueo `par` como lo deja HU-25 (ordenado), que vence en `venceHace` días (negativo = en el futuro). */
  const bloquear = (
    x: string,
    y: string,
    reservaId: string,
    venceHace: number,
  ) => {
    const [menor, mayor] = x < y ? [x, y] : [y, x];
    return e.bd.query(
      `INSERT INTO bloqueos_preventivos (tipo, usuario_id, usuario_par_id, patron, reserva_id, vence_en)
       VALUES ('par', $1, $2, 'viajes_repetidos', $3, $4)`,
      [menor, mayor, reservaId, new Date(Date.now() - venceHace * DIA_MS)],
    );
  };

  it('A-10: el par bloqueado se califica 5★ muchas veces y el promedio público no cambia; las filas se guardan', async () => {
    const c = await a.f.persona(org.id);
    const colusor = await a.f.persona(org.id);
    const honesto = await a.f.persona(org.id);
    const [r1] = [await a.reserva(org.id, c, honesto)];
    await a.calificar(honesto.token, r1, { estrellas: 3 }).expect(201);
    const antes = await a.promedio(c.id);
    expect(antes).toEqual({ promedio: 3, cantidad: 1 });

    const reservas: string[] = [];
    for (let i = 0; i < 10; i++)
      reservas.push(await a.reserva(org.id, c, colusor));
    await bloquear(c.id, colusor.id, reservas[0], -3);
    for (const r of reservas)
      await a.calificar(colusor.token, r, { estrellas: 5 }).expect(201);

    expect(
      (
        await e.bd.query(`SELECT 1 FROM calificaciones WHERE autor_id = $1`, [
          colusor.id,
        ])
      ).rowCount,
    ).toBe(10);
    expect(await a.promedio(c.id)).toEqual(antes);
  });

  it('RN-7: cuenta si el bloqueo venció antes de los 7 días previos al pago; no cuenta si venció dentro de ellos', async () => {
    const c = await a.f.persona(org.id);
    const viejo = await a.f.persona(org.id);
    const reciente = await a.f.persona(org.id);
    const rViejo = await a.reserva(org.id, c, viejo, 1);
    const rReciente = await a.reserva(org.id, c, reciente, 1);
    await bloquear(c.id, viejo.id, rViejo, 30); // venció hace 30 días: pago hace 1 → fuera de la ventana
    await bloquear(c.id, reciente.id, rReciente, 2); // venció hace 2 días: dentro de los 7 previos al pago
    await a.calificar(viejo.token, rViejo, { estrellas: 4 }).expect(201);
    await a.calificar(reciente.token, rReciente, { estrellas: 5 }).expect(201);
    expect(await a.promedio(c.id)).toEqual({ promedio: 4, cantidad: 1 });
  });
});
