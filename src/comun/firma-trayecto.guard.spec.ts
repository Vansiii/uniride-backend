import { generateKeyPairSync, sign } from 'node:crypto';
import { ExecutionContext } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { mensajeCanonico, RegistroNonces } from './firma-dispositivo.guard.js';
import { FirmaTrayectoGuard } from './firma-trayecto.guard.js';
import { PrismaService } from './prisma.service.js';

const USUARIO = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const LLAVE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VIAJE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RUTA = `/api/v1/viajes/${VIAJE}/desafios`;
const CUERPO = Buffer.from('{"tipo":"abordaje"}');

const par = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const conductor = par();
const intruso = par();

let contador = 0;
function peticion(llave = conductor, extra: Record<string, unknown> = {}) {
  const marca = String(Date.now());
  const nonce = `nonce-trayecto-${++contador}-xxxxxxxx`;
  return {
    usuario: { id: USUARIO, org: ORG, cli: 'movil' },
    organizacionId: ORG,
    method: 'POST',
    originalUrl: RUTA,
    rawBody: CUERPO,
    headers: {
      'x-llave-trayecto-id': LLAVE,
      'x-timestamp': marca,
      'x-nonce': nonce,
      'x-firma': sign(
        'sha256',
        Buffer.from(mensajeCanonico('POST', RUTA, marca, nonce, CUERPO)),
        llave.privateKey,
      ).toString('base64'),
    } as Record<string, string>,
    ...extra,
  };
}

function crear(llave: object | null = {}) {
  const fila = llave && {
    id: LLAVE,
    viajeId: VIAJE,
    reservaId: null,
    llavePublica: conductor.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString(),
    ...llave,
  };
  const tx = { llaveTrayecto: { findFirst: vi.fn().mockResolvedValue(fila) } };
  const prisma = {
    enOrganizacion: vi.fn((_: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const auditoria = { registrar: vi.fn().mockResolvedValue(undefined) };
  const guard = new FirmaTrayectoGuard(
    prisma as unknown as PrismaService,
    auditoria as unknown as AuditoriaService,
    new RegistroNonces(),
  );
  const intentar = (req: object) =>
    guard.canActivate({
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext);
  return { tx, prisma, auditoria, intentar };
}

describe('FirmaTrayectoGuard (HU-22, D-22)', () => {
  it('firma válida con la llave vigente: pasa y deja la llave en la petición', async () => {
    const o = crear();
    const req = peticion();
    await expect(o.intentar(req)).resolves.toBe(true);
    expect(req).toMatchObject({
      llaveTrayecto: { id: LLAVE, viajeId: VIAJE, reservaId: null },
    });
    expect(o.prisma.enOrganizacion).toHaveBeenCalledWith(
      ORG,
      expect.any(Function),
    );
    // HU-10 CA-9: solo una llave del usuario, sin revocar y de su dispositivo activo.
    expect(o.tx.llaveTrayecto.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: LLAVE,
          usuarioId: USUARIO,
          revocadaEn: null,
          dispositivo: { activo: true, usuarioId: USUARIO },
        },
      }),
    );
  });

  it('llave inexistente, revocada, ajena o de un dispositivo inactivo: 401 FIRMA_TRAYECTO_INVALIDA y queda en auditoría', async () => {
    const o = crear(null);
    await expect(o.intentar(peticion())).rejects.toMatchObject({
      codigo: 'FIRMA_TRAYECTO_INVALIDA',
    });
    expect(o.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'trayecto.firma',
        resultado: 'fallo',
        detalle: { motivo: 'llave' },
      }),
    );
  });

  it('A-08: firmada con otra llave: 401 con el mismo error', async () => {
    const o = crear();
    await expect(o.intentar(peticion(intruso))).rejects.toMatchObject({
      codigo: 'FIRMA_TRAYECTO_INVALIDA',
    });
  });

  it('A-05: la misma petición dos veces: la segunda es PETICION_EXPIRADA', async () => {
    const o = crear();
    const req = peticion();
    await o.intentar(req);
    await expect(o.intentar(req)).rejects.toMatchObject({
      codigo: 'PETICION_EXPIRADA',
    });
  });

  it('sin organización validada o con cabeceras mal formadas: 401 sin consultar', async () => {
    const o = crear();
    await expect(
      o.intentar(peticion(conductor, { organizacionId: undefined })),
    ).rejects.toMatchObject({ codigo: 'FIRMA_TRAYECTO_INVALIDA' });
    const req = peticion();
    req.headers['x-llave-trayecto-id'] = 'no-es-uuid';
    await expect(o.intentar(req)).rejects.toMatchObject({
      codigo: 'FIRMA_TRAYECTO_INVALIDA',
    });
    expect(o.tx.llaveTrayecto.findFirst).not.toHaveBeenCalled();
  });
});
