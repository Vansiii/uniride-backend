import { Logger } from '@nestjs/common';
import { Wallet } from 'ethers';
import type { AuditoriaService } from '../auditoria/auditoria.service.js';
import type {
  BlockchainService,
  Cadena,
} from '../blockchain/blockchain.service.js';
import type { PrismaService } from '../comun/prisma.service.js';
import { BilleteraService } from './billetera.service.js';
import { descifrarLlave } from './custodia.js';

const USUARIO = '11111111-1111-4111-8111-111111111111';
const FILA = {
  id: 'b1',
  direccion: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
};
/** El error real de ethers lleva la URL del nodo: no debe llegar a los logs. */
const errorDelNodo = () =>
  Object.assign(new Error('fallo en https://nodo.test/clave-secreta-rpc'), {
    code: 'SERVER_ERROR',
  });

function crear(o: { existente?: typeof FILA; suspendidaEn?: Date } = {}) {
  const billetera = {
    findUnique: vi.fn().mockResolvedValue(o.existente ?? null),
    create: vi.fn().mockResolvedValue(FILA),
  };
  const usuario = {
    findUnique: vi
      .fn()
      .mockResolvedValue({ suspendidaEn: o.suspendidaEn ?? null }),
  };
  const prisma = {
    billetera,
    usuario,
    $transaction: vi.fn((fn: (t: unknown) => unknown) => fn({ billetera })),
  };
  const auditoria = { registrar: vi.fn().mockResolvedValue(undefined) };
  const cadena: Cadena = {
    leerSaldo: vi.fn().mockResolvedValue(10n ** 18n),
    exploradorUrl: vi.fn().mockReturnValue(null),
  };
  const servicio = new BilleteraService(
    prisma as unknown as PrismaService,
    auditoria as unknown as AuditoriaService,
    { cadena } as unknown as BlockchainService,
  );
  return { servicio, billetera, prisma, auditoria, cadena };
}
const fallo = (promesa: Promise<unknown>) =>
  promesa.then(
    () => {
      throw new Error('debía fallar');
    },
    (e) => e,
  );

describe('BilleteraService', () => {
  let logs: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('WALLET_ENCRYPTION_KEY', 'cd'.repeat(32));
    logs = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const registrado = () => JSON.stringify(logs.mock.calls);

  describe('arranque', () => {
    it('fuera de pruebas exige WALLET_ENCRYPTION_KEY válida', () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('WALLET_ENCRYPTION_KEY', '');
      expect(() => crear().servicio.onModuleInit()).toThrow(
        'WALLET_ENCRYPTION_KEY',
      );
      vi.stubEnv('WALLET_ENCRYPTION_KEY', 'corta');
      expect(() => crear().servicio.onModuleInit()).toThrow(
        'WALLET_ENCRYPTION_KEY',
      );
      vi.stubEnv('WALLET_ENCRYPTION_KEY', 'cd'.repeat(32));
      expect(() => crear().servicio.onModuleInit()).not.toThrow();
    });

    it('en pruebas no la exige al arrancar', () => {
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('WALLET_ENCRYPTION_KEY', '');
      expect(() => crear().servicio.onModuleInit()).not.toThrow();
    });
  });

  describe('crear', () => {
    it('guarda solo la llave cifrada, que corresponde a la dirección', async () => {
      const c = crear();
      const r = await c.servicio.crear(USUARIO);
      expect(r.creada).toBe(true);
      const { data, select } = c.billetera.create.mock.calls[0][0];
      expect(select).toEqual({ id: true, direccion: true });
      const llave = descifrarLlave(data.llaveCustodiaRef, data.direccion);
      expect(new Wallet(llave).address).toBe(data.direccion);
      expect(data.llaveCustodiaRef).not.toContain(llave.slice(2));
    });

    it('audita sin datos de la llave y en la misma transacción', async () => {
      const c = crear();
      await c.servicio.crear(USUARIO);
      const [evento, tx] = c.auditoria.registrar.mock.calls[0];
      expect(evento).toEqual({
        accion: 'billetera.creacion',
        entidad: 'billetera',
        entidadId: FILA.id,
        resultado: 'ok',
        actorId: USUARIO,
      });
      expect(tx).toEqual({ billetera: c.billetera });
    });

    it('con billetera existente no genera otra', async () => {
      const c = crear({ existente: FILA });
      const r = await c.servicio.crear(USUARIO);
      expect(r).toEqual({
        creada: false,
        billetera: {
          ...FILA,
          saldoUrc: '1.00',
          exploradorUrl: null,
        },
      });
      expect(c.billetera.create).not.toHaveBeenCalled();
    });

    it('la cadena caída no llega a insertar y el log no trae la URL del nodo', async () => {
      const c = crear();
      vi.mocked(c.cadena.leerSaldo).mockRejectedValue(errorDelNodo());
      const e = await fallo(c.servicio.crear(USUARIO));
      expect([e.getStatus(), e.codigo]).toEqual([
        503,
        'SERVICIO_BLOCKCHAIN_NO_DISPONIBLE',
      ]);
      expect(c.prisma.$transaction).not.toHaveBeenCalled();
      expect(registrado()).toContain('SERVER_ERROR');
      expect(registrado()).not.toContain('clave-secreta-rpc');
    });

    it('sin clave de custodia responde 503 sin tocar la cadena ni la BD', async () => {
      vi.stubEnv('WALLET_ENCRYPTION_KEY', '');
      const c = crear();
      const e = await fallo(c.servicio.crear(USUARIO));
      expect(e.codigo).toBe('SERVICIO_BLOCKCHAIN_NO_DISPONIBLE');
      expect(c.cadena.leerSaldo).not.toHaveBeenCalled();
      expect(c.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('si otra petición ganó (P2002) devuelve la ganadora', async () => {
      const c = crear();
      c.billetera.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(FILA);
      c.prisma.$transaction.mockRejectedValue({ code: 'P2002' });
      const r = await c.servicio.crear(USUARIO);
      expect(r.creada).toBe(false);
      expect(r.billetera.id).toBe(FILA.id);
    });

    it('P2002 sin ganadora (colisión de dirección) responde 503', async () => {
      const c = crear();
      c.prisma.$transaction.mockRejectedValue({ code: 'P2002' });
      const e = await fallo(c.servicio.crear(USUARIO));
      expect(e.codigo).toBe('SERVICIO_BLOCKCHAIN_NO_DISPONIBLE');
    });

    it('una falla de la BD responde 503 y el log no trae la fila', async () => {
      const c = crear();
      c.prisma.$transaction.mockRejectedValue(
        Object.assign(new Error('valor llave_custodia_ref=secreto'), {
          code: 'P2010',
        }),
      );
      const e = await fallo(c.servicio.crear(USUARIO));
      expect(e.getStatus()).toBe(503);
      expect(registrado()).toContain('P2010');
      expect(registrado()).not.toContain('secreto');
    });
  });

  describe('mia', () => {
    it('devuelve la dirección y el saldo', async () => {
      const c = crear({ existente: FILA });
      vi.mocked(c.cadena.exploradorUrl).mockReturnValue('https://explorador');
      expect(await c.servicio.mia(USUARIO)).toEqual({
        ...FILA,
        saldoUrc: '1.00',
        exploradorUrl: 'https://explorador',
      });
    });

    it('sin billetera responde 404', async () => {
      const e = await fallo(crear().servicio.mia(USUARIO));
      expect([e.getStatus(), e.codigo]).toEqual([
        404,
        'BILLETERA_NO_ENCONTRADA',
      ]);
    });

    it('con la cadena caída responde 503', async () => {
      const c = crear({ existente: FILA });
      vi.mocked(c.cadena.leerSaldo).mockRejectedValue(errorDelNodo());
      const e = await fallo(c.servicio.mia(USUARIO));
      expect(e.codigo).toBe('SERVICIO_BLOCKCHAIN_NO_DISPONIBLE');
    });
  });

  describe('exigirCuentaActiva', () => {
    it('pasa sin suspensión y rechaza con ella', async () => {
      await expect(
        crear().servicio.exigirCuentaActiva(USUARIO),
      ).resolves.toBeUndefined();
      const e = await fallo(
        crear({ suspendidaEn: new Date() }).servicio.exigirCuentaActiva(
          USUARIO,
        ),
      );
      expect([e.getStatus(), e.codigo]).toEqual([403, 'CUENTA_SUSPENDIDA']);
    });
  });

  describe('crearAutomatica', () => {
    it('crea la billetera', async () => {
      const c = crear();
      await c.servicio.crearAutomatica(USUARIO);
      expect(c.billetera.create).toHaveBeenCalledTimes(1);
    });

    it('una cuenta suspendida no recibe billetera y queda registrado', async () => {
      const c = crear({ suspendidaEn: new Date() });
      await c.servicio.crearAutomatica(USUARIO);
      expect(c.billetera.create).not.toHaveBeenCalled();
      expect(c.auditoria.registrar).toHaveBeenCalledWith({
        accion: 'billetera.creacion',
        entidad: 'billetera',
        resultado: 'fallo',
        actorId: USUARIO,
        detalle: { motivo: 'CUENTA_SUSPENDIDA' },
      });
    });

    it('la cadena caída no rechaza: queda en auditoría y en el log', async () => {
      const c = crear();
      vi.mocked(c.cadena.leerSaldo).mockRejectedValue(errorDelNodo());
      await expect(
        c.servicio.crearAutomatica(USUARIO),
      ).resolves.toBeUndefined();
      expect(c.auditoria.registrar.mock.calls[0][0]).toMatchObject({
        resultado: 'fallo',
        detalle: { motivo: 'SERVICIO_BLOCKCHAIN_NO_DISPONIBLE' },
      });
      expect(registrado()).not.toContain('clave-secreta-rpc');
    });

    it.each([
      ['sin código usa su nombre', new TypeError('dato sensible'), 'TypeError'],
      ['vacío usa un genérico', null, 'Error'],
    ])('un error %s, sin su mensaje', async (_, error, motivo) => {
      const c = crear();
      c.billetera.findUnique.mockRejectedValue(error);
      await c.servicio.crearAutomatica(USUARIO);
      expect(c.auditoria.registrar.mock.calls[0][0].detalle).toEqual({
        motivo,
      });
      expect(registrado()).not.toContain('dato sensible');
    });

    it('nunca rechaza, ni con la BD caída al auditar', async () => {
      const c = crear();
      const aviso = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});
      c.billetera.findUnique.mockRejectedValue(
        Object.assign(new Error('fila con datos'), { code: 'P1001' }),
      );
      c.auditoria.registrar.mockRejectedValue(new Error('BD caída'));
      await expect(
        c.servicio.crearAutomatica(USUARIO),
      ).resolves.toBeUndefined();
      expect(registrado()).toContain('P1001');
      expect(registrado()).not.toContain('fila con datos');
      expect(aviso).toHaveBeenCalled();
    });
  });
});
