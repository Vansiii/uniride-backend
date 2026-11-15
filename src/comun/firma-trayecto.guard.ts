import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UseGuards,
  applyDecorators,
  createParamDecorator,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErrorNegocio } from './error-negocio.js';
import {
  RegistroNonces,
  leerCabecerasFirma,
  verificarFirmaPeticion,
  type PeticionFirmada,
  type Rechazo,
} from './firma-dispositivo.guard.js';
import { OrganizacionGuard } from './organizacion.guard.js';
import { PrismaService } from './prisma.service.js';

export interface LlaveTrayectoFirmante {
  id: string;
  viajeId: string;
  /** Nulo para la llave del conductor. */
  reservaId: string | null;
}

type PeticionTrayecto = PeticionFirmada & {
  organizacionId?: string;
  llaveTrayecto?: LlaveTrayectoFirmante;
};

const trayectoInvalida = () =>
  new ErrorNegocio(
    401,
    'FIRMA_TRAYECTO_INVALIDA',
    'comun.errores.firma_invalida',
  );

/**
 * Exige la firma de una llave de trayecto (D-22, HU-22 RN-9): de la cuenta, vigente y de un dispositivo que siga
 * activo (HU-10 CA-9). Es la llave sin biometría que firma los desafíos del conductor; la huella se pidió al registrarla.
 * Va después de `OrganizacionGuard` (la llave es de la organización: RLS). Deja la llave en la petición; el servicio
 * comprueba que sea de ese viaje. Anti-oráculo igual que `FirmaDispositivoGuard`: un solo error salvo la ventana.
 */
@Injectable()
export class FirmaTrayectoGuard implements CanActivate {
  private readonly registro = new Logger(FirmaTrayectoGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly nonces: RegistroNonces,
  ) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const peticion = contexto.switchToHttp().getRequest<PeticionTrayecto>();
    const usuarioId = peticion.usuario?.id;
    const organizacionId = peticion.organizacionId;
    if (!usuarioId || !organizacionId) throw trayectoInvalida();

    const fallo = await this.comprobar(peticion, usuarioId, organizacionId);
    if (fallo === null) return true;
    this.auditoria
      .registrar({
        accion: 'trayecto.firma',
        entidad: 'llave_trayecto',
        resultado: 'fallo',
        actorId: usuarioId,
        organizacionId,
        detalle: { motivo: fallo.motivo },
      })
      .catch(() => this.registro.warn('No se pudo auditar la firma fallida'));
    throw fallo.error;
  }

  private async comprobar(
    peticion: PeticionTrayecto,
    usuarioId: string,
    organizacionId: string,
  ): Promise<Rechazo | null> {
    const cabeceras = leerCabecerasFirma(
      peticion,
      'x-llave-trayecto-id',
      trayectoInvalida,
    );
    if ('motivo' in cabeceras) return cabeceras;

    const llave = await this.prisma.enOrganizacion(organizacionId, (tx) =>
      tx.llaveTrayecto.findFirst({
        where: {
          id: cabeceras.id.toLowerCase(),
          usuarioId,
          revocadaEn: null,
          dispositivo: { activo: true, usuarioId },
        },
        select: {
          id: true,
          viajeId: true,
          reservaId: true,
          llavePublica: true,
        },
      }),
    );
    if (!llave) return { error: trayectoInvalida(), motivo: 'llave' };

    const fallo = verificarFirmaPeticion(
      peticion,
      cabeceras,
      llave.llavePublica,
      `trayecto:${llave.id}`,
      this.nonces,
      trayectoInvalida,
    );
    if (fallo) return fallo;
    peticion.llaveTrayecto = {
      id: llave.id,
      viajeId: llave.viajeId,
      reservaId: llave.reservaId,
    };
    return null;
  }
}

/** Organización y firma de la llave de trayecto, con sus cabeceras en Swagger. */
export const RequiereFirmaTrayecto = () =>
  applyDecorators(
    UseGuards(OrganizacionGuard, FirmaTrayectoGuard),
    ApiHeader({
      name: 'X-Llave-Trayecto-Id',
      description: 'Llave de trayecto registrada para este viaje.',
    }),
    ApiHeader({ name: 'X-Timestamp', description: 'Epoch en milisegundos.' }),
    ApiHeader({ name: 'X-Nonce', description: 'De un solo uso.' }),
    ApiHeader({
      name: 'X-Firma',
      description:
        'Firma ECDSA P-256 del mensaje canónico con la llave de trayecto, en Base64.',
    }),
  );

/** La llave que firmó, ya verificada por `FirmaTrayectoGuard`. */
export const LlaveTrayectoActual = createParamDecorator(
  (_: unknown, contexto: ExecutionContext): LlaveTrayectoFirmante =>
    contexto.switchToHttp().getRequest().llaveTrayecto,
);
