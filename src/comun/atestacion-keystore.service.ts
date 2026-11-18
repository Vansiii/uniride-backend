import { Logger } from '@nestjs/common';
import { X509Certificate } from 'node:crypto';
import { RAICES_GOOGLE_PEM } from './raices-atestacion.js';
import {
  PlayIntegritySimulado,
  PlayIntegrityService,
  rechazo,
  servicioNoDisponible,
  type ResultadoIntegridad,
} from './play-integrity.service.js';

/** OID de la extensión de atestación de Android (1.3.6.1.4.1.11129.2.1.17), en DER. */
const OID_ATESTACION = Buffer.from('060a2b06010401d679020111', 'hex');
const MAX_CERTIFICADOS = 6;
const MAX_TOKEN = 20_000;
const DIA_MS = 24 * 60 * 60 * 1000;
/** RN-4: la llave de atestación se creó hace poco (solo si el teléfono informa su fecha de creación). */
const VIDA_MAXIMA_MS = 5 * 60 * 1000;

const ETIQUETA_ARRANQUE = 704;
const ETIQUETA_APLICACION = 709;
const ETIQUETA_CREACION = 701;

interface Nodo {
  /** Número de etiqueta (universal o de contexto) y su cuerpo ya sin cabecera. */
  num: number;
  cuerpo: Buffer;
  fin: number;
}

/** Lee un elemento DER en `pos`; lanza si está truncado. */
function leer(b: Buffer, pos: number): Nodo {
  let i = pos;
  const primero = b[i++];
  let num = primero & 0x1f;
  if (num === 0x1f) {
    num = 0;
    let byte: number;
    do {
      byte = b[i++];
      num = (num << 7) | (byte & 0x7f);
    } while (byte & 0x80);
  }
  let largo = b[i++];
  if (largo & 0x80) {
    const n = largo & 0x7f;
    if (n < 1 || n > 3) throw new Error('DER inválido');
    largo = 0;
    for (let k = 0; k < n; k++) largo = (largo << 8) | b[i++];
  }
  if (!(largo >= 0) || i + largo > b.length) throw new Error('DER truncado');
  return { num, cuerpo: b.subarray(i, i + largo), fin: i + largo };
}

function hijos(b: Buffer): Nodo[] {
  const lista: Nodo[] = [];
  for (let pos = 0; pos < b.length;) {
    const nodo = leer(b, pos);
    lista.push(nodo);
    pos = nodo.fin;
  }
  return lista;
}

const entero = (b: Buffer) =>
  b.reduce((acumulado, byte) => acumulado * 256 + byte, 0);

interface Atestacion {
  nivelAtestacion: number;
  nivelKeymaster: number;
  desafio: Buffer;
  bloqueado: boolean;
  estadoArranque: number;
  paquetes: string[];
  firmas: string[];
  creacionMs?: number;
}

/** Extrae la `KeyDescription` del certificado hoja (A-03). Lanza si no tiene la forma esperada. */
function leerAtestacion(hoja: X509Certificate): Atestacion {
  const raw = hoja.raw;
  const donde = raw.indexOf(OID_ATESTACION);
  if (donde < 0) throw new Error('Sin extensión de atestación');
  let pos = donde + OID_ATESTACION.length;
  if (raw[pos] === 0x01) pos += 3; // BOOLEAN critical
  const descripcion = leer(leer(raw, pos).cuerpo, 0);
  const c = hijos(descripcion.cuerpo);
  const listas = [c[6], c[7]].flatMap((l) => (l ? hijos(l.cuerpo) : []));
  const buscar = (num: number) => listas.find((n) => n.num === num);

  const raiz = buscar(ETIQUETA_ARRANQUE);
  if (!raiz) throw new Error('Sin raíz de confianza');
  const r = hijos(leer(raiz.cuerpo, 0).cuerpo);

  const aplicacion = buscar(ETIQUETA_APLICACION);
  if (!aplicacion) throw new Error('Sin identificador de aplicación');
  const id = hijos(leer(leer(aplicacion.cuerpo, 0).cuerpo, 0).cuerpo);
  const paquetes = hijos(id[0].cuerpo).map((p) =>
    hijos(p.cuerpo)[0].cuerpo.toString('utf8'),
  );
  const firmas = hijos(id[1].cuerpo).map((f) => f.cuerpo.toString('hex'));

  const creacion = buscar(ETIQUETA_CREACION);
  return {
    nivelAtestacion: entero(c[1].cuerpo),
    nivelKeymaster: entero(c[3].cuerpo),
    desafio: c[4].cuerpo,
    bloqueado: r[1].cuerpo[0] !== 0,
    estadoArranque: entero(r[2].cuerpo),
    paquetes,
    firmas,
    creacionMs: creacion ? entero(leer(creacion.cuerpo, 0).cuerpo) : undefined,
  };
}

export const cargarRaicesGoogle = (): X509Certificate[] =>
  RAICES_GOOGLE_PEM.map((p) => new X509Certificate(p));

/**
 * Atestación de hardware del Android Keystore (Key Attestation). El `tokenIntegridad` es la cadena de certificados
 * de una llave generada por la app con el desafío del servidor, en DER base64 separados por comas (hoja primero).
 * Se verifica sin llamar a ningún servicio externo.
 */
export class AtestacionKeystore extends PlayIntegrityService {
  private readonly registro = new Logger(AtestacionKeystore.name);

  constructor(
    private readonly paquete: string,
    /** Huellas SHA-256 (hex en minúsculas) de la firma de la app. */
    private readonly firmas: string[],
    private readonly raices: X509Certificate[] = cargarRaicesGoogle(),
    private readonly ahora: () => number = Date.now,
  ) {
    super();
  }

  async verificar(
    tokenIntegridad: string,
    desafio: string,
  ): Promise<ResultadoIntegridad> {
    // Sin paquete o sin firma configurados no se puede atestar: falla cerrado, nunca aprueba.
    if (!this.paquete || this.firmas.length === 0) {
      this.registro.error(
        'ATESTACION_PAQUETE o ATESTACION_FIRMA_SHA256 no están configurados',
      );
      throw servicioNoDisponible();
    }
    return this.evaluar(tokenIntegridad, desafio);
  }

  private evaluar(token: string, desafio: string): ResultadoIntegridad {
    let cadena: X509Certificate[];
    let a: Atestacion;
    try {
      if (!token || token.length > MAX_TOKEN) return rechazo('token_invalido');
      const partes = token.split(',');
      if (partes.length < 2 || partes.length > MAX_CERTIFICADOS)
        return rechazo('token_invalido');
      cadena = partes.map((p) => new X509Certificate(Buffer.from(p, 'base64')));
      if (!this.cadenaValida(cadena)) return rechazo('cadena');
      a = leerAtestacion(cadena[0]);
    } catch {
      return rechazo('token_invalido');
    }
    const ahora = this.ahora();
    const motivo =
      a.desafio.toString('utf8') !== desafio
        ? 'nonce'
        : a.nivelAtestacion < 1 || a.nivelKeymaster < 1
          ? 'dispositivo_no_integro'
          : !a.bloqueado || a.estadoArranque !== 0
            ? 'dispositivo_no_integro'
            : !a.paquetes.includes(this.paquete) ||
                !a.firmas.some((f) => this.firmas.includes(f))
              ? 'paquete'
              : a.creacionMs !== undefined &&
                  Math.abs(ahora - a.creacionMs) > VIDA_MAXIMA_MS
                ? 'token_vencido'
                : undefined;
    if (motivo) return rechazo(motivo);
    return {
      integro: true,
      veredicto:
        a.nivelAtestacion === 2
          ? 'KEY_ATTESTATION_STRONGBOX'
          : 'KEY_ATTESTATION_TEE',
    };
  }

  /** Cada certificado lo firma el siguiente, todos vigentes, y el último es (o lo firma) una raíz de Google. */
  private cadenaValida(cadena: X509Certificate[]): boolean {
    const ahora = this.ahora();
    const vigente = (c: X509Certificate) =>
      Date.parse(c.validFrom) - DIA_MS <= ahora &&
      ahora <= Date.parse(c.validTo);
    if (!cadena.every(vigente)) return false;
    for (let i = 0; i < cadena.length - 1; i++)
      if (
        !cadena[i].checkIssued(cadena[i + 1]) ||
        !cadena[i].verify(cadena[i + 1].publicKey)
      )
        return false;
    const ultimo = cadena[cadena.length - 1];
    return this.raices.some(
      (raiz) =>
        raiz.raw.equals(ultimo.raw) ||
        (ultimo.checkIssued(raiz) && ultimo.verify(raiz.publicKey)),
    );
  }
}

/**
 * Elige la implementación al arrancar. `MODO_EMULADOR_DEV` es el único bypass (AGENTS.md §6):
 * desactivado por defecto y, con `NODE_ENV=production`, el arranque falla.
 */
export function crearPlayIntegrity(
  env: NodeJS.ProcessEnv = process.env,
): PlayIntegrityService {
  const emulador =
    (env.MODO_EMULADOR_DEV ?? '').trim().toLowerCase() === 'true';
  if (emulador) {
    if (env.NODE_ENV === 'production')
      throw new Error(
        'MODO_EMULADOR_DEV=true está prohibido en producción: la atestación de integridad no puede simularse.',
      );
    return new PlayIntegritySimulado();
  }
  const firmas = (env.ATESTACION_FIRMA_SHA256 ?? '')
    .split(',')
    .map((f) => f.replace(/[^0-9a-f]/gi, '').toLowerCase())
    .filter(Boolean);
  return new AtestacionKeystore(env.ATESTACION_PAQUETE ?? '', firmas);
}
