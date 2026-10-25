import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../src/comun/prisma.service.js';
import {
  DOMINIO,
  miembroCon,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';

describe('Ataque A-13 · HU-03 aprobación de miembros (e2e)', () => {
  let e: Entorno;
  let a: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let b: Awaited<ReturnType<typeof organizacionConAdmin>>;
  let solicitudB: string;
  const conToken = (t: string) => ({ Authorization: `Bearer ${t}` });
  const lista = (id: string) => `/api/v1/organizaciones/${id}/membresias`;
  const decision = (id: string) => `/api/v1/membresias/${id}/decision`;
  const SIN_ORG = '00000000-0000-4000-8000-000000000000';
  const huellaDeB = async () => ({
    membresia: (
      await e.bd.query(
        `SELECT estado, decidido_por, decidido_en, motivo FROM membresias WHERE id = $1`,
        [solicitudB],
      )
    ).rows[0],
    correos: (
      await e.bd.query(
        `SELECT count(*)::int AS n FROM correos_salientes WHERE referencia_id = $1`,
        [solicitudB],
      )
    ).rows[0].n,
    auditoria: (
      await e.bd.query(
        `SELECT count(*)::int AS n FROM registros_auditoria WHERE entidad_id = $1`,
        [solicitudB],
      )
    ).rows[0].n,
  });

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    const superToken = await e.iniciar(`super${DOMINIO}`);
    a = await organizacionConAdmin(e, superToken, 'Atq Memb A');
    b = await organizacionConAdmin(e, superToken, 'Atq Memb B');
    await miembroCon(e, a.id, `pend.a${DOMINIO}`, 'pendiente');
    await miembroCon(e, b.id, `pend.b${DOMINIO}`, 'pendiente');
    const { rows } = await e.bd.query(
      `SELECT m.id FROM membresias m JOIN usuarios u ON u.id = m.usuario_id WHERE u.correo = $1`,
      [`pend.b${DOMINIO}`],
    );
    solicitudB = rows[0].id;
  });
  afterAll(() => e.cerrar());

  it('CA-6: el admin de A no ve las solicitudes de B; la respuesta es la de una organización inexistente', async () => {
    const respuestas = [];
    for (const id of [b.id, SIN_ORG, 'no-es-un-uuid']) {
      const r = await e.api().get(lista(id)).set(conToken(a.token)).expect(404);
      respuestas.push(r.body);
    }
    for (const r of respuestas) expect(r).toEqual(respuestas[0]);
    expect(respuestas[0].codigo).toBe('NO_ENCONTRADO');
    expect(JSON.stringify(respuestas)).not.toContain(`pend.b${DOMINIO}`);
  });

  it('CA-6: el admin de A no decide una solicitud de B; misma respuesta que una inexistente y B intacta', async () => {
    const antes = await huellaDeB();
    const respuestas = [];
    for (const id of [solicitudB, SIN_ORG, 'no-es-un-uuid'])
      for (const cuerpo of [
        { decision: 'aprobar' },
        { decision: 'rechazar', motivo: 'intruso' },
      ]) {
        const r = await e
          .api()
          .post(decision(id))
          .set(conToken(a.token))
          .send(cuerpo)
          .expect(404);
        respuestas.push(r.body);
      }
    for (const r of respuestas) expect(r).toEqual(respuestas[0]);
    expect(respuestas[0].codigo).toBe('NO_ENCONTRADO');
    expect(await huellaDeB()).toEqual(antes);
    expect(antes.membresia).toMatchObject({
      estado: 'pendiente',
      decidido_por: null,
    });
  });

  it('CA-6: un token que dice ser de B sin membresía en B se rechaza (OrganizacionGuard)', async () => {
    const falso = await e.app.get(JwtService).signAsync({
      sub: a.adminId,
      org: b.id,
      cli: 'web',
    });
    const antes = await huellaDeB();
    const leer = await e
      .api()
      .get(lista(b.id))
      .set(conToken(falso))
      .expect(403);
    expect(leer.body.codigo).toBe('NO_AUTORIZADO');
    const decidir = await e
      .api()
      .post(decision(solicitudB))
      .set(conToken(falso))
      .send({ decision: 'aprobar' })
      .expect(403);
    expect(decidir.body.codigo).toBe('NO_AUTORIZADO');
    expect(await huellaDeB()).toEqual(antes);
  });

  it('CA-6: la organización no se puede elegir desde el cuerpo de la petición', async () => {
    const antes = await huellaDeB();
    await e
      .api()
      .post(decision(solicitudB))
      .set(conToken(a.token))
      .send({ decision: 'aprobar', organizacionId: b.id })
      .expect(400);
    expect(await huellaDeB()).toEqual(antes);
  });

  it('CA-6 a nivel BD: con el contexto de A, RLS no muestra ni modifica membresías de B', async () => {
    const modulo = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();
    const prisma = modulo.get(PrismaService);
    try {
      const vistas = await prisma.enOrganizacion(a.id, (tx) =>
        tx.membresia.findMany({ select: { organizacionId: true } }),
      );
      expect(vistas.length).toBeGreaterThan(0);
      expect(vistas.every((m) => m.organizacionId === a.id)).toBe(true);
      expect(
        await prisma.enOrganizacion(a.id, (tx) =>
          tx.membresia.findFirst({ where: { id: solicitudB } }),
        ),
      ).toBeNull();
      // Aunque se olvidara el filtro por organización en el código, RLS deja el update en 0 filas.
      const { count } = await prisma.enOrganizacion(a.id, (tx) =>
        tx.membresia.updateMany({
          where: { id: solicitudB, estado: 'pendiente' },
          data: { estado: 'aprobada', decididoPor: a.adminId },
        }),
      );
      expect(count).toBe(0);
    } finally {
      await prisma.onModuleDestroy();
    }
    expect((await huellaDeB()).membresia.estado).toBe('pendiente');
  });
});
