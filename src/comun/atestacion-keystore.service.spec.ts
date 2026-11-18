import {
  createHash,
  generateKeyPairSync,
  sign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import {
  AtestacionKeystore,
  cargarRaicesGoogle,
  crearPlayIntegrity,
} from './atestacion-keystore.service.js';
import { PlayIntegritySimulado } from './play-integrity.service.js';

// --- Constructor mínimo de certificados X.509 con la extensión de atestación de Android (solo para pruebas) ---
const largo = (n: number) =>
  n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
const tlv = (tag: number[] | number, cuerpo: Buffer) =>
  Buffer.concat([
    Buffer.from(Array.isArray(tag) ? tag : [tag]),
    Buffer.from(largo(cuerpo.length)),
    cuerpo,
  ]);
const seq = (...x: Buffer[]) => tlv(0x30, Buffer.concat(x));
const conjunto = (...x: Buffer[]) => tlv(0x31, Buffer.concat(x));
const oct = (b: Buffer | string) => tlv(0x04, Buffer.from(b));
const entero = (n: number) => {
  const bytes: number[] = [];
  do {
    bytes.unshift(n & 255);
    n = Math.floor(n / 256);
  } while (n > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
};
const enumerado = (n: number) => tlv(0x0a, Buffer.from([n]));
const booleano = (v: boolean) => tlv(0x01, Buffer.from([v ? 255 : 0]));
const base128 = (n: number) => {
  const partes = [n & 0x7f];
  for (n >>= 7; n > 0; n >>= 7) partes.unshift((n & 0x7f) | 0x80);
  return partes;
};
const contexto = (num: number, cuerpo: Buffer) =>
  tlv(num < 31 ? 0xa0 | num : [0xbf, ...base128(num)], cuerpo);
const oid = (punteado: string) => {
  const [a, b, ...resto] = punteado.split('.').map(Number);
  return tlv(
    0x06,
    Buffer.from([a * 40 + b, ...resto.flatMap((n) => base128(n))]),
  );
};
const nombre = (cn: string) =>
  seq(conjunto(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
const fecha = (ms: number) =>
  tlv(
    0x17,
    Buffer.from(
      new Date(ms)
        .toISOString()
        .replace(
          /^\d\d(\d\d)-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)\.\d+Z$/,
          '$1$2$3$4$5$6Z',
        ),
    ),
  );

const PAQUETE = 'com.uniride.app';
const FIRMA_APP = createHash('sha256').update('firma-de-uniride').digest('hex');
const DESAFIO = 'desafio-de-prueba-1234';
const AHORA = Date.UTC(2026, 10, 18, 12, 0, 0);
const HORA = 3_600_000;

interface Opciones {
  nivel?: number;
  bloqueado?: boolean;
  arranque?: number;
  desafio?: string;
  paquete?: string;
  firma?: string;
  creacionMs?: number;
  extension?: boolean;
}

function keyDescription(o: Opciones): Buffer {
  const nivel = o.nivel ?? 1;
  const aplicacion = seq(
    conjunto(seq(oct(o.paquete ?? PAQUETE), entero(1))),
    conjunto(oct(Buffer.from(o.firma ?? FIRMA_APP, 'hex'))),
  );
  const software = [contexto(709, oct(aplicacion))];
  if (o.creacionMs !== undefined)
    software.push(contexto(701, entero(o.creacionMs)));
  const raiz = seq(
    oct(Buffer.alloc(32, 7)),
    booleano(o.bloqueado ?? true),
    enumerado(o.arranque ?? 0),
    oct(Buffer.alloc(32, 9)),
  );
  return seq(
    entero(4),
    enumerado(nivel),
    entero(4),
    enumerado(nivel),
    oct(o.desafio ?? DESAFIO),
    oct(''),
    seq(...software),
    seq(contexto(704, raiz)),
  );
}

interface Emisor {
  clave: KeyObject;
  nombre: string;
}

function certificado(
  sujeto: string,
  clavePublica: KeyObject,
  emisor: Emisor,
  opciones: { desde?: number; hasta?: number; atestacion?: Opciones } = {},
): Buffer {
  const extensiones = opciones.atestacion
    ? [
        contexto(
          3,
          seq(
            seq(
              oid('1.3.6.1.4.1.11129.2.1.17'),
              oct(keyDescription(opciones.atestacion)),
            ),
          ),
        ),
      ]
    : [];
  const tbs = seq(
    contexto(0, entero(2)),
    entero(Math.floor(Math.random() * 1e9) + 1),
    seq(oid('1.2.840.10045.4.3.2')),
    nombre(emisor.nombre),
    seq(
      fecha(opciones.desde ?? AHORA - 24 * HORA),
      fecha(opciones.hasta ?? AHORA + 24 * HORA * 365),
    ),
    nombre(sujeto),
    Buffer.from(clavePublica.export({ type: 'spki', format: 'der' })),
    ...extensiones,
  );
  const firma = sign('sha256', tbs, emisor.clave);
  return seq(
    tbs,
    seq(oid('1.2.840.10045.4.3.2')),
    tlv(0x03, Buffer.concat([Buffer.from([0]), firma])),
  );
}

const par = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });

/** Una raíz propia (la de prueba), una intermedia y una hoja con la atestación pedida. */
function cadena(
  atestacion: Opciones = {},
  cambios: {
    intermediaHasta?: number;
    raizAjena?: boolean;
    sinRaiz?: boolean;
  } = {},
) {
  const raiz = par();
  const intermedia = par();
  const hoja = par();
  const emisorRaiz = { clave: raiz.privateKey, nombre: 'Raiz de prueba' };
  const raizDer = certificado('Raiz de prueba', raiz.publicKey, emisorRaiz);
  const intermediaDer = certificado(
    'Intermedia',
    intermedia.publicKey,
    emisorRaiz,
    { hasta: cambios.intermediaHasta },
  );
  const hojaDer = certificado(
    'Hoja',
    hoja.publicKey,
    { clave: intermedia.privateKey, nombre: 'Intermedia' },
    { atestacion },
  );
  const raicesConfiadas = cambios.raizAjena
    ? [
        new X509Certificate(
          certificado('Otra', par().publicKey, {
            clave: par().privateKey,
            nombre: 'Otra',
          }),
        ),
      ]
    : [new X509Certificate(raizDer)];
  const partes = cambios.sinRaiz
    ? [hojaDer, intermediaDer]
    : [hojaDer, intermediaDer, raizDer];
  return {
    token: partes.map((c) => c.toString('base64')).join(','),
    raices: raicesConfiadas,
    hojaDer,
  };
}

const verificador = (raices: X509Certificate[], firmas = [FIRMA_APP]) =>
  new AtestacionKeystore(PAQUETE, firmas, raices, () => AHORA);

describe('AtestacionKeystore', () => {
  it('CA-1: aprueba una atestación de TEE con el desafío, el paquete y la firma de la app', async () => {
    const { token, raices } = cadena({ creacionMs: AHORA - 1000 });
    await expect(
      verificador(raices).verificar(token, DESAFIO),
    ).resolves.toEqual({ integro: true, veredicto: 'KEY_ATTESTATION_TEE' });
  });

  it('CA-1: reconoce StrongBox', async () => {
    const { token, raices } = cadena({ nivel: 2 });
    await expect(
      verificador(raices).verificar(token, DESAFIO),
    ).resolves.toMatchObject({ veredicto: 'KEY_ATTESTATION_STRONGBOX' });
  });

  it('CA-1: acepta la cadena sin la raíz si la última la firma una raíz de confianza', async () => {
    const { token, raices } = cadena({}, { sinRaiz: true });
    await expect(
      verificador(raices).verificar(token, DESAFIO),
    ).resolves.toMatchObject({ integro: true });
  });

  const rechazos: [string, string, Opciones][] = [
    ['A-03 llave solo en software', 'dispositivo_no_integro', { nivel: 0 }],
    [
      'A-03 bootloader desbloqueado',
      'dispositivo_no_integro',
      { bloqueado: false },
    ],
    ['A-03 arranque autofirmado', 'dispositivo_no_integro', { arranque: 1 }],
    ['A-03 arranque no verificado', 'dispositivo_no_integro', { arranque: 2 }],
    ['A-03 paquete distinto', 'paquete', { paquete: 'com.falsa.app' }],
    [
      'A-03 firma de app distinta (app reempaquetada)',
      'paquete',
      { firma: createHash('sha256').update('otra').digest('hex') },
    ],
    ['A-05 desafío distinto', 'nonce', { desafio: 'otro-desafio-0000000' }],
    [
      'RN-4 llave creada hace mucho',
      'token_vencido',
      { creacionMs: AHORA - 10 * 60_000 },
    ],
  ];
  it.each(rechazos)('CA-2 a CA-4, %s', async (_nombre, motivo, atestacion) => {
    const { token, raices } = cadena(atestacion);
    await expect(
      verificador(raices).verificar(token, DESAFIO),
    ).resolves.toMatchObject({ integro: false, motivo });
  });

  it('CA-5: una raíz que no es la de Google se rechaza', async () => {
    const { token, raices } = cadena({}, { raizAjena: true });
    await expect(
      verificador(raices).verificar(token, DESAFIO),
    ).resolves.toMatchObject({ integro: false, motivo: 'cadena' });
  });

  it('CA-5: una cadena con un certificado vencido se rechaza', async () => {
    const { token, raices } = cadena(
      {},
      { intermediaHasta: AHORA - 3 * 24 * HORA },
    );
    await expect(
      verificador(raices).verificar(token, DESAFIO),
    ).resolves.toMatchObject({ integro: false, motivo: 'cadena' });
  });

  it('CA-5: un certificado de la hoja alterado rompe la firma', async () => {
    const { token, raices, hojaDer } = cadena();
    const alterado = Buffer.from(hojaDer);
    alterado[alterado.indexOf(Buffer.from('Hoja')) + 1] ^= 1;
    const partes = token.split(',');
    partes[0] = alterado.toString('base64');
    await expect(
      verificador(raices).verificar(partes.join(','), DESAFIO),
    ).resolves.toMatchObject({ integro: false });
  });

  it('CA-5: la hoja sin su intermedia (cadena rota) se rechaza', async () => {
    const { token, raices } = cadena();
    const [hoja, , raiz] = token.split(',');
    await expect(
      verificador(raices).verificar(`${hoja},${raiz}`, DESAFIO),
    ).resolves.toMatchObject({ integro: false });
  });

  it('CA-6 / A-08: vacío, basura, una sola cadena o gigante nunca se aprueban', async () => {
    const { token, raices } = cadena();
    const v = verificador(raices);
    for (const malo of [
      '',
      'basura',
      'simulado:integro',
      ',',
      token.split(',')[0],
      'A'.repeat(30_000),
      token.split(',').reverse().join(','),
    ])
      await expect(v.verificar(malo, DESAFIO)).resolves.toMatchObject({
        integro: false,
      });
  });

  it('RN-3: sin paquete o sin firma configurados falla cerrado con 503', async () => {
    const { token, raices } = cadena();
    for (const v of [
      new AtestacionKeystore('', [FIRMA_APP], raices),
      new AtestacionKeystore(PAQUETE, [], raices),
    ])
      await expect(v.verificar(token, DESAFIO)).rejects.toMatchObject({
        codigo: 'SERVICIO_NO_DISPONIBLE',
      });
  });

  it('las raíces de Google incluidas se leen', () => {
    expect(cargarRaicesGoogle().length).toBeGreaterThanOrEqual(2);
  });
});

describe('crearPlayIntegrity', () => {
  it('por defecto usa la atestación del Keystore', () => {
    expect(crearPlayIntegrity({})).toBeInstanceOf(AtestacionKeystore);
    expect(crearPlayIntegrity({ MODO_EMULADOR_DEV: 'false' })).toBeInstanceOf(
      AtestacionKeystore,
    );
  });

  it('MODO_EMULADOR_DEV=true fuera de producción usa la simulada', () => {
    expect(
      crearPlayIntegrity({
        MODO_EMULADOR_DEV: 'true',
        NODE_ENV: 'development',
      }),
    ).toBeInstanceOf(PlayIntegritySimulado);
  });

  it('CA-7 / A-03: MODO_EMULADOR_DEV=true con NODE_ENV=production hace fallar el arranque', () => {
    for (const valor of ['true', 'TRUE', ' true '])
      expect(() =>
        crearPlayIntegrity({
          MODO_EMULADOR_DEV: valor,
          NODE_ENV: 'production',
        }),
      ).toThrow(/prohibido en producción/);
  });

  it('en producción con el bypass apagado y la firma configurada arranca con la real', () => {
    expect(
      crearPlayIntegrity({
        NODE_ENV: 'production',
        ATESTACION_PAQUETE: PAQUETE,
        ATESTACION_FIRMA_SHA256: `${FIRMA_APP.toUpperCase().match(/../g)!.join(':')}`,
      }),
    ).toBeInstanceOf(AtestacionKeystore);
  });
});
