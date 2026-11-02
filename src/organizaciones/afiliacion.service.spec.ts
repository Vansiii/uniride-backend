import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService } from '../comun/prisma.service.js';
import {
  AfiliacionService,
  DOMINIOS_PUBLICOS,
  validarDominios,
} from './afiliacion.service.js';

const ORG = '11111111-1111-4111-8111-111111111111';

function crear(dominios: string[] = ['uagrm.edu.bo']) {
  const tx = {
    organizacion: {
      findUnique: vi.fn().mockResolvedValue({
        id: ORG,
        modoAprobacion: 'manual',
        dominios: dominios.map((dominio) => ({ dominio })),
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    dominioOrganizacion: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const prisma = {
    enOrganizacion: vi.fn((_: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const auditoria = { registrar: vi.fn().mockResolvedValue(undefined) };
  const servicio = new AfiliacionService(
    prisma as unknown as PrismaService,
    auditoria as unknown as AuditoriaService,
  );
  return { servicio, prisma, tx, auditoria };
}

const codigoDe = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as ErrorNegocio).codigo;
  }
  return null;
};

describe('validarDominios', () => {
  it('RN-3: normaliza a minúsculas, sin @ inicial ni espacios, sin repetidos', () => {
    expect(
      validarDominios([' @UAGRM.edu.bo ', 'uagrm.edu.bo', 'Est.UAGRM.edu.bo']),
    ).toEqual(['est.uagrm.edu.bo', 'uagrm.edu.bo']);
  });

  it('CA-3: rechaza los dominios públicos de RN-4, también en mayúsculas', () => {
    for (const d of [...DOMINIOS_PUBLICOS, 'GMAIL.COM', '@Hotmail.com'])
      expect(codigoDe(() => validarDominios([d]))).toBe('DOMINIO_INVALIDO');
  });

  it('CA-3: rechaza formatos inválidos', () => {
    for (const d of [
      'uagrm',
      'ana@uagrm.edu.bo',
      'uagrm..edu.bo',
      '-uagrm.edu.bo',
      'uagrm-.edu.bo',
      'uagrm edu.bo',
      'uagrm.edu.b0',
      '192.168.0.1',
      'http://uagrm.edu.bo',
      `${'a'.repeat(64)}.bo`,
      '   ',
    ])
      expect(codigoDe(() => validarDominios([d]))).toBe('DOMINIO_INVALIDO');
  });

  it('CA-3: el error dice qué dominio falló', () => {
    try {
      validarDominios(['uagrm.edu.bo', 'gmail.com']);
    } catch (error) {
      expect((error as ErrorNegocio).getResponse()).toMatchObject({
        codigo: 'DOMINIO_INVALIDO',
        dominio: 'gmail.com',
      });
    }
    expect.assertions(1);
  });

  it('CA-6: una lista vacía es MINIMO_UN_DOMINIO', () => {
    expect(codigoDe(() => validarDominios([]))).toBe('MINIMO_UN_DOMINIO');
  });
});

describe('AfiliacionService', () => {
  it('A-13: otra organización que la activa responde 404 sin consultar la BD', async () => {
    const { servicio, prisma } = crear();
    const otra = '22222222-2222-4222-8222-222222222222';
    expect(() => servicio.obtener(ORG, otra)).toThrow(ErrorNegocio);
    await expect(
      servicio.guardar(ORG, otra, 'u1', {
        dominios: ['a.bo'],
        modoAprobacion: 'manual',
      }),
    ).rejects.toMatchObject({ codigo: 'NO_ENCONTRADO' });
    expect(prisma.enOrganizacion).not.toHaveBeenCalled();
  });

  it('obtener devuelve dominios y modo de la organización activa', async () => {
    const { servicio, prisma } = crear(['a.bo', 'b.bo']);
    await expect(servicio.obtener(ORG, ORG)).resolves.toEqual({
      dominios: ['a.bo', 'b.bo'],
      modoAprobacion: 'manual',
    });
    expect(prisma.enOrganizacion).toHaveBeenCalledWith(
      ORG,
      expect.any(Function),
    );
  });

  it('CA-1 y CA-8: reemplaza solo lo que cambió y audita el antes y el después', async () => {
    const { servicio, tx, auditoria } = crear(['a.bo', 'b.bo']);
    const r = await servicio.guardar(ORG, ORG, 'u1', {
      dominios: ['B.bo', 'c.bo'],
      modoAprobacion: 'automatica',
    });
    expect(r).toEqual({
      dominios: ['b.bo', 'c.bo'],
      modoAprobacion: 'automatica',
    });
    expect(tx.dominioOrganizacion.deleteMany).toHaveBeenCalledWith({
      where: { organizacionId: ORG, dominio: { in: ['a.bo'] } },
    });
    expect(tx.dominioOrganizacion.createMany).toHaveBeenCalledWith({
      data: [{ organizacionId: ORG, dominio: 'c.bo' }],
    });
    expect(tx.organizacion.update).toHaveBeenCalledWith({
      where: { id: ORG },
      data: { modoAprobacion: 'automatica' },
    });
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'organizacion.afiliacion',
        resultado: 'ok',
        actorId: 'u1',
        organizacionId: ORG,
        detalle: {
          anterior: { dominios: ['a.bo', 'b.bo'], modoAprobacion: 'manual' },
          nuevo: { dominios: ['b.bo', 'c.bo'], modoAprobacion: 'automatica' },
        },
      }),
      tx,
    );
  });

  it('CA-2: el choque con UNIQUE(dominio) es DOMINIO_NO_DISPONIBLE y se audita como fallo', async () => {
    const { servicio, tx, auditoria } = crear();
    tx.dominioOrganizacion.createMany.mockRejectedValue({ code: 'P2002' });
    const error = await servicio
      .guardar(ORG, ORG, 'u1', {
        dominios: ['ajena.bo'],
        modoAprobacion: 'manual',
      })
      .catch((e: ErrorNegocio) => e);
    expect(error).toBeInstanceOf(ErrorNegocio);
    expect((error as ErrorNegocio).getStatus()).toBe(409);
    expect((error as ErrorNegocio).getResponse()).toEqual({
      codigo: 'DOMINIO_NO_DISPONIBLE',
      mensaje: expect.any(String),
    });
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        resultado: 'fallo',
        detalle: { motivo: 'dominio_no_disponible' },
      }),
    );
  });

  it('otros errores de BD se propagan sin traducir', async () => {
    const { servicio, tx } = crear();
    tx.organizacion.update.mockRejectedValue(new Error('caída'));
    await expect(
      servicio.guardar(ORG, ORG, 'u1', {
        dominios: ['a.bo'],
        modoAprobacion: 'manual',
      }),
    ).rejects.toThrow('caída');
  });

  it('organización invisible por RLS: 404', async () => {
    const { servicio, tx } = crear();
    tx.organizacion.findUnique.mockResolvedValue(null);
    await expect(servicio.obtener(ORG, ORG)).rejects.toMatchObject({
      codigo: 'NO_ENCONTRADO',
    });
  });
});
