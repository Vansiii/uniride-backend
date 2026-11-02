import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService } from '../comun/prisma.service.js';
import { CorreosService } from '../notificaciones/correos.service.js';
import { renderizar } from '../notificaciones/plantillas.js';
import { MembresiasService } from './membresias.service.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const MEMBRESIA = '33333333-3333-4333-8333-333333333333';

function crear() {
  const membresia = {
    id: MEMBRESIA,
    usuarioId: 'u2',
    correoInstitucional: 'ana@uagrm.edu.bo',
    usuario: { nombreCompleto: 'Ana Pérez', correo: 'ana@uagrm.edu.bo' },
    organizacion: { nombre: 'UAGRM' },
  };
  const tx = {
    membresia: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue(membresia),
    },
    usuario: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    enOrganizacion: vi.fn((_: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const auditoria = { registrar: vi.fn().mockResolvedValue(undefined) };
  const correos = { encolar: vi.fn().mockResolvedValue(undefined) };
  const servicio = new MembresiasService(
    prisma as unknown as PrismaService,
    auditoria as unknown as AuditoriaService,
    correos as unknown as CorreosService,
  );
  return { servicio, prisma, tx, auditoria, correos };
}

describe('MembresiasService.listar', () => {
  it('A-13: otra organización que la activa responde 404 sin consultar la BD', () => {
    const { servicio, prisma } = crear();
    expect(() =>
      servicio.listar(ORG, '22222222-2222-4222-8222-222222222222', 'pendiente'),
    ).toThrow(ErrorNegocio);
    expect(prisma.enOrganizacion).not.toHaveBeenCalled();
  });

  it('CA-1: filtra por organización y estado, de la más antigua a la más reciente', async () => {
    const { servicio, tx } = crear();
    const creadoEn = new Date('2026-10-20T10:00:00Z');
    tx.membresia.findMany.mockResolvedValue([
      {
        id: 'm1',
        correoInstitucional: null,
        creadoEn,
        usuario: { nombreCompleto: 'Ana', correo: 'ana@uagrm.edu.bo' },
      },
    ]);
    await expect(servicio.listar(ORG, ORG, 'pendiente')).resolves.toEqual([
      {
        id: 'm1',
        nombreCompleto: 'Ana',
        correoInstitucional: 'ana@uagrm.edu.bo',
        creadoEn,
      },
    ]);
    expect(tx.membresia.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizacionId: ORG, estado: 'pendiente' },
        orderBy: [{ creadoEn: 'asc' }, { id: 'asc' }],
      }),
    );
  });
});

describe('MembresiasService.decidir', () => {
  it('CA-2 y CA-4: aprueba con un update condicional, fija la organización si no tenía, audita y encola el correo', async () => {
    const { servicio, tx, auditoria, correos } = crear();
    await expect(
      servicio.decidir(ORG, MEMBRESIA, 'admin', {
        decision: 'aprobar',
        motivo: 'ignorado',
      }),
    ).resolves.toEqual({ id: MEMBRESIA, estado: 'aprobada' });
    expect(tx.membresia.updateMany).toHaveBeenCalledWith({
      where: { id: MEMBRESIA, organizacionId: ORG, estado: 'pendiente' },
      data: {
        estado: 'aprobada',
        decididoPor: 'admin',
        decididoEn: expect.any(Date),
        motivo: null,
      },
    });
    expect(tx.usuario.updateMany).toHaveBeenCalledWith({
      where: { id: 'u2', ultimaOrganizacionId: null },
      data: { ultimaOrganizacionId: ORG },
    });
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'membresia.decision',
        resultado: 'ok',
        actorId: 'admin',
        organizacionId: ORG,
        detalle: { decision: 'aprobar', motivo: null },
      }),
      tx,
    );
    expect(correos.encolar).toHaveBeenCalledWith(tx, {
      destinatario: 'ana@uagrm.edu.bo',
      plantilla: 'membresia_aprobada',
      datos: { nombre: 'Ana Pérez', organizacion: 'UAGRM', motivo: '' },
      referenciaTipo: 'membresia',
      referenciaId: MEMBRESIA,
    });
  });

  it('CA-3: rechaza guardando el motivo, sin tocar la organización activa, y el correo lo incluye', async () => {
    const { servicio, tx, correos } = crear();
    await expect(
      servicio.decidir(ORG, MEMBRESIA, 'admin', {
        decision: 'rechazar',
        motivo: 'No es estudiante $& {nombre}',
      }),
    ).resolves.toEqual({ id: MEMBRESIA, estado: 'rechazada' });
    expect(tx.membresia.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          estado: 'rechazada',
          motivo: 'No es estudiante $& {nombre}',
        }),
      }),
    );
    expect(tx.usuario.updateMany).not.toHaveBeenCalled();
    const { plantilla, datos } = correos.encolar.mock.calls[0][1];
    expect(plantilla).toBe('membresia_rechazada');
    // El motivo va literal: ni `$&` ni `{nombre}` se reinterpretan.
    expect(renderizar(plantilla, datos).texto).toContain(
      'Motivo: No es estudiante $& {nombre}\n',
    );
  });

  it('CA-3: rechazo sin motivo (o vacío) guarda null y el correo no muestra la línea', async () => {
    const { servicio, tx, correos } = crear();
    await servicio.decidir(ORG, MEMBRESIA, 'admin', {
      decision: 'rechazar',
      motivo: '',
    });
    expect(tx.membresia.updateMany.mock.calls[0][0].data.motivo).toBeNull();
    const { plantilla, datos } = correos.encolar.mock.calls[0][1];
    expect(renderizar(plantilla, datos).texto).not.toContain('Motivo');
  });

  it('CA-5: ya decidida responde MEMBRESIA_YA_DECIDIDA, audita el fallo y no encola correo', async () => {
    const { servicio, tx, auditoria, correos } = crear();
    tx.membresia.updateMany.mockResolvedValue({ count: 0 });
    const error = await servicio
      .decidir(ORG, MEMBRESIA, 'admin', { decision: 'rechazar' })
      .catch((e: ErrorNegocio) => e);
    expect((error as ErrorNegocio).getStatus()).toBe(409);
    expect((error as ErrorNegocio).codigo).toBe('MEMBRESIA_YA_DECIDIDA');
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        resultado: 'fallo',
        detalle: { decision: 'rechazar', motivo: 'ya_decidida' },
      }),
      tx,
    );
    expect(correos.encolar).not.toHaveBeenCalled();
    expect(tx.usuario.updateMany).not.toHaveBeenCalled();
  });

  it('CA-6: invisible por RLS (otra organización) o inexistente responde 404', async () => {
    const { servicio, tx, correos } = crear();
    tx.membresia.updateMany.mockResolvedValue({ count: 0 });
    tx.membresia.findFirst.mockResolvedValue(null);
    await expect(
      servicio.decidir(ORG, MEMBRESIA, 'admin', { decision: 'aprobar' }),
    ).rejects.toMatchObject({ codigo: 'NO_ENCONTRADO' });
    expect(correos.encolar).not.toHaveBeenCalled();
  });

  it('A-13: un id que no es UUID responde 404 sin consultar la BD', async () => {
    const { servicio, prisma } = crear();
    await expect(
      servicio.decidir(ORG, 'no-es-un-uuid', 'admin', { decision: 'aprobar' }),
    ).rejects.toMatchObject({ codigo: 'NO_ENCONTRADO' });
    expect(prisma.enOrganizacion).not.toHaveBeenCalled();
  });

  it('sin correo institucional, avisa al correo de la cuenta', async () => {
    const { servicio, tx, correos } = crear();
    tx.membresia.findFirst.mockResolvedValue({
      id: MEMBRESIA,
      usuarioId: 'u2',
      correoInstitucional: null,
      usuario: { nombreCompleto: 'Ana', correo: 'cuenta@uagrm.edu.bo' },
      organizacion: { nombre: 'UAGRM' },
    });
    await servicio.decidir(ORG, MEMBRESIA, 'admin', { decision: 'aprobar' });
    expect(correos.encolar.mock.calls[0][1].destinatario).toBe(
      'cuenta@uagrm.edu.bo',
    );
  });
});
