import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import {
  DOMINIO,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import { PrismaService } from '../../src/comun/prisma.service.js';

describe('Ataque A-13 · HU-02 reglas de afiliación (e2e)', () => {
  let e: Entorno;
  let a: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let b: Awaited<ReturnType<typeof organizacionConAdmin>>;
  const conToken = (t: string) => ({ Authorization: `Bearer ${t}` });
  const ruta = (id: string) => `/api/v1/organizaciones/${id}/afiliacion`;
  const SIN_ORG = '00000000-0000-4000-8000-000000000000';
  const cuerpo = {
    dominios: ['robado.hu02atq.test'],
    modoAprobacion: 'automatica',
  };
  const estadoDeB = async () =>
    (
      await e.bd.query(
        `SELECT o.modo_aprobacion, array_agg(d.dominio ORDER BY d.dominio) AS dominios
         FROM organizaciones o LEFT JOIN dominios_organizacion d ON d.organizacion_id = o.id
         WHERE o.id = $1 GROUP BY o.modo_aprobacion`,
        [b.id],
      )
    ).rows[0];

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.bd.query(
      `DELETE FROM dominios_organizacion WHERE dominio LIKE '%hu02atq.test'`,
    );
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    const superToken = await e.iniciar(`super${DOMINIO}`);
    a = await organizacionConAdmin(e, superToken, 'Atq Afil A');
    b = await organizacionConAdmin(e, superToken, 'Atq Afil B');
    for (const [org, dominio] of [
      [a, 'a.hu02atq.test'],
      [b, 'b.hu02atq.test'],
    ] as const)
      await e
        .api()
        .put(ruta(org.id))
        .set(conToken(org.token))
        .send({ dominios: [dominio], modoAprobacion: 'manual' })
        .expect(200);
  });
  afterAll(() => e.cerrar());

  it('CA-7: el admin de A no ve ni cambia la afiliación de B; la respuesta es la de una organización inexistente', async () => {
    const antes = await estadoDeB();
    const respuestas = [];
    for (const id of [b.id, SIN_ORG, 'no-es-un-uuid']) {
      const leer = await e
        .api()
        .get(ruta(id))
        .set(conToken(a.token))
        .expect(404);
      const cambiar = await e
        .api()
        .put(ruta(id))
        .set(conToken(a.token))
        .send(cuerpo)
        .expect(404);
      respuestas.push(leer.body, cambiar.body);
    }
    for (const r of respuestas) expect(r).toEqual(respuestas[0]);
    expect(respuestas[0].codigo).toBe('NO_ENCONTRADO');
    expect(JSON.stringify(respuestas)).not.toContain('b.hu02atq.test');
    expect(await estadoDeB()).toEqual(antes);
  });

  it('CA-7: un token que dice ser de B sin membresía en B se rechaza (OrganizacionGuard)', async () => {
    // El atacante tuviera la firma o no, la membresía se comprueba en la BD.
    const falso = await e.app.get(JwtService).signAsync({
      sub: a.adminId,
      org: b.id,
      cli: 'web',
    });
    const antes = await estadoDeB();
    const leer = await e.api().get(ruta(b.id)).set(conToken(falso)).expect(403);
    expect(leer.body.codigo).toBe('NO_AUTORIZADO');
    await e.api().put(ruta(b.id)).set(conToken(falso)).send(cuerpo).expect(403);
    expect(await estadoDeB()).toEqual(antes);
  });

  it('CA-7 a nivel BD: con el contexto de A, RLS no muestra, no borra ni crea dominios de B', async () => {
    const modulo = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();
    const prisma = modulo.get(PrismaService);
    try {
      const vistos = await prisma.enOrganizacion(a.id, (tx) =>
        tx.dominioOrganizacion.findMany(),
      );
      expect(vistos.map((d) => d.dominio)).toEqual(['a.hu02atq.test']);
      expect(await prisma.dominioOrganizacion.findMany()).toHaveLength(0);
      const { count } = await prisma.enOrganizacion(a.id, (tx) =>
        tx.dominioOrganizacion.deleteMany({ where: { organizacionId: b.id } }),
      );
      expect(count).toBe(0);
      await expect(
        prisma.enOrganizacion(a.id, (tx) =>
          tx.dominioOrganizacion.createMany({
            data: [{ organizacionId: b.id, dominio: 'colado.hu02atq.test' }],
          }),
        ),
      ).rejects.toThrow();
      const { count: cambiadas } = await prisma.enOrganizacion(a.id, (tx) =>
        tx.organizacion.updateMany({
          where: { id: b.id },
          data: { modoAprobacion: 'automatica' },
        }),
      );
      expect(cambiadas).toBe(0);
    } finally {
      await prisma.onModuleDestroy();
    }
    expect(await estadoDeB()).toEqual({
      modo_aprobacion: 'manual',
      dominios: ['b.hu02atq.test'],
    });
  });

  it('organizacion_por_dominio no abre RLS al llamador y solo devuelve el id', async () => {
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.organizacion_id', $1, true)`, [
        a.id,
      ]);
      const r = await app.query('SELECT * FROM organizacion_por_dominio($1)', [
        'b.hu02atq.test',
      ]);
      expect(r.fields.map((f) => f.name)).toEqual(['organizacion_por_dominio']);
      expect(r.rows).toEqual([{ organizacion_por_dominio: b.id }]);
      // Tras la llamada, la transacción sigue limitada a A.
      const contexto = await app.query(
        `SELECT current_setting('app.super_admin', true) AS super`,
      );
      expect(contexto.rows[0].super ?? '').not.toBe('true');
      const visibles = await app.query(
        'SELECT dominio FROM dominios_organizacion',
      );
      expect(visibles.rows).toEqual([{ dominio: 'a.hu02atq.test' }]);
      await app.query('ROLLBACK');
      // Comodines o listas no sirven para enumerar: la coincidencia es exacta.
      for (const sonda of [
        '%',
        '%.hu02atq.test',
        '',
        'b.hu02atq.test, a.hu02atq.test',
      ])
        expect(
          (
            await app.query('SELECT organizacion_por_dominio($1) AS id', [
              sonda,
            ])
          ).rows[0].id,
        ).toBeNull();
    } finally {
      await app.end();
    }
  });
});
