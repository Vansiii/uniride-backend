import { Test } from '@nestjs/testing';
import {
  alta,
  CONTRASENA,
  DOMINIO,
  prepararEntorno,
  tokenInvitacion,
  type Entorno,
} from '../ayudas-organizaciones.js';
import { PrismaService } from '../../src/comun/prisma.service.js';

describe('Ataques A-13 y de rol · HU-01 (e2e)', () => {
  let e: Entorno;
  let superToken: string;
  let adminA: string;
  let orgA: string;
  let orgB: string;
  const conToken = (t: string) => ({ Authorization: `Bearer ${t}` });
  const SIN_ORG = '00000000-0000-4000-8000-000000000000';

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    superToken = await e.iniciar(`super${DOMINIO}`);
    const crear = async (sufijo: string) => {
      const cuerpo = alta(sufijo);
      const r = await e
        .api()
        .post('/api/v1/admin/organizaciones')
        .set(conToken(superToken))
        .send(cuerpo)
        .expect(201);
      return { id: r.body.id as string, correo: cuerpo.adminCorreo };
    };
    const a = await crear('Atq A');
    const b = await crear('Atq B');
    orgA = a.id;
    orgB = b.id;
    const token = await tokenInvitacion(e.bd, a.correo);
    const aceptada = await e
      .api()
      .post(`/api/v1/invitaciones/${token}/aceptar`)
      .send({
        nombreCompleto: 'Admin A',
        contrasena: CONTRASENA,
        tipoCliente: 'movil',
      })
      .expect(200);
    adminA = aceptada.body.tokenAcceso;
  });
  afterAll(() => e.cerrar());

  it('CA-6 el admin de A no lista ni reenvía invitaciones de otras organizaciones', async () => {
    await e
      .api()
      .get('/api/v1/admin/organizaciones')
      .set(conToken(adminA))
      .expect(403);
    const existente = await e
      .api()
      .post(`/api/v1/admin/organizaciones/${orgB}/invitacion`)
      .set(conToken(adminA))
      .expect(403);
    // Misma respuesta si B existe o no: no revela su existencia.
    const inexistente = await e
      .api()
      .post(`/api/v1/admin/organizaciones/${SIN_ORG}/invitacion`)
      .set(conToken(adminA))
      .expect(403);
    expect(existente.body).toEqual(inexistente.body);
  });

  it('CA-6 a nivel BD, con el contexto de A, RLS no devuelve ni acepta filas de B', async () => {
    const modulo = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();
    const prisma = modulo.get(PrismaService);
    try {
      const vistas = await prisma.enOrganizacion(orgA, async (tx) => ({
        orgs: await tx.organizacion.findMany(),
        invitaciones: await tx.invitacion.findMany(),
        membresias: await tx.membresia.findMany(),
      }));
      expect(vistas.orgs.map((o) => o.id)).toEqual([orgA]);
      expect(vistas.invitaciones.length).toBeGreaterThan(0);
      expect(vistas.invitaciones.every((i) => i.organizacionId === orgA)).toBe(
        true,
      );
      expect(vistas.membresias.every((m) => m.organizacionId === orgA)).toBe(
        true,
      );
      // Sin contexto, ninguna fila.
      expect(await prisma.organizacion.findMany()).toHaveLength(0);
      expect(await prisma.invitacion.findMany()).toHaveLength(0);
      // Modificar B desde A no afecta nada.
      const { count } = await prisma.enOrganizacion(orgA, (tx) =>
        tx.organizacion.updateMany({
          where: { id: orgB },
          data: { precioMaximoUrc: 999 },
        }),
      );
      expect(count).toBe(0);
      // Crear datos de B desde el contexto de A lo rechaza la política.
      await expect(
        prisma.enOrganizacion(orgA, (tx) =>
          tx.invitacion.create({
            data: {
              organizacionId: orgB,
              correo: `x${DOMINIO}`,
              nombre: 'x',
              hashToken: 'h-ataque',
              venceEn: new Date(),
              creadoPor: orgA,
            },
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  it('CA-7 un miembro o admin de organización no puede dar de alta organizaciones', async () => {
    const miembro = `miembro${DOMINIO}`;
    await e.crearUsuario(miembro);
    const tokenMiembro = await e.iniciar(miembro);
    for (const t of [tokenMiembro, adminA]) {
      const r = await e
        .api()
        .post('/api/v1/admin/organizaciones')
        .set(conToken(t))
        .send(alta('Intruso'))
        .expect(403);
      expect(r.body.codigo).toBe('NO_AUTORIZADO');
    }
    await e
      .api()
      .post('/api/v1/admin/organizaciones')
      .send(alta('Anonimo'))
      .expect(401);
    const { rows } = await e.bd.query(
      `SELECT 1 FROM organizaciones WHERE nombre IN ('HU01 Intruso', 'HU01 Anonimo')`,
    );
    expect(rows).toHaveLength(0);
  });
});
