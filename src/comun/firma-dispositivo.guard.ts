import {
  createHash,
  createPublicKey,
  verify as verificarFirma,
} from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  Module,
  SetMetadata,
  UseGuards,
  applyDecorators,
  type Type,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiExtension, ApiHeader } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import type { UsuarioToken } from './decoradores.js';
import { ErrorNegocio } from './error-negocio.js';
import { PrismaService } from './prisma.service.js';

/** Ventana de tolerancia de `X-Timestamp` (RN-4). */
export const VENTANA_MS = 30_000;
/**
 * Vida de un nonce registrado. Una petición con `X-Timestamp` hasta 30 s en el futuro sigue siendo válida
 * hasta 60 s después de llegar; 90 s cubre ese peor caso con margen (el plan pide al menos 60 s).
 */
export const VIDA_NONCE_MS = 90_000;

const firmaInvalida = () =>
  new ErrorNegocio(
    401,
    'FIRMA_DISPOSITIVO_INVALIDA',
    'comun.errores.firma_invalida',
  );
const peticionExpirada = () =>
  new ErrorNegocio(401, 'PETICION_EXPIRADA', 'comun.errores.peticion_expirada');

const ES_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ES_MARCA = /^\d{1,16}$/;
/** El nonce entra tal cual en el mensaje firmado: solo caracteres seguros y de longitud razonable. */
const ES_NONCE = /^[A-Za-z0-9+/_=-]{16,128}$/;
const ES_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Nonces vistos por dispositivo. Un solo proceso: ver nota `ponytail:` abajo.
 * Es un singleton por `FirmaDispositivoModule`; los módulos que usan el guard deben importar ese módulo.
 */
@Injectable()
export class RegistroNonces {
  // ponytail: en memoria de una sola instancia (se pierde al reiniciar). Con varias réplicas, mover a Redis/BD con TTL.
  // Todos viven VIDA_NONCE_MS desde que llegan, así que el Map (orden de inserción) sale ordenado por vencimiento
  // y la limpieza solo recorre los vencidos: el tamaño queda acotado por (peticiones firmadas válidas × 90 s).
  private readonly vistos = new Map<string, number>();

  /** Atómico (sin `await` entre la consulta y el registro): `false` si el nonce ya se usó. */
  registrar(dispositivoId: string, nonce: string, ahora = Date.now()): boolean {
    for (const [clave, vence] of this.vistos) {
      if (vence > ahora) break;
      this.vistos.delete(clave);
    }
    const clave = `${dispositivoId}:${nonce}`;
    if (this.vistos.has(clave)) return false;
    this.vistos.set(clave, ahora + VIDA_NONCE_MS);
    return true;
  }
}

/**
 * Mensaje canónico que firma la app (RN-4):
 * `METODO\nRUTA\nTIMESTAMP\nNONCE\nSHA256hex(CUERPO)`, donde RUTA es la ruta completa con `/api/v1`
 * y la query tal como llega, sin host; el cuerpo vacío se hashea como cadena vacía.
 */
export function mensajeCanonico(
  metodo: string,
  ruta: string,
  marca: string,
  nonce: string,
  cuerpo: Buffer,
): string {
  const hash = createHash('sha256').update(cuerpo).digest('hex');
  return `${metodo.toUpperCase()}\n${ruta}\n${marca}\n${nonce}\n${hash}`;
}

type PeticionFirmada = Request & {
  usuario?: UsuarioToken;
  rawBody?: Buffer;
};

/**
 * Exige que la petición venga firmada por el dispositivo ACTIVO de la cuenta autenticada (A-04, A-05, A-08).
 * Va después del `JwtGuard` global: usa `request.usuario.id` para cargar la llave pública registrada.
 *
 * Encabezados: `X-Dispositivo-Id`, `X-Timestamp` (epoch ms), `X-Nonce`, `X-Firma` (Base64).
 * La firma es ECDSA P-256 con SHA-256 en formato DER (el que produce Android Keystore); el formato
 * P1363 (r||s) se rechaza a propósito para tener una sola codificación aceptada.
 * No depende de la unicidad de la firma (en DER es maleable): el anti-replay es el nonce.
 *
 * Anti-oráculo: toda falla responde 401 `FIRMA_DISPOSITIVO_INVALIDA` con el mismo mensaje, salvo la
 * ventana vencida o el nonce repetido (`PETICION_EXPIRADA`, exigido por CA-5). El motivo exacto va solo a auditoría.
 */
@Injectable()
export class FirmaDispositivoGuard implements CanActivate {
  private readonly registro = new Logger(FirmaDispositivoGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly nonces: RegistroNonces,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const peticion = contexto.switchToHttp().getRequest<PeticionFirmada>();
    const usuarioId = peticion.usuario?.id;
    // Sin sesión no hay a quién atribuirle un dispositivo: el JwtGuard debió cortar antes.
    if (!usuarioId) throw firmaInvalida();

    const fallo = await this.comprobar(peticion, usuarioId);
    if (fallo === null) return true;
    const accion = this.reflector.get<string | undefined>(
      ACCION_SENSIBLE,
      contexto.getHandler(),
    );
    this.auditarFallo(usuarioId, fallo.motivo, accion);
    throw fallo.error;
  }

  /** `null` si todo cuadra; si no, el error a responder y el motivo para auditoría. */
  private async comprobar(
    peticion: PeticionFirmada,
    usuarioId: string,
  ): Promise<{ error: ErrorNegocio; motivo: string } | null> {
    const rechazo = (motivo: string, error = firmaInvalida()) => ({
      error,
      motivo,
    });
    const cabecera = (nombre: string) => {
      const valor = peticion.headers[nombre];
      return typeof valor === 'string' ? valor : '';
    };
    const dispositivoId = cabecera('x-dispositivo-id');
    const marca = cabecera('x-timestamp');
    const nonce = cabecera('x-nonce');
    const firma = cabecera('x-firma');
    if (
      !ES_UUID.test(dispositivoId) ||
      !ES_MARCA.test(marca) ||
      !ES_NONCE.test(nonce) ||
      !ES_BASE64.test(firma)
    )
      return rechazo('cabeceras');

    // Un cuerpo que Express no entregó crudo (p. ej. multipart) no se puede firmar: se rechaza en vez de firmar "vacío".
    const cuerpo = peticion.rawBody ?? Buffer.alloc(0);
    if (!peticion.rawBody && Number(peticion.headers['content-length']) > 0)
      return rechazo('cuerpo_no_firmable');

    const dispositivo = await this.prisma.dispositivo.findFirst({
      where: { usuarioId, activo: true },
      select: { id: true, llavePublica: true },
    });
    // Debe ser el dispositivo activo DE ESTA CUENTA; el de otra persona o uno inactivo no existe para este usuario.
    if (!dispositivo || dispositivo.id !== dispositivoId.toLowerCase())
      return rechazo('dispositivo');

    const ahora = Date.now();
    if (Math.abs(ahora - Number(marca)) > VENTANA_MS)
      return rechazo('ventana', peticionExpirada());

    const mensaje = mensajeCanonico(
      peticion.method,
      peticion.originalUrl,
      marca,
      nonce,
      cuerpo,
    );
    let valida = false;
    try {
      valida = verificarFirma(
        'sha256',
        Buffer.from(mensaje),
        createPublicKey(dispositivo.llavePublica),
        Buffer.from(firma, 'base64'),
      );
    } catch {
      valida = false;
    }
    if (!valida) return rechazo('firma');

    // El nonce se registra solo con la firma ya válida: quien no tiene la llave no puede "quemar" nonces ajenos.
    if (!this.nonces.registrar(dispositivo.id, nonce, ahora))
      return rechazo('nonce_repetido', peticionExpirada());

    this.marcarUso(dispositivo.id);
    return null;
  }

  /** El último uso es informativo: si falla, la petición sigue. */
  private marcarUso(dispositivoId: string): void {
    this.prisma.dispositivo
      .update({
        where: { id: dispositivoId },
        data: { ultimoUsoEn: new Date() },
      })
      .catch(() => this.registro.warn('No se pudo registrar el último uso'));
  }

  /** Sin datos sensibles: ni firma, ni nonce, ni ruta. Una falla al auditar no cambia la respuesta. */
  private auditarFallo(
    usuarioId: string,
    motivo: string,
    accionSensible?: string,
  ): void {
    this.auditoria
      .registrar({
        accion: 'dispositivo.firma',
        entidad: 'dispositivo',
        resultado: 'fallo',
        actorId: usuarioId,
        detalle: accionSensible ? { motivo, accionSensible } : { motivo },
      })
      .catch(() => this.registro.warn('No se pudo auditar la firma fallida'));
  }
}

/** Las cabeceras de la firma en Swagger. */
export const CabecerasFirma = () =>
  applyDecorators(
    ApiHeader({
      name: 'X-Dispositivo-Id',
      description: 'Dispositivo vinculado.',
    }),
    ApiHeader({ name: 'X-Timestamp', description: 'Epoch en milisegundos.' }),
    ApiHeader({ name: 'X-Nonce', description: 'De un solo uso.' }),
    ApiHeader({
      name: 'X-Firma',
      description: 'Firma ECDSA P-256 del mensaje canónico, en Base64.',
    }),
  );

/** Exige firma del dispositivo sin ser una acción sensible de la RN-1 de HU-29 (p. ej. `GET /billetera/mia`, decisión de HU-12). */
export const RequiereFirmaDispositivo = () =>
  applyDecorators(UseGuards(FirmaDispositivoGuard), CabecerasFirma());

/** Metadato con el nombre de la acción sensible; lo leen el guard (auditoría) y la prueba de catálogo (HU-29 CA-7). */
export const ACCION_SENSIBLE = 'uniride:accion-sensible';
/** Extensión de Swagger que `configurarAplicacion` convierte en el texto de la operación. */
export const EXTENSION_ACCION_SENSIBLE = 'x-accion-sensible';
export const TEXTO_ACCION_SENSIBLE =
  'Requiere firma biométrica del teléfono vinculado.';

/**
 * Acción que mueve dinero o verifica un viaje (HU-29 RN-1): pide la firma del teléfono vinculado, cuya llave solo
 * firma tras la huella o el rostro. `antes` son los guards que deben correr primero (organización, cuenta, identidad),
 * para que quien no cumple reciba su 403 antes que el 401 de la firma; se pasan aquí porque el orden de varios
 * `@UseGuards` en un método depende del orden de los decoradores.
 */
// Solo en métodos: el guard y el catálogo leen la marca del handler, no de la clase.
export const AccionSensible = (
  nombre: string,
  ...antes: Type<CanActivate>[]
): MethodDecorator =>
  applyDecorators(
    SetMetadata(ACCION_SENSIBLE, nombre),
    UseGuards(...antes, FirmaDispositivoGuard),
    ApiExtension(EXTENSION_ACCION_SENSIBLE, nombre),
    CabecerasFirma(),
  );

/** Los módulos con endpoints `@AccionSensible` o `@RequiereFirmaDispositivo()` (HU-12, HU-13, HU-17...) importan este módulo. */
@Module({
  providers: [RegistroNonces, FirmaDispositivoGuard],
  exports: [RegistroNonces, FirmaDispositivoGuard],
})
export class FirmaDispositivoModule {}
