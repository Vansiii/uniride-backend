import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../src/comun/prisma.service.js';
import {
  buzon,
  DOMINIO,
  miembroCon,
  organizacionConDominio,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';

describe('Ataque A-13 · HU-07 varias organizaciones propias (e2e)', () => {
  let e: Entorno;
  let a: Awaited<ReturnType<typeof organizacionConDominio>>;
  let b: Awaited<ReturnType<typeof organizacionConDominio>>;
  let c: Awaited<ReturnType<typeof organizacionConDominio>>;
  /** Admin de A que también es admin aprobado de B y tiene una solicitud pendiente en C. */
  let doble: string;
  let dobleId: string;
  let solicitudB: string;
  const SIN_ORG = '00000000-0000-4000-8000-000000000000';
  const conToken = (t: string) => ({ Authorization: `Bearer ${t}` });
  const lista = (id: string) => `/api/v1/organizaciones/${id}/membresias`;
  const afiliacion = (id: string) => `/api/v1/organizaciones/${id}/afiliacion`;
  const decision = (id: string) => `/api/v1/membresias/${id}/decision`;
  const huellaDeB = async () => ({
    membresia: (
      await e.bd.query(
        `SELECT estado, decidido_por FROM membresias WHERE id = $1`,
        [solicitudB],
      )
    ).rows[0],
    dominios: (
      await e.bd.query(
        `SELECT dominio FROM dominios_organizacion WHERE organizacion_id = $1 ORDER BY dominio`,
        [b.id],
      )
    ).rows,
    modo: (
      await e.bd.query(
        `SELECT modo_aprobacion FROM organizaciones WHERE id = $1`,
        [b.id],
      )
    ).rows[0].modo_aprobacion,
  });

  beforeAll(async () => {
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    const superToken = await e.iniciar(`super${DOMINIO}`);
    a = await organizacionConDominio(
      e,
      superToken,
      'Atq Var A',
      'xa.hu01.test',
      'automatica',
    );
    b = await organizacionConDominio(
      e,
      superToken,
      'Atq Var B',
      'xb.hu01.test',
      'manual',
    );
    c = await organizacionConDominio(
      e,
      superToken,
      'Atq Var C',
      'xc.hu01.test',
      'manual',
    );
    doble = a.token;
    dobleId = a.adminId;
    await e.bd.query(
      `INSERT INTO membresias (organizacion_id, usuario_id, rol, estado) VALUES ($1, $3, 'admin_organizacion', 'aprobada'), ($2, $3, 'miembro', 'pendiente')`,
      [b.id, c.id, dobleId],
    );
    await miembroCon(e, b.id, `pend.b${DOMINIO}`, 'pendiente');
    const { rows } = await e.bd.query(
      `SELECT m.id FROM membresias m JOIN usuarios u ON u.id = m.usuario_id WHERE u.correo = $1`,
      [`pend.b${DOMINIO}`],
    );
    solicitudB = rows[0].id;
  }, 90_000);
  afterAll(() => e.cerrar());

  it('CA-6: con A activa no ve ni cambia datos de B aunque sea admin de B; misma respuesta que una organización inexistente', async () => {
    const antes = await huellaDeB();
    const peticiones = (id: string, membresia: string) => [
      e.api().get(lista(id)).set(conToken(doble)),
      e.api().get(afiliacion(id)).set(conToken(doble)),
      e
        .api()
        .put(afiliacion(id))
        .set(conToken(doble))
        .send({
          dominios: ['intruso.hu01.test'],
          modoAprobacion: 'automatica',
        }),
      e
        .api()
        .post(decision(membresia))
        .set(conToken(doble))
        .send({ decision: 'aprobar' }),
    ];
    const deB = await Promise.all(peticiones(b.id, solicitudB));
    const inexistente = await Promise.all(peticiones(SIN_ORG, SIN_ORG));
    for (const [i, r] of deB.entries()) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual(inexistente[i].body);
      expect(r.body.codigo).toBe('NO_ENCONTRADO');
    }
    expect(JSON.stringify(deB.map((r) => r.body))).not.toContain(
      `pend.b${DOMINIO}`,
    );
    expect(await huellaDeB()).toEqual(antes);
    expect(antes.membresia.estado).toBe('pendiente');
  });

  it('CA-6: solo cambiando la activa a B ve los datos de B; y entonces deja de ver los de A', async () => {
    const r = await e
      .api()
      .put('/api/v1/yo/organizacion-activa')
      .set(conToken(doble))
      .send({ organizacionId: b.id })
      .expect(200);
    const tokenB = r.body.tokenAcceso;
    const solicitudes = await e
      .api()
      .get(lista(b.id))
      .set(conToken(tokenB))
      .expect(200);
    expect(solicitudes.body.map((s: { id: string }) => s.id)).toEqual([
      solicitudB,
    ]);
    expect(
      (await e.api().get(lista(a.id)).set(conToken(tokenB)).expect(404)).body
        .codigo,
    ).toBe('NO_ENCONTRADO');
    // El token anterior (org = A) sigue sin ver B.
    await e.api().get(lista(b.id)).set(conToken(doble)).expect(404);
    await e
      .api()
      .put('/api/v1/yo/organizacion-activa')
      .set(conToken(tokenB))
      .send({ organizacionId: a.id })
      .expect(200);
  });

  it('CA-5/CA-6: no puede activar C (pendiente) ni con un token que diga org = C', async () => {
    const r = await e
      .api()
      .put('/api/v1/yo/organizacion-activa')
      .set(conToken(doble))
      .send({ organizacionId: c.id })
      .expect(403);
    expect(r.body.codigo).toBe('MEMBRESIA_NO_APROBADA');
    const falso = await e.app
      .get(JwtService)
      .signAsync({ sub: dobleId, org: c.id, cli: 'movil' });
    const leer = await e
      .api()
      .get(afiliacion(c.id))
      .set(conToken(falso))
      .expect(403);
    expect(leer.body.codigo).toBe('NO_AUTORIZADO');
  });

  it('la organización nunca sale del cliente: `organizacionId` en el cuerpo → 400 y no se envía código', async () => {
    const correos = buzon(e);
    const r = await e
      .api()
      .post('/api/v1/membresias')
      .set(conToken(doble))
      .send({ correo: 'doble@xc.hu01.test', organizacionId: b.id })
      .expect(400);
    expect(r.body.codigo).toBe('VALIDACION_FALLIDA');
    expect(correos.enviados).toHaveLength(0);
  });

  it('RN-1: el código lo usa solo quien lo pidió; otra cuenta que lo conoce no se une, y el código sigue sirviendo a su dueño', async () => {
    const correos = buzon(e);
    const duena = await miembroCon(e, a.id, `duena${DOMINIO}`, 'aprobada');
    const intruso = await miembroCon(e, a.id, `intruso${DOMINIO}`, 'aprobada');
    const correo = 'duena@xb.hu01.test';
    await e
      .api()
      .post('/api/v1/membresias')
      .set(conToken(duena))
      .send({ correo })
      .expect(202);
    const codigo = correos.codigoPara(correo)!;
    const r = await e
      .api()
      .post('/api/v1/membresias/confirmar')
      .set(conToken(intruso))
      .send({ correo, codigo })
      .expect(400);
    expect(r.body.codigo).toBe('OTP_INVALIDO');
    const { rows } = await e.bd.query(
      `SELECT u.correo FROM membresias m JOIN usuarios u ON u.id = m.usuario_id WHERE m.organizacion_id = $1 AND u.correo = ANY($2)`,
      [b.id, [`duena${DOMINIO}`, `intruso${DOMINIO}`]],
    );
    expect(rows).toEqual([]);
    const ok = await e
      .api()
      .post('/api/v1/membresias/confirmar')
      .set(conToken(duena))
      .send({ correo, codigo })
      .expect(200);
    expect(ok.body.membresia).toMatchObject({
      organizacionId: b.id,
      estado: 'pendiente',
    });
  });

  it('CA-6 a nivel BD: con el contexto de A, RLS no muestra sus membresías de B ni de C', async () => {
    const modulo = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();
    const prisma = modulo.get(PrismaService);
    try {
      const vistas = await prisma.enOrganizacion(a.id, (tx) =>
        tx.membresia.findMany({
          where: { usuarioId: dobleId },
          select: { organizacionId: true },
        }),
      );
      expect(vistas).toEqual([{ organizacionId: a.id }]);
    } finally {
      await prisma.onModuleDestroy();
    }
  });
});
