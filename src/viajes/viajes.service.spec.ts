import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { PrismaService } from '../comun/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PublicarViajeDto } from './dto/viaje.dto.js';
import { ViajesService } from './viajes.service.js';

const CONDUCTOR = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const HORA_MS = 3_600_000;

const dto = (extra: Partial<PublicarViajeDto> = {}): PublicarViajeDto => ({
  origenNombre: 'A',
  origenLat: -17.78,
  origenLng: -63.18,
  destinoNombre: 'B',
  destinoLat: -17.77,
  destinoLng: -63.19,
  fechaHoraSalida: new Date(Date.now() + 3 * HORA_MS).toISOString(),
  cuposTotales: 2,
  precioPorAsiento: 10,
  ...extra,
});

function crear(o: { vehiculo?: object | null; solapado?: object | null } = {}) {
  const viaje = { id: 'v1', estado: 'publicado', cuposDisponibles: 2 };
  const tx = {
    organizacion: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ precioMaximoUrc: new Prisma.Decimal('20.00') }),
    },
    viaje: {
      findFirst: vi.fn().mockResolvedValue(o.solapado ?? null),
      create: vi.fn().mockResolvedValue(viaje),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
  const prisma = {
    vehiculo: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          o.vehiculo === undefined ? { id: 'auto', capacidad: 4 } : o.vehiculo,
        ),
    },
    enOrganizacion: vi.fn((_: string, fn: (t: typeof tx) => unknown) => fn(tx)),
    comoSuperAdmin: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const auditoria = { registrar: vi.fn().mockResolvedValue(undefined) };
  return {
    tx,
    auditoria,
    servicio: new ViajesService(
      prisma as unknown as PrismaService,
      auditoria as unknown as AuditoriaService,
    ),
  };
}

const codigoDe = (p: Promise<unknown>) =>
  p.then(
    () => 'sin error',
    (e: { codigo: string }) => e.codigo,
  );

describe('ViajesService.publicar', () => {
  it('guarda los cupos libres iguales a los totales y audita en la misma transacción', async () => {
    const { servicio, tx, auditoria } = crear();
    await servicio.publicar(CONDUCTOR, ORG, dto());
    expect(tx.viaje.create.mock.calls[0][0].data).toMatchObject({
      organizacionId: ORG,
      conductorId: CONDUCTOR,
      vehiculoId: 'auto',
      cuposTotales: 2,
      cuposDisponibles: 2,
    });
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'viaje.publicacion', resultado: 'ok' }),
      tx,
    );
  });

  it('cierra el contexto abierto antes de escribir: el INSERT queda sujeto a RLS', async () => {
    const { servicio, tx } = crear();
    await servicio.publicar(CONDUCTOR, ORG, dto());
    const sql = tx.$executeRaw.mock.calls.map((c) =>
      (c[0] as TemplateStringsArray).join('?'),
    );
    expect(sql[0]).toContain('pg_advisory_xact_lock');
    expect(sql[1]).toContain(`'true'`);
    expect(sql[2]).toContain(`''`);
    const orden = (fn: { mock: { invocationCallOrder: number[] } }, i = 0) =>
      fn.mock.invocationCallOrder[i];
    expect(orden(tx.viaje.findFirst)).toBeLessThan(orden(tx.$executeRaw, 2));
    expect(orden(tx.$executeRaw, 2)).toBeLessThan(orden(tx.viaje.create));
  });

  it('un viaje solapado no se crea', async () => {
    const { servicio, tx } = crear({
      solapado: { fechaHoraSalida: new Date() },
    });
    expect(await codigoDe(servicio.publicar(CONDUCTOR, ORG, dto()))).toBe(
      'VIAJE_SOLAPADO',
    );
    expect(tx.viaje.create).not.toHaveBeenCalled();
  });

  it('sin vehículo: CONDUCTOR_SIN_VEHICULO', async () => {
    const { servicio } = crear({ vehiculo: null });
    expect(await codigoDe(servicio.publicar(CONDUCTOR, ORG, dto()))).toBe(
      'CONDUCTOR_SIN_VEHICULO',
    );
  });

  it('cupos sobre la capacidad: CUPOS_EXCEDEN_CAPACIDAD', async () => {
    const { servicio } = crear({ vehiculo: { id: 'auto', capacidad: 1 } });
    expect(await codigoDe(servicio.publicar(CONDUCTOR, ORG, dto()))).toBe(
      'CUPOS_EXCEDEN_CAPACIDAD',
    );
  });

  it.each([
    [0.99, 'PRECIO_FUERA_DE_RANGO'],
    [1, 'sin error'],
    [20, 'sin error'],
    [20.01, 'PRECIO_FUERA_DE_RANGO'],
  ])('CA-3: precio %s → %s', async (precioPorAsiento, esperado) => {
    const { servicio } = crear();
    expect(
      await codigoDe(
        servicio.publicar(CONDUCTOR, ORG, dto({ precioPorAsiento })),
      ),
    ).toBe(esperado);
  });

  it.each([
    [-HORA_MS, 'HORARIO_INVALIDO'],
    [14 * 60_000, 'HORARIO_INVALIDO'],
    [16 * 60_000, 'sin error'],
    [7 * 24 * HORA_MS - 60_000, 'sin error'],
    [7 * 24 * HORA_MS + 60_000, 'HORARIO_INVALIDO'],
  ])('RN-5: salida en %d ms → %s', async (ms, esperado) => {
    const { servicio } = crear();
    const fechaHoraSalida = new Date(Date.now() + ms).toISOString();
    expect(
      await codigoDe(
        servicio.publicar(CONDUCTOR, ORG, dto({ fechaHoraSalida })),
      ),
    ).toBe(esperado);
  });
});
