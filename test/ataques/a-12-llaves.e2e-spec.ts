import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasReservas } from '../reservas/ayudas-reservas.js';

/** PB-05 · A-12: ninguna llave privada en el repositorio versionado ni en la base en claro. */
const RAIZ = join(import.meta.dirname, '..', '..', '..');
const PEM = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;
const HEX_64 = /(?:0x)?[0-9a-fA-F]{64}\b/;
/** Una llave de 32 bytes solo es sospechosa en una línea que habla de llaves, claves o secretos. */
const HABLA_DE_LLAVE = /(priv|llave|secret|clave|mnemonic|seed|semilla)/i;
const BINARIOS =
  /\.(png|jpe?g|gif|webp|ico|ttf|otf|woff2?|lock|zip|jar|keystore)$/i;
/** Cada excepción lleva su motivo: valores públicos o de relleno que no abren ninguna cuenta. */
const EXCEPCIONES: Record<string, string> = {
  'backend/test/entorno.ts':
    'clave de relleno de las pruebas, sin valor fuera de ellas',
};

/** Archivos versionados del repositorio principal y de cada submódulo que existe en disco. */
function archivosVersionados(): string[] {
  const lista = (cwd: string, prefijo: string) =>
    execFileSync('git', ['ls-files'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean)
      .map((f) => `${prefijo}${f}`);
  return [
    ...lista(RAIZ, ''),
    ...['backend', 'contracts'].flatMap((m) => lista(join(RAIZ, m), `${m}/`)),
  ];
}

describe('PB-05 · A-12 · las llaves no se pueden leer (e2e)', () => {
  let e: Entorno;
  const r = ayudasReservas(() => e);

  beforeAll(async () => {
    e = await prepararEntorno();
  });
  afterAll(async () => {
    await e.cerrar();
  });

  it('A-12: el repositorio versionado no contiene llaves privadas PEM ni una llave de 32 bytes junto a una palabra de llave', () => {
    const hallazgos: string[] = [];
    for (const archivo of new Set(archivosVersionados())) {
      if (BINARIOS.test(archivo) || archivo in EXCEPCIONES) continue;
      let texto: string;
      try {
        texto = readFileSync(join(RAIZ, archivo), 'utf8');
      } catch {
        continue; // un submódulo sin descargar o un enlace roto
      }
      if (texto.includes('\u0000')) continue;
      if (PEM.test(texto)) hallazgos.push(`${archivo}: PEM`);
      texto.split('\n').forEach((linea, i) => {
        if (HEX_64.test(linea) && HABLA_DE_LLAVE.test(linea))
          hallazgos.push(`${archivo}:${i + 1}`);
      });
    }
    expect(hallazgos).toEqual([]);
  });

  it('A-12: en la base la llave de la billetera está cifrada y la auditoría no guarda llaves', async () => {
    const c = await r.conductor((await r.v.organizacion('Llaves A12')).id);
    const { rows } = await e.bd.query(
      `SELECT llave_custodia_ref FROM billeteras WHERE usuario_id = $1`,
      [c.id],
    );
    expect(rows).toHaveLength(1);
    // Ni una llave de 32 bytes en claro ni un PEM: solo el sobre cifrado.
    expect(rows[0].llave_custodia_ref).not.toMatch(/^(?:0x)?[0-9a-fA-F]{64}$/);
    expect(rows[0].llave_custodia_ref).not.toMatch(PEM);

    const auditoria = await e.bd.query(
      `SELECT count(*)::int AS n FROM registros_auditoria
       WHERE detalle::text ~* 'PRIVATE KEY'
          OR detalle::text ~* '"(llave|privatekey|private_key|secret|secreto|clave)[a-z_]*"\\s*:\\s*"(0x)?[0-9a-f]{64}"'`,
    );
    expect(auditoria.rows[0].n).toBe(0);
  });
});
