import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { ExecutionContext } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import {
  FirmaDispositivoGuard,
  mensajeCanonico,
  RegistroNonces,
  VENTANA_MS,
  VIDA_NONCE_MS,
} from './firma-dispositivo.guard.js';
import { PrismaService } from './prisma.service.js';

const USUARIO = '11111111-1111-4111-8111-111111111111';
const DISPOSITIVO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUTA = '/api/v1/billetera/recargas?moneda=URC';
const CUERPO = Buffer.from('{"monto":10}');

const par = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const duenio = par();
const intruso = par();
const pem = (k: ReturnType<typeof par>) =>
  k.publicKey.export({ type: 'spki', format: 'pem' }).toString();

let contador = 0;
interface Opciones {
  llave?: ReturnType<typeof par>;
  metodo?: string;
  ruta?: string;
  cuerpo?: Buffer;
  marca?: number;
  nonce?: string;
}
/** Petición con los encabezados que armaría la app; `firmada*` es lo que se firmó, lo demás es lo que llega. */
function peticion(
  firmado: Opciones = {},
  llega: Opciones = {},
  extra: Record<string, unknown> = {},
) {
  const marca = firmado.marca ?? Date.now();
  const nonce = firmado.nonce ?? `nonce-de-prueba-${++contador}-xxxxxxxx`;
  const metodo = firmado.metodo ?? 'POST';
  const ruta = firmado.ruta ?? RUTA;
  const cuerpo = firmado.cuerpo ?? CUERPO;
  const firma = sign(
    'sha256',
    Buffer.from(mensajeCanonico(metodo, ruta, String(marca), nonce, cuerpo)),
    (firmado.llave ?? duenio).privateKey,
  ).toString('base64');
  return {
    usuario: { id: USUARIO, org: null, cli: 'movil' },
    method: llega.metodo ?? metodo,
    originalUrl: llega.ruta ?? ruta,
    rawBody: llega.cuerpo ?? cuerpo,
    headers: {
      'x-dispositivo-id': DISPOSITIVO,
      'x-timestamp': String(marca),
      'x-nonce': nonce,
      'x-firma': firma,
    } as Record<string, string>,
    ...extra,
  };
}

const contexto = (req: object) =>
  ({
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

function crear(
  dispositivo: object | null = { id: DISPOSITIVO, llavePublica: pem(duenio) },
) {
  const prisma = {
    dispositivo: {
      findFirst: vi.fn().mockResolvedValue(dispositivo),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const auditoria = { registrar: vi.fn().mockResolvedValue(undefined) };
  const nonces = new RegistroNonces();
  const guard = new FirmaDispositivoGuard(
    prisma as unknown as PrismaService,
    auditoria as unknown as AuditoriaService,
    nonces,
  );
  const intentar = (req: object) => guard.canActivate(contexto(req));
  return { guard, prisma, auditoria, nonces, intentar };
}

describe('mensajeCanonico', () => {
  it('METODO, RUTA, TIMESTAMP, NONCE y SHA256 hex del cuerpo separados por salto de línea', () => {
    const hash = createHash('sha256').update('{"a":1}').digest('hex');
    expect(
      mensajeCanonico(
        'post',
        '/api/v1/x?y=1',
        '1700000000000',
        'n'.repeat(16),
        Buffer.from('{"a":1}'),
      ),
    ).toBe(`POST\n/api/v1/x?y=1\n1700000000000\n${'n'.repeat(16)}\n${hash}`);
  });

  it('cuerpo vacío = SHA256 de la cadena vacía', () => {
    expect(
      mensajeCanonico('GET', '/r', '1', 'n'.repeat(16), Buffer.alloc(0)),
    ).toMatch(
      /\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855$/,
    );
  });
});

describe('FirmaDispositivoGuard', () => {
  it('CA-4: una petición bien firmada por el dispositivo de la cuenta pasa y marca el último uso', async () => {
    const o = crear();
    await expect(o.intentar(peticion())).resolves.toBe(true);
    expect(o.prisma.dispositivo.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { usuarioId: USUARIO, activo: true } }),
    );
    expect(o.prisma.dispositivo.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DISPOSITIVO } }),
    );
  });

  it('acepta una petición GET sin cuerpo', async () => {
    const o = crear();
    const req = peticion({ metodo: 'GET', cuerpo: Buffer.alloc(0) });
    delete (req as { rawBody?: Buffer }).rawBody;
    await expect(o.intentar(req)).resolves.toBe(true);
  });

  it('un fallo al marcar el último uso no tumba la petición', async () => {
    const o = crear();
    o.prisma.dispositivo.update.mockRejectedValue(new Error('BD'));
    await expect(o.intentar(peticion())).resolves.toBe(true);
  });

  describe('CA-3 / A-08: sin firma o con encabezados defectuosos', () => {
    it.each(['x-dispositivo-id', 'x-timestamp', 'x-nonce', 'x-firma'])(
      'sin %s responde 401 FIRMA_DISPOSITIVO_INVALIDA',
      async (cabecera) => {
        const o = crear();
        const req = peticion();
        delete req.headers[cabecera];
        const error = await o.intentar(req).catch((e) => e);
        expect(error.codigo).toBe('FIRMA_DISPOSITIVO_INVALIDA');
        expect(error.getStatus()).toBe(401);
        expect(o.prisma.dispositivo.update).not.toHaveBeenCalled();
      },
    );

    it('curl sin ningún encabezado de firma', async () => {
      const o = crear();
      const error = await o
        .intentar({
          usuario: { id: USUARIO },
          headers: {},
          method: 'POST',
          originalUrl: RUTA,
        })
        .catch((e) => e);
      expect(error.codigo).toBe('FIRMA_DISPOSITIVO_INVALIDA');
      expect(error.getStatus()).toBe(401);
    });

    it.each([
      ['id que no es UUID', { 'x-dispositivo-id': 'no-uuid' }],
      ['timestamp no numérico', { 'x-timestamp': 'ayer' }],
      ['timestamp con signo', { 'x-timestamp': '-5' }],
      ['nonce corto', { 'x-nonce': 'corto' }],
      ['nonce con salto de línea', { 'x-nonce': 'abcdefghijklmnop\nGET' }],
      ['firma que no es Base64', { 'x-firma': '***' }],
    ])('%s', async (_, cambio) => {
      const o = crear();
      const req = peticion();
      Object.assign(req.headers, cambio);
      await expect(o.intentar(req)).rejects.toMatchObject({
        codigo: 'FIRMA_DISPOSITIVO_INVALIDA',
      });
    });

    it('sin sesión (no pasó por el JwtGuard) rechaza', async () => {
      const o = crear();
      const req = peticion();
      delete (req as { usuario?: unknown }).usuario;
      await expect(o.intentar(req)).rejects.toMatchObject({
        codigo: 'FIRMA_DISPOSITIVO_INVALIDA',
      });
    });

    it('un cuerpo que no llegó crudo (multipart) no se firma "vacío": se rechaza', async () => {
      const o = crear();
      const req = peticion({ cuerpo: Buffer.alloc(0) });
      delete (req as { rawBody?: Buffer }).rawBody;
      req.headers['content-length'] = '2048';
      await expect(o.intentar(req)).rejects.toMatchObject({
        codigo: 'FIRMA_DISPOSITIVO_INVALIDA',
      });
    });
  });

  describe('CA-4 / A-04 / A-08: firma que no corresponde', () => {
    it('A-04: firma hecha con la llave de otro teléfono', async () => {
      const o = crear();
      const error = await o
        .intentar(peticion({ llave: intruso }))
        .catch((e) => e);
      expect(error.codigo).toBe('FIRMA_DISPOSITIVO_INVALIDA');
      expect(error.getStatus()).toBe(401);
    });

    it.each([
      ['cuerpo alterado', { cuerpo: Buffer.from('{"monto":9999}') }],
      ['ruta alterada', { ruta: '/api/v1/billetera/retiros?moneda=URC' }],
      ['query alterada', { ruta: '/api/v1/billetera/recargas?moneda=OTRA' }],
      ['método alterado', { metodo: 'PUT' }],
    ] as [string, Opciones][])('%s', async (_, llega) => {
      const o = crear();
      await expect(o.intentar(peticion({}, llega))).rejects.toMatchObject({
        codigo: 'FIRMA_DISPOSITIVO_INVALIDA',
      });
    });

    it('firma con basura en lugar de ECDSA', async () => {
      const o = crear();
      const req = peticion();
      req.headers['x-firma'] =
        Buffer.from('no es una firma').toString('base64');
      await expect(o.intentar(req)).rejects.toMatchObject({
        codigo: 'FIRMA_DISPOSITIVO_INVALIDA',
      });
    });

    it('firma en formato P1363 (r||s): solo se acepta DER', async () => {
      const o = crear();
      const marca = Date.now();
      const nonce = 'nonce-p1363-xxxxxxxxxx';
      const req = peticion({ marca, nonce });
      req.headers['x-firma'] = sign(
        'sha256',
        Buffer.from(
          mensajeCanonico('POST', RUTA, String(marca), nonce, CUERPO),
        ),
        { key: duenio.privateKey, dsaEncoding: 'ieee-p1363' },
      ).toString('base64');
      await expect(o.intentar(req)).rejects.toMatchObject({
        codigo: 'FIRMA_DISPOSITIVO_INVALIDA',
      });
    });

    it('dispositivo inactivo o inexistente para la cuenta', async () => {
      const o = crear(null);
      await expect(o.intentar(peticion())).rejects.toMatchObject({
        codigo: 'FIRMA_DISPOSITIVO_INVALIDA',
      });
    });

    it('X-Dispositivo-Id de otra cuenta (no es el dispositivo activo de este usuario)', async () => {
      const o = crear();
      const req = peticion();
      req.headers['x-dispositivo-id'] = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      await expect(o.intentar(req)).rejects.toMatchObject({
        codigo: 'FIRMA_DISPOSITIVO_INVALIDA',
      });
    });

    it('llave guardada ilegible: rechaza sin romper', async () => {
      const o = crear({ id: DISPOSITIVO, llavePublica: 'corrupta' });
      await expect(o.intentar(peticion())).rejects.toMatchObject({
        codigo: 'FIRMA_DISPOSITIVO_INVALIDA',
      });
    });
  });

  describe('CA-5 / A-05: replay', () => {
    it('timestamp caducado (más de 30 s) y a futuro: PETICION_EXPIRADA', async () => {
      const o = crear();
      for (const desfase of [-(VENTANA_MS + 1000), VENTANA_MS + 1000]) {
        const error = await o
          .intentar(peticion({ marca: Date.now() + desfase }))
          .catch((e) => e);
        expect(error.codigo).toBe('PETICION_EXPIRADA');
        expect(error.getStatus()).toBe(401);
      }
    });

    it('un timestamp dentro de la ventana (-29 s) todavía pasa', async () => {
      const o = crear();
      await expect(
        o.intentar(peticion({ marca: Date.now() - 29_000 })),
      ).resolves.toBe(true);
    });

    it('la misma petición reenviada (mismo nonce) es PETICION_EXPIRADA', async () => {
      const o = crear();
      const original = peticion();
      await expect(o.intentar(original)).resolves.toBe(true);
      const error = await o.intentar(original).catch((e) => e);
      expect(error.codigo).toBe('PETICION_EXPIRADA');
      expect(error.getStatus()).toBe(401);
    });

    it('una petición con firma inválida no "quema" el nonce de la legítima', async () => {
      const o = crear();
      const nonce = 'nonce-compartido-xxxxxxxx';
      await expect(
        o.intentar(peticion({ nonce, llave: intruso })),
      ).rejects.toMatchObject({ codigo: 'FIRMA_DISPOSITIVO_INVALIDA' });
      await expect(o.intentar(peticion({ nonce }))).resolves.toBe(true);
    });

    it('nonce distinto con el mismo contenido sí pasa', async () => {
      const o = crear();
      await expect(o.intentar(peticion())).resolves.toBe(true);
      await expect(o.intentar(peticion())).resolves.toBe(true);
    });
  });

  describe('auditoría', () => {
    it('registra el motivo exacto sin firma, nonce ni ruta; el cliente no lo ve', async () => {
      const o = crear();
      const req = peticion({ llave: intruso });
      const error = await o.intentar(req).catch((e) => e);
      expect(JSON.stringify(error.getResponse())).not.toContain('firma');
      expect(o.auditoria.registrar).toHaveBeenCalledWith({
        accion: 'dispositivo.firma',
        entidad: 'dispositivo',
        resultado: 'fallo',
        actorId: USUARIO,
        detalle: { motivo: 'firma' },
      });
    });

    it('una falla al auditar no cambia la respuesta', async () => {
      const o = crear();
      o.auditoria.registrar.mockRejectedValue(new Error('BD'));
      await expect(
        o.intentar(peticion({ llave: intruso })),
      ).rejects.toMatchObject({
        codigo: 'FIRMA_DISPOSITIVO_INVALIDA',
      });
    });
  });
});

describe('RegistroNonces', () => {
  it('rechaza el repetido por dispositivo y los libera al vencer', () => {
    const r = new RegistroNonces();
    expect(r.registrar('d1', 'n', 1000)).toBe(true);
    expect(r.registrar('d1', 'n', 1001)).toBe(false);
    expect(r.registrar('d2', 'n', 1001)).toBe(true);
    expect(r.registrar('d1', 'n', 1000 + VIDA_NONCE_MS - 1)).toBe(false);
    expect(r.registrar('d1', 'n', 1000 + VIDA_NONCE_MS + 1)).toBe(true);
  });

  it('limpia los vencidos: el registro no crece sin límite', () => {
    const r = new RegistroNonces();
    for (let i = 0; i < 1000; i++) r.registrar('d', `n${i}`, 0);
    r.registrar('d', 'nuevo', VIDA_NONCE_MS + 1);
    expect((r as unknown as { vistos: Map<string, number> }).vistos.size).toBe(
      1,
    );
  });
});
