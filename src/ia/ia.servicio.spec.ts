import { describe, expect, it, vi } from 'vitest';
import type { GroqServicio } from './groq.servicio.js';
import type { IaLocalServicio } from './ia-local.servicio.js';
import { IaServicio, SALTO_LOCAL_MS } from './ia.servicio.js';

function armar(local: string | null, groq: string | null, configurada = true) {
  const l = {
    configurada,
    modelo: 'qwen2.5:14b',
    completarJson: vi.fn().mockResolvedValue(local),
  };
  const g = {
    modelo: 'qwen/qwen3.8-27b',
    completarJson: vi.fn().mockResolvedValue(groq),
  };
  const ia = new IaServicio(
    l as unknown as IaLocalServicio,
    g as unknown as GroqServicio,
  );
  return { ia, l, g };
}

describe('IaServicio (PB-10 RN-2, RN-3)', () => {
  it('usa la IA local si responde y no llama a Groq', async () => {
    const { ia, g } = armar('{"a":1}', '{"b":2}');
    expect(await ia.completarJson('s', 'u', 0)).toEqual({
      json: '{"a":1}',
      proveedor: 'local',
      modelo: 'qwen2.5:14b',
    });
    expect(g.completarJson).not.toHaveBeenCalled();
  });

  it('si la local falla responde Groq', async () => {
    const { ia } = armar(null, '{"b":2}');
    expect(await ia.completarJson('s', 'u', 0)).toMatchObject({
      proveedor: 'groq',
      json: '{"b":2}',
    });
  });

  it('tras una falla salta la local 60 s y luego vuelve a probarla', async () => {
    const { ia, l } = armar(null, '{"b":2}');
    await ia.completarJson('s', 'u', 0);
    await ia.completarJson('s', 'u', SALTO_LOCAL_MS - 1);
    expect(l.completarJson).toHaveBeenCalledTimes(1);
    await ia.completarJson('s', 'u', SALTO_LOCAL_MS);
    expect(l.completarJson).toHaveBeenCalledTimes(2);
  });

  it('sin IA local configurada va directo a Groq', async () => {
    const { ia, l } = armar('{"a":1}', '{"b":2}', false);
    expect((await ia.completarJson('s', 'u', 0))?.proveedor).toBe('groq');
    expect(l.completarJson).not.toHaveBeenCalled();
  });

  it('si ambas fallan devuelve null', async () => {
    const { ia } = armar(null, null);
    expect(await ia.completarJson('s', 'u', 0)).toBeNull();
  });
});
