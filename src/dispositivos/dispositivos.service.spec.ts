import { generateKeyPairSync } from 'node:crypto';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { PlayIntegrityService } from '../comun/play-integrity.service.js';
import { PrismaService } from '../comun/prisma.service.js';
import {
  DispositivosService,
  normalizarLlavePublica,
} from './dispositivos.service.js';

const USUARIO = '11111111-1111-4111-8111-111111111111';
const OTRO = '22222222-2222-4222-8222-222222222222';

const pemDe = (tipo: 'ec' | 'rsa' | 'secp256k1') => {
  if (tipo === 'rsa')
    return generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
  return generateKeyPairSync('ec', {
    namedCurve: tipo === 'ec' ? 'prime256v1' : 'secp256k1',
  })
    .publicKey.export({ type: 'spki', format: 'pem' })
    .toString();
};
const PEM = pemDe('ec');

function crear(integridad: Partial<PlayIntegrityService> = {}) {
  const tx = {
    dispositivo: { create: vi.fn().mockResolvedValue({ id: 'd1' }) },
  };
  const prisma = {
    dispositivo: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const auditoria = { registrar: vi.fn().mockResolvedValue(undefined) };
  const verificar = vi
    .fn()
    .mockResolvedValue({ integro: true, veredicto: 'SIMULADO' });
  const servicio = new DispositivosService(
    prisma as unknown as PrismaService,
    auditoria as unknown as AuditoriaService,
    { verificar, ...integridad } as unknown as PlayIntegrityService,
  );
  return { servicio, prisma, tx, auditoria, verificar };
}
const dto = (desafio: string, extra: object = {}) => ({
  desafio,
  tokenIntegridad: 'simulado:integro',
  llavePublicaPem: PEM,
  modelo: 'Pixel',
  ...extra,
});

describe('normalizarLlavePublica', () => {
  it('acepta EC P-256 y devuelve PEM SPKI', () => {
    expect(normalizarLlavePublica(PEM)).toBe(PEM);
  });

  it.each([
    ['basura', 'no es una llave'],
    ['RSA', pemDe('rsa')],
    ['otra curva EC', pemDe('secp256k1')],
    [
      'llave privada',
      generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    ],
  ])('rechaza %s con LLAVE_INVALIDA', (_, pem) => {
    expect(() => normalizarLlavePublica(pem)).toThrow(
      expect.objectContaining({ codigo: 'LLAVE_INVALIDA' }),
    );
  });
});

describe('DispositivosService.emitirDesafio', () => {
  it('emite un desafío aleatorio con vencimiento', async () => {
    const { servicio } = crear();
    const a = await servicio.emitirDesafio(USUARIO);
    const b = await servicio.emitirDesafio(USUARIO);
    expect(a.desafio).not.toBe(b.desafio);
    expect(a.desafio).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(a.expiraEn).getTime()).toBeGreaterThan(Date.now());
  });

  it('CA-6: con dispositivo activo responde DISPOSITIVO_YA_VINCULADO', async () => {
    const o = crear();
    o.prisma.dispositivo.findFirst.mockResolvedValue({ id: 'd0' });
    await expect(o.servicio.emitirDesafio(USUARIO)).rejects.toMatchObject({
      codigo: 'DISPOSITIVO_YA_VINCULADO',
    });
  });
});

describe('DispositivosService.vincular', () => {
  it('CA-1: guarda la llave pública normalizada, el veredicto y audita en la misma transacción', async () => {
    const o = crear();
    const { desafio } = await o.servicio.emitirDesafio(USUARIO);
    await expect(o.servicio.vincular(USUARIO, dto(desafio))).resolves.toEqual({
      id: 'd1',
      estado: 'vinculado',
    });
    expect(o.verificar).toHaveBeenCalledWith('simulado:integro', desafio);
    expect(o.tx.dispositivo.create.mock.calls[0][0].data).toEqual({
      usuarioId: USUARIO,
      llavePublica: PEM,
      modeloDispositivo: 'Pixel',
      veredictoIntegridad: 'SIMULADO',
    });
    expect(o.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'dispositivo.vinculacion',
        resultado: 'ok',
      }),
      o.tx,
    );
  });

  it('A-05: el desafío es de un solo uso', async () => {
    const o = crear();
    const { desafio } = await o.servicio.emitirDesafio(USUARIO);
    await o.servicio.vincular(USUARIO, dto(desafio));
    await expect(
      o.servicio.vincular(USUARIO, dto(desafio)),
    ).rejects.toMatchObject({ codigo: 'DESAFIO_INVALIDO' });
  });

  it('un desafío inventado, de otra cuenta o vencido es DESAFIO_INVALIDO', async () => {
    const o = crear();
    await expect(
      o.servicio.vincular(USUARIO, dto('inventado')),
    ).rejects.toMatchObject({ codigo: 'DESAFIO_INVALIDO' });
    const { desafio } = await o.servicio.emitirDesafio(OTRO);
    await expect(
      o.servicio.vincular(USUARIO, dto(desafio)),
    ).rejects.toMatchObject({ codigo: 'DESAFIO_INVALIDO' });
    // robarlo no sirve: quedó consumido también para su dueño
    await expect(o.servicio.vincular(OTRO, dto(desafio))).rejects.toMatchObject(
      {
        codigo: 'DESAFIO_INVALIDO',
      },
    );

    vi.useFakeTimers();
    try {
      const { desafio: viejo } = await o.servicio.emitirDesafio(USUARIO);
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      await expect(
        o.servicio.vincular(USUARIO, dto(viejo)),
      ).rejects.toMatchObject({ codigo: 'DESAFIO_INVALIDO' });
    } finally {
      vi.useRealTimers();
    }
    expect(o.tx.dispositivo.create).not.toHaveBeenCalled();
  });

  it('conserva como máximo 5 desafíos pendientes por cuenta', async () => {
    const o = crear();
    const emitidos = [];
    for (let i = 0; i < 6; i++)
      emitidos.push((await o.servicio.emitirDesafio(USUARIO)).desafio);
    await expect(
      o.servicio.vincular(USUARIO, dto(emitidos[0])),
    ).rejects.toMatchObject({ codigo: 'DESAFIO_INVALIDO' });
    await expect(
      o.servicio.vincular(USUARIO, dto(emitidos[5])),
    ).resolves.toMatchObject({ estado: 'vinculado' });
  });

  it('CA-2 / A-03: dispositivo no íntegro, 422 sin guardar nada y con motivo solo en auditoría', async () => {
    const o = crear({
      verificar: vi.fn().mockResolvedValue({
        integro: false,
        veredicto: 'NO_INTEGRO',
        motivo: 'nonce',
      }),
    });
    const { desafio } = await o.servicio.emitirDesafio(USUARIO);
    const error = await o.servicio
      .vincular(USUARIO, dto(desafio))
      .catch((e) => e);
    expect(error.getStatus()).toBe(422);
    expect(error.codigo).toBe('DISPOSITIVO_NO_INTEGRO');
    expect(JSON.stringify(error.getResponse())).not.toContain('nonce');
    expect(o.tx.dispositivo.create).not.toHaveBeenCalled();
    expect(o.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        resultado: 'fallo',
        detalle: { motivo: 'nonce' },
      }),
    );
  });

  it('llave inválida: 400 LLAVE_INVALIDA sin llamar a Google', async () => {
    const o = crear();
    const { desafio } = await o.servicio.emitirDesafio(USUARIO);
    await expect(
      o.servicio.vincular(
        USUARIO,
        dto(desafio, { llavePublicaPem: pemDe('rsa') }),
      ),
    ).rejects.toMatchObject({ codigo: 'LLAVE_INVALIDA' });
    expect(o.verificar).not.toHaveBeenCalled();
  });

  it('caída de Google: propaga el 503 y no guarda nada', async () => {
    const o = crear({
      verificar: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('x'), { codigo: 'SERVICIO_NO_DISPONIBLE' }),
        ),
    });
    const { desafio } = await o.servicio.emitirDesafio(USUARIO);
    await expect(
      o.servicio.vincular(USUARIO, dto(desafio)),
    ).rejects.toMatchObject({ codigo: 'SERVICIO_NO_DISPONIBLE' });
    expect(o.tx.dispositivo.create).not.toHaveBeenCalled();
  });

  it('CA-6: ya vinculado antes de llamar a Google', async () => {
    const o = crear();
    const { desafio } = await o.servicio.emitirDesafio(USUARIO);
    o.prisma.dispositivo.findFirst.mockResolvedValue({ id: 'd0' });
    await expect(
      o.servicio.vincular(USUARIO, dto(desafio)),
    ).rejects.toMatchObject({ codigo: 'DISPOSITIVO_YA_VINCULADO' });
    expect(o.verificar).not.toHaveBeenCalled();
  });

  it('CA-6 concurrente: si el UNIQUE rechaza (P2002) responde DISPOSITIVO_YA_VINCULADO', async () => {
    const o = crear();
    o.tx.dispositivo.create.mockRejectedValue({ code: 'P2002' });
    const { desafio } = await o.servicio.emitirDesafio(USUARIO);
    await expect(
      o.servicio.vincular(USUARIO, dto(desafio)),
    ).rejects.toMatchObject({ codigo: 'DISPOSITIVO_YA_VINCULADO' });
  });

  it('otro error de la BD se propaga tal cual', async () => {
    const o = crear();
    o.tx.dispositivo.create.mockRejectedValue(new Error('BD caída'));
    const { desafio } = await o.servicio.emitirDesafio(USUARIO);
    await expect(o.servicio.vincular(USUARIO, dto(desafio))).rejects.toThrow(
      'BD caída',
    );
  });
});

describe('DispositivosService.miDispositivo', () => {
  it('devuelve solo id, modelo, fecha y estado (nunca la llave)', async () => {
    const o = crear();
    const fecha = new Date();
    o.prisma.dispositivo.findUnique.mockResolvedValue({
      id: 'd1',
      modeloDispositivo: 'Pixel',
      vinculadoEn: fecha,
      activo: true,
    });
    await expect(o.servicio.miDispositivo(USUARIO)).resolves.toEqual({
      id: 'd1',
      modelo: 'Pixel',
      vinculadoEn: fecha,
      activo: true,
    });
    const { select } = o.prisma.dispositivo.findUnique.mock.calls[0][0];
    expect(select).not.toHaveProperty('llavePublica');
  });

  it('sin dispositivo, 404 NO_ENCONTRADO', async () => {
    await expect(crear().servicio.miDispositivo(USUARIO)).rejects.toMatchObject(
      {
        codigo: 'NO_ENCONTRADO',
      },
    );
  });
});
