import { createHmac } from 'node:crypto';
import { hashDocumento, normalizarDocumento } from './documento.js';

beforeEach(() => vi.stubEnv('IDENTIDAD_SECRETO', 'secreto-unitario'));
afterEach(() => vi.unstubAllEnvs());

describe('documento', () => {
  it('normaliza: mayúsculas, sin espacios ni guiones', () => {
    expect(normalizarDocumento(' 1234567-1a ')).toBe('12345671A');
    expect(normalizarDocumento('1234567 1A')).toBe('12345671A');
  });

  it('el hash es el HMAC-SHA256 del carnet normalizado con el secreto del servidor (A-02)', () => {
    const esperado = createHmac('sha256', 'secreto-unitario')
      .update('12345671A')
      .digest('hex');
    expect(hashDocumento('1234567-1a')).toBe(esperado);
    expect(hashDocumento('1234567 1A')).toBe(esperado);
    expect(esperado).toMatch(/^[0-9a-f]{64}$/);
  });

  it('otro secreto da otro hash: sin el secreto no se pueden precalcular carnets', () => {
    const antes = hashDocumento('1234567');
    vi.stubEnv('IDENTIDAD_SECRETO', 'otro-secreto');
    expect(hashDocumento('1234567')).not.toBe(antes);
  });

  it('el hash no contiene el número en claro', () => {
    expect(hashDocumento('1234567')).not.toContain('1234567');
  });

  it('sin IDENTIDAD_SECRETO falla claro', () => {
    vi.stubEnv('IDENTIDAD_SECRETO', '');
    expect(() => hashDocumento('1234567')).toThrow('IDENTIDAD_SECRETO');
  });
});
