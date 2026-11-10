import { generateKeyPairSync } from 'node:crypto';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { PlayIntegrityService } from '../comun/play-integrity.service.js';
import { PrismaService } from '../comun/prisma.service.js';
import { IdentidadService } from '../identidad/identidad.service.js';
import { CorreosService } from '../notificaciones/correos.service.js';
import { RevinculacionService } from './revinculacion.service.js';

const USUARIO = '11111111-1111-4111-8111-111111111111';
const OTRO = '22222222-2222-4222-8222-222222222222';

const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString();

function crear(
  overrides: {
    identidadAprobada?: boolean;
    comprobarRostroError?: Error;
    verificarIntegridad?: {
      integro: boolean;
      veredicto: string;
      motivo?: string;
    };
  } = {},
) {
  const tx = {
    dispositivo: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({ id: 'nuevo-d1' }),
    },
    usuario: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        correo: 'usuario@uagrm.edu.bo',
        nombreCompleto: 'Carlos Conductor',
      }),
    },
  };

  const prisma = {
    dispositivo: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };

  const auditoria = { registrar: vi.fn().mockResolvedValue(undefined) };
  const correos = { encolar: vi.fn().mockResolvedValue(undefined) };

  const identidad = {
    tieneIdentidadAprobada: vi
      .fn()
      .mockResolvedValue(overrides.identidadAprobada ?? false),
    crearSesionLivenessRevinculacion: vi
      .fn()
      .mockResolvedValue('liveness-sesion-1'),
    comprobarRostroDelTitular: overrides.comprobarRostroError
      ? vi.fn().mockRejectedValue(overrides.comprobarRostroError)
      : vi.fn().mockResolvedValue(undefined),
  };

  const integridad = {
    verificar: vi.fn().mockResolvedValue(
      overrides.verificarIntegridad ?? {
        integro: true,
        veredicto: 'SIMULADO',
      },
    ),
  };

  const servicio = new RevinculacionService(
    prisma as unknown as PrismaService,
    auditoria as unknown as AuditoriaService,
    integridad as unknown as PlayIntegrityService,
    identidad as unknown as IdentidadService,
    correos as unknown as CorreosService,
  );

  return {
    servicio,
    prisma,
    tx,
    auditoria,
    correos,
    identidad,
    integridad,
  };
}

describe('RevinculacionService · emitirDesafio', () => {
  it('sin identidad aprobada: requiereIdentidad false y no crea sesión liveness', async () => {
    const c = crear({ identidadAprobada: false });
    const res = await c.servicio.emitirDesafio(USUARIO);
    expect(res.desafio).toBeDefined();
    expect(res.requiereIdentidad).toBe(false);
    expect(res.sesionLivenessId).toBeUndefined();
    expect(c.identidad.crearSesionLivenessRevinculacion).not.toHaveBeenCalled();
  });

  it('con identidad aprobada: requiereIdentidad true y crea sesión liveness', async () => {
    const c = crear({ identidadAprobada: true });
    const res = await c.servicio.emitirDesafio(USUARIO);
    expect(res.desafio).toBeDefined();
    expect(res.requiereIdentidad).toBe(true);
    expect(res.sesionLivenessId).toBe('liveness-sesion-1');
    expect(c.identidad.crearSesionLivenessRevinculacion).toHaveBeenCalledWith(
      USUARIO,
    );
  });

  it('CA-12: un intento frenado al pedir el desafío (bloqueo) queda en auditoría y no emite desafío', async () => {
    const c = crear({ identidadAprobada: true });
    const bloqueo = Object.assign(new Error('bloqueada'), {
      codigo: 'INTENTOS_AGOTADOS',
    });
    c.identidad.crearSesionLivenessRevinculacion.mockRejectedValueOnce(bloqueo);

    await expect(c.servicio.emitirDesafio(USUARIO)).rejects.toBe(bloqueo);
    expect(c.auditoria.registrar).toHaveBeenCalledWith({
      accion: 'dispositivo.revinculacion',
      entidad: 'dispositivo',
      resultado: 'fallo',
      actorId: USUARIO,
      detalle: { motivo: 'INTENTOS_AGOTADOS' },
    });
  });
});

describe('RevinculacionService · revincular', () => {
  it('desafío inválido o de otra cuenta es rechazado', async () => {
    const c = crear();
    const { desafio } = await c.servicio.emitirDesafio(USUARIO);

    await expect(
      c.servicio.revincular(OTRO, {
        desafio,
        tokenIntegridad: 'simulado',
        llavePublicaPem: pem,
        modelo: 'Pixel 8',
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: { codigo: 'DESAFIO_INVALIDO' },
    });
  });

  it('desafío se consume en el primer uso: el segundo falla con DESAFIO_INVALIDO', async () => {
    const c = crear();
    const { desafio } = await c.servicio.emitirDesafio(USUARIO);

    await c.servicio.revincular(USUARIO, {
      desafio,
      tokenIntegridad: 'simulado',
      llavePublicaPem: pem,
      modelo: 'Pixel 8',
    });

    await expect(
      c.servicio.revincular(USUARIO, {
        desafio,
        tokenIntegridad: 'simulado',
        llavePublicaPem: pem,
        modelo: 'Pixel 8',
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: { codigo: 'DESAFIO_INVALIDO' },
    });
  });

  it('si requiere identidad y comprobarRostroDelTitular falla, se rechaza y no se modifica nada', async () => {
    const err = Object.assign(new Error('Rostro no coincide'), {
      status: 422,
      response: { codigo: 'ROSTRO_NO_COINCIDE' },
    });
    const c = crear({ identidadAprobada: true, comprobarRostroError: err });
    const { desafio } = await c.servicio.emitirDesafio(USUARIO);

    await expect(
      c.servicio.revincular(USUARIO, {
        desafio,
        tokenIntegridad: 'simulado',
        llavePublicaPem: pem,
        modelo: 'Pixel 8',
        sesionLivenessId: 'liveness-sesion-1',
      }),
    ).rejects.toMatchObject({
      status: 422,
      response: { codigo: 'ROSTRO_NO_COINCIDE' },
    });

    expect(c.tx.dispositivo.updateMany).not.toHaveBeenCalled();
    expect(c.tx.dispositivo.create).not.toHaveBeenCalled();
    expect(c.correos.encolar).not.toHaveBeenCalled();
  });

  it('llave pública inválida es rechazada con LLAVE_INVALIDA', async () => {
    const c = crear();
    const { desafio } = await c.servicio.emitirDesafio(USUARIO);

    await expect(
      c.servicio.revincular(USUARIO, {
        desafio,
        tokenIntegridad: 'simulado',
        llavePublicaPem: 'llave-invalida',
        modelo: 'Pixel 8',
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: { codigo: 'LLAVE_INVALIDA' },
    });
  });

  it('dispositivo no íntegro es rechazado con DISPOSITIVO_NO_INTEGRO (422)', async () => {
    const c = crear({
      verificarIntegridad: {
        integro: false,
        veredicto: 'NO_INTEGRO',
        motivo: 'emulador',
      },
    });
    const { desafio } = await c.servicio.emitirDesafio(USUARIO);

    await expect(
      c.servicio.revincular(USUARIO, {
        desafio,
        tokenIntegridad: 'simulado',
        llavePublicaPem: pem,
        modelo: 'Pixel 8',
      }),
    ).rejects.toMatchObject({
      status: 422,
      response: { codigo: 'DISPOSITIVO_NO_INTEGRO' },
    });
  });

  it('revinculación exitosa: desactiva anterior, inserta nuevo, audita y encola correo', async () => {
    const c = crear({ identidadAprobada: true });
    const { desafio } = await c.servicio.emitirDesafio(USUARIO);

    const res = await c.servicio.revincular(USUARIO, {
      desafio,
      tokenIntegridad: 'simulado',
      llavePublicaPem: pem,
      modelo: 'Pixel 8 Pro',
      sesionLivenessId: 'liveness-sesion-1',
    });

    expect(res).toEqual({ id: 'nuevo-d1', estado: 'vinculado' });
    expect(c.tx.dispositivo.updateMany).toHaveBeenCalledWith({
      where: { usuarioId: USUARIO, activo: true },
      data: { activo: false, desactivadoEn: expect.any(Date) },
    });
    expect(c.tx.dispositivo.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        usuarioId: USUARIO,
        modeloDispositivo: 'Pixel 8 Pro',
        activo: true,
      }),
      select: { id: true },
    });
    expect(c.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'dispositivo.revinculacion',
        entidad: 'dispositivo',
        resultado: 'ok',
        actorId: USUARIO,
      }),
      expect.anything(),
    );
    expect(c.correos.encolar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        destinatario: 'usuario@uagrm.edu.bo',
        plantilla: 'dispositivo_revinculado',
        referenciaId: 'nuevo-d1',
      }),
    );
  });

  it('la sesión de prueba de vida vale solo con su desafío: otra o ninguna llega como ausente', async () => {
    const c = crear({ identidadAprobada: true });
    for (const sesionLivenessId of [
      'liveness-de-otro-desafio',
      'liveness-sesion-1-extra',
      // El sufijo del motor simulado sobre un id de Rekognition no pasa.
      'liveness-sesion-1~carlos',
      undefined,
    ]) {
      const { desafio } = await c.servicio.emitirDesafio(USUARIO);
      await c.servicio.revincular(USUARIO, {
        desafio,
        tokenIntegridad: 'simulado',
        llavePublicaPem: pem,
        modelo: 'Pixel 8',
        sesionLivenessId,
      });
    }
    for (const [emitida, enviada] of [
      ['liveness-sesion-1', 'liveness-sesion-1'],
      ['sim-sesion-1', 'sim-sesion-1~carlos'],
    ]) {
      c.identidad.crearSesionLivenessRevinculacion.mockResolvedValueOnce(
        emitida,
      );
      const { desafio } = await c.servicio.emitirDesafio(USUARIO);
      await c.servicio.revincular(USUARIO, {
        desafio,
        tokenIntegridad: 'simulado',
        llavePublicaPem: pem,
        modelo: 'Pixel 8',
        sesionLivenessId: enviada,
      });
    }

    expect(
      c.identidad.comprobarRostroDelTitular.mock.calls.map((l) => l[1]),
    ).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      'liveness-sesion-1',
      'sim-sesion-1~carlos',
    ]);
  });

  it('dos revinculaciones a la vez: la perdedora responde 409 CONFLICTO_CONCURRENTE con su mensaje y queda en auditoría', async () => {
    const c = crear();
    c.tx.dispositivo.create.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint'), { code: 'P2002' }),
    );
    const { desafio } = await c.servicio.emitirDesafio(USUARIO);

    await expect(
      c.servicio.revincular(USUARIO, {
        desafio,
        tokenIntegridad: 'simulado',
        llavePublicaPem: pem,
        modelo: 'Telefono B',
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        codigo: 'CONFLICTO_CONCURRENTE',
        mensaje: expect.stringContaining('al mismo tiempo'),
      },
    });
    expect(c.auditoria.registrar).toHaveBeenCalledWith({
      accion: 'dispositivo.revinculacion',
      entidad: 'dispositivo',
      resultado: 'fallo',
      actorId: USUARIO,
      detalle: { motivo: 'revinculacion_concurrente', modelo: 'Telefono B' },
    });
  });

  it('CA-12: un rechazo de identidad queda auditado con el modelo y el código, sin datos biométricos', async () => {
    const err = Object.assign(new Error('Rostro no coincide'), {
      codigo: 'ROSTRO_NO_COINCIDE',
    });
    const c = crear({ identidadAprobada: true, comprobarRostroError: err });
    const { desafio, sesionLivenessId } =
      await c.servicio.emitirDesafio(USUARIO);

    await expect(
      c.servicio.revincular(USUARIO, {
        desafio,
        tokenIntegridad: 'simulado',
        llavePublicaPem: pem,
        modelo: 'Pixel 8',
        sesionLivenessId,
      }),
    ).rejects.toBe(err);
    expect(c.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        resultado: 'fallo',
        detalle: { motivo: 'ROSTRO_NO_COINCIDE', modelo: 'Pixel 8' },
      }),
    );
  });
});
