import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { AlmacenamientoService } from '../comun/almacenamiento.service.js';
import { PrismaService } from '../comun/prisma.service.js';
import type { RegistroVehiculoDto } from './dto/vehiculo.dto.js';
import { MAXIMO_FOTO_BYTES } from './foto.js';
import { VehiculosService } from './vehiculos.service.js';

const DUENO = '11111111-1111-4111-8111-111111111111';
const OTRO = '22222222-2222-4222-8222-222222222222';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const foto = (buffer = JPEG) => ({ buffer, size: buffer.length });
const dto = (
  extra: Partial<RegistroVehiculoDto> = {},
): RegistroVehiculoDto => ({
  placa: '1234-abc',
  marca: 'Toyota',
  modelo: 'Corolla',
  color: 'Blanco',
  capacidad: '4',
  aceptaUsoFoto: true,
  ...extra,
});
const VEHICULO = {
  id: 'v1',
  placa: '1234ABC',
  marca: 'Toyota',
  modelo: 'Corolla',
  color: 'Blanco',
  capacidad: 4,
};

function crear() {
  const tx = { vehiculo: { create: vi.fn().mockResolvedValue(VEHICULO) } };
  const prisma = {
    vehiculo: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const auditoria = { registrar: vi.fn().mockResolvedValue(undefined) };
  const almacenamiento = {
    subir: vi.fn().mockResolvedValue(undefined),
    borrar: vi.fn().mockResolvedValue(undefined),
  };
  const servicio = new VehiculosService(
    prisma as unknown as PrismaService,
    auditoria as unknown as AuditoriaService,
    almacenamiento as unknown as AlmacenamientoService,
  );
  return { servicio, prisma, tx, auditoria, almacenamiento };
}

describe('VehiculosService.registrar', () => {
  it('CA-1 y CA-3: normaliza, sube la foto con clave sin datos personales y guarda en la misma transacción que la auditoría', async () => {
    const o = crear();
    await expect(o.servicio.registrar(DUENO, dto(), foto())).resolves.toEqual(
      VEHICULO,
    );
    const [clave, contenido, tipo] = o.almacenamiento.subir.mock.calls[0];
    expect(clave).toMatch(/^vehiculos\/[0-9a-f-]{36}$/);
    expect([contenido, tipo]).toEqual([JPEG, 'image/jpeg']);
    const { data, select } = o.tx.vehiculo.create.mock.calls[0][0];
    expect(data).toMatchObject({
      propietarioId: DUENO,
      placa: '1234ABC',
      capacidad: 4,
      claveS3Foto: clave,
      consentimientoFotoEn: expect.any(Date),
    });
    // D-20: la clave se guarda pero nunca se lee de vuelta.
    expect(select).not.toHaveProperty('claveS3Foto');
    expect(o.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'vehiculo.registro',
        resultado: 'ok',
        detalle: { placa: '1234ABC' },
      }),
      o.tx,
    );
    expect(JSON.stringify(o.auditoria.registrar.mock.calls)).not.toContain(
      clave,
    );
    // Orden del plan: comprobar → subir → insertar.
    expect(o.prisma.vehiculo.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      o.almacenamiento.subir.mock.invocationCallOrder[0],
    );
    expect(o.almacenamiento.subir.mock.invocationCallOrder[0]).toBeLessThan(
      o.tx.vehiculo.create.mock.invocationCallOrder[0],
    );
  });

  it('valida antes de tocar BD o S3: consentimiento, placa, capacidad y foto', async () => {
    const casos: [
      Partial<RegistroVehiculoDto>,
      ReturnType<typeof foto> | undefined,
      object,
    ][] = [
      [
        { aceptaUsoFoto: undefined },
        foto(),
        { codigo: 'CONSENTIMIENTO_REQUERIDO' },
      ],
      [
        { aceptaUsoFoto: false },
        foto(),
        { codigo: 'CONSENTIMIENTO_REQUERIDO' },
      ],
      [
        { placa: '12-ab' },
        foto(),
        { codigo: 'VEHICULO_DATO_INVALIDO', extra: { campo: 'placa' } },
      ],
      [
        { capacidad: '7' },
        foto(),
        { codigo: 'VEHICULO_DATO_INVALIDO', extra: { campo: 'capacidad' } },
      ],
      [{}, undefined, { codigo: 'VEHICULO_FOTO_INVALIDA' }],
      [{}, foto(Buffer.from('GIF89a')), { codigo: 'VEHICULO_FOTO_INVALIDA' }],
      [
        {},
        { buffer: JPEG, size: MAXIMO_FOTO_BYTES + 1 },
        { codigo: 'VEHICULO_FOTO_INVALIDA' },
      ],
    ];
    for (const [extra, f, error] of casos) {
      const o = crear();
      await expect(
        o.servicio.registrar(DUENO, dto(extra), f),
      ).rejects.toMatchObject(error);
      expect(o.prisma.vehiculo.findMany).not.toHaveBeenCalled();
      expect(o.almacenamiento.subir).not.toHaveBeenCalled();
    }
  });

  it('CA-2 y RN-4: placa de otra persona o vehículo propio previo → 409 sin subir la foto; el propio gana', async () => {
    for (const [previos, codigo] of [
      [[{ propietarioId: OTRO }], 'VEHICULO_PLACA_DUPLICADA'],
      [[{ propietarioId: DUENO }], 'VEHICULO_YA_REGISTRADO'],
      [
        [{ propietarioId: OTRO }, { propietarioId: DUENO }],
        'VEHICULO_YA_REGISTRADO',
      ],
    ] as const) {
      const o = crear();
      o.prisma.vehiculo.findMany.mockResolvedValue([...previos]);
      await expect(
        o.servicio.registrar(DUENO, dto(), foto()),
      ).rejects.toMatchObject({ codigo, status: 409 });
      expect(o.almacenamiento.subir).not.toHaveBeenCalled();
      expect(o.auditoria.registrar).toHaveBeenCalledWith(
        expect.objectContaining({ resultado: 'fallo', actorId: DUENO }),
      );
      // No dice de quién es la placa.
      expect(JSON.stringify(o.auditoria.registrar.mock.calls)).not.toContain(
        OTRO,
      );
    }
  });

  it('falla S3: ALMACENAMIENTO_NO_DISPONIBLE 503 y no inserta', async () => {
    const o = crear();
    o.almacenamiento.subir.mockRejectedValue(new Error('caído'));
    await expect(
      o.servicio.registrar(DUENO, dto(), foto()),
    ).rejects.toMatchObject({
      codigo: 'ALMACENAMIENTO_NO_DISPONIBLE',
      status: 503,
    });
    expect(o.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('CA-2 en paralelo: el UNIQUE de la BD rechaza, se borra la foto subida y se dice qué chocó', async () => {
    for (const [propio, codigo] of [
      [null, 'VEHICULO_PLACA_DUPLICADA'],
      [{ id: 'v0' }, 'VEHICULO_YA_REGISTRADO'],
    ] as const) {
      const o = crear();
      o.tx.vehiculo.create.mockRejectedValue(
        Object.assign(new Error('Unique constraint'), { code: 'P2002' }),
      );
      o.prisma.vehiculo.findUnique.mockResolvedValue(propio);
      await expect(
        o.servicio.registrar(DUENO, dto(), foto()),
      ).rejects.toMatchObject({ codigo });
      expect(o.almacenamiento.borrar).toHaveBeenCalledWith(
        o.almacenamiento.subir.mock.calls[0][0],
      );
    }
  });

  it('D-20: otro error de BD borra la foto y no propaga el mensaje original, que puede traer la clave', async () => {
    const o = crear();
    o.tx.vehiculo.create.mockImplementation(async ({ data }) => {
      throw Object.assign(
        new Error(`Failing row contains (${data.claveS3Foto})`),
        { code: 'P2010' },
      );
    });
    const error = await o.servicio
      .registrar(DUENO, dto(), foto())
      .catch((e: Error) => e);
    const clave = o.almacenamiento.subir.mock.calls[0][0];
    expect(String((error as Error).message)).toBe(
      'No se pudo registrar el vehículo (P2010)',
    );
    expect((error as Error).stack).not.toContain(clave);
    expect(o.almacenamiento.borrar).toHaveBeenCalledWith(clave);
  });
});

describe('VehiculosService.mio y publicoDe', () => {
  it('el dueño ve su vehículo sin la foto; sin vehículo, NO_ENCONTRADO', async () => {
    const o = crear();
    o.prisma.vehiculo.findUnique.mockResolvedValueOnce(VEHICULO);
    await expect(o.servicio.mio(DUENO)).resolves.toEqual(VEHICULO);
    const { where, select } = o.prisma.vehiculo.findUnique.mock.calls[0][0];
    expect(where).toEqual({ propietarioId: DUENO });
    expect(select).not.toHaveProperty('claveS3Foto');
    await expect(o.servicio.mio(DUENO)).rejects.toMatchObject({
      codigo: 'NO_ENCONTRADO',
      status: 404,
    });
  });

  it('CA-7: otra persona solo ve placa, marca, modelo y color', async () => {
    const o = crear();
    await o.servicio.publicoDe(DUENO);
    expect(o.prisma.vehiculo.findUnique).toHaveBeenCalledWith({
      where: { propietarioId: DUENO },
      select: { placa: true, marca: true, modelo: true, color: true },
    });
  });
});
