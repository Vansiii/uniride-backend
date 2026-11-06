import { claveCustodia, cifrarLlave, descifrarLlave } from './custodia.js';

const LLAVE = `0x${'1f'.repeat(32)}`;
const DIRECCION = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const OTRA = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

beforeEach(() => vi.stubEnv('WALLET_ENCRYPTION_KEY', 'cd'.repeat(32)));
afterEach(() => vi.unstubAllEnvs());

describe('custodia de llaves (A-12)', () => {
  it('cifra y descifra', () => {
    expect(descifrarLlave(cifrarLlave(LLAVE, DIRECCION), DIRECCION)).toBe(
      LLAVE,
    );
  });

  it('guarda IV, etiqueta y texto cifrado, sin la llave legible', () => {
    const referencia = cifrarLlave(LLAVE, DIRECCION);
    const [iv, etiqueta, texto] = referencia
      .split('.')
      .map((parte) => Buffer.from(parte, 'base64'));
    expect(iv).toHaveLength(12);
    expect(etiqueta).toHaveLength(16);
    expect(texto.length).toBeGreaterThan(0);
    expect(referencia).not.toContain(LLAVE);
    expect(referencia).not.toContain(LLAVE.slice(2));
  });

  it('cada cifrado usa otro IV', () => {
    expect(cifrarLlave(LLAVE, DIRECCION)).not.toBe(
      cifrarLlave(LLAVE, DIRECCION),
    );
  });

  it('otra clave no descifra', () => {
    const referencia = cifrarLlave(LLAVE, DIRECCION);
    vi.stubEnv('WALLET_ENCRYPTION_KEY', 'ef'.repeat(32));
    expect(() => descifrarLlave(referencia, DIRECCION)).toThrow();
  });

  it('una referencia copiada a la fila de otra billetera no descifra', () => {
    expect(() => descifrarLlave(cifrarLlave(LLAVE, DIRECCION), OTRA)).toThrow();
  });

  it('una referencia alterada no descifra', () => {
    const [iv, etiqueta, texto] = cifrarLlave(LLAVE, DIRECCION).split('.');
    const alterado = Buffer.from(texto, 'base64');
    alterado[0] ^= 1;
    expect(() =>
      descifrarLlave(
        [iv, etiqueta, alterado.toString('base64')].join('.'),
        DIRECCION,
      ),
    ).toThrow();
  });

  it.each([
    ['vacía', ''],
    ['corta', 'ab'.repeat(16)],
    ['larga', 'ab'.repeat(33)],
    ['no hexadecimal', 'zz'.repeat(32)],
  ])('WALLET_ENCRYPTION_KEY %s se rechaza sin mostrar su valor', (_, valor) => {
    vi.stubEnv('WALLET_ENCRYPTION_KEY', valor);
    expect(() => claveCustodia()).toThrow('WALLET_ENCRYPTION_KEY');
    try {
      claveCustodia();
    } catch (error) {
      if (valor) expect((error as Error).message).not.toContain(valor);
    }
  });
});
