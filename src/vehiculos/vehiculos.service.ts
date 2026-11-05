import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { AlmacenamientoService } from '../comun/almacenamiento.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService } from '../comun/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type {
  RegistroVehiculoDto,
  VehiculoDto,
  VehiculoPublicoDto,
} from './dto/vehiculo.dto.js';
import {
  fotoInvalida,
  MAXIMO_FOTO_BYTES,
  tipoDeImagen,
  type FotoSubida,
} from './foto.js';
import { esPlacaValida, normalizarPlaca } from './placa.js';

// Ningún `select` incluye `claveS3Foto`: la foto y su clave nunca salen de la API (CA-7, D-20).
const PUBLICO = {
  placa: true,
  marca: true,
  modelo: true,
  color: true,
} satisfies Prisma.VehiculoSelect;
const DEL_DUENO = {
  id: true,
  ...PUBLICO,
  capacidad: true,
} satisfies Prisma.VehiculoSelect;

const datoInvalido = (campo: 'placa' | 'capacidad') =>
  new ErrorNegocio(
    400,
    'VEHICULO_DATO_INVALIDO',
    'vehiculos.registro.dato_invalido',
    { campo },
  );

@Injectable()
export class VehiculosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly almacenamiento: AlmacenamientoService,
  ) {}

  /**
   * CA-1 a CA-4: valida → comprueba placa y vehículo previo → sube la foto → inserta.
   * Si la inserción falla (p. ej. la misma placa a la vez), se borra la foto: nada queda a medias.
   */
  async registrar(
    propietarioId: string,
    dto: RegistroVehiculoDto,
    foto?: FotoSubida,
  ): Promise<VehiculoDto> {
    if (dto.aceptaUsoFoto !== true)
      throw new ErrorNegocio(
        400,
        'CONSENTIMIENTO_REQUERIDO',
        'vehiculos.registro.consentimiento_requerido',
      );
    const placa = normalizarPlaca(dto.placa);
    if (!esPlacaValida(placa)) throw datoInvalido('placa');
    if (!/^[1-6]$/.test(dto.capacidad)) throw datoInvalido('capacidad');
    const tipo =
      foto && foto.size <= MAXIMO_FOTO_BYTES ? tipoDeImagen(foto.buffer) : null;
    if (!foto || !tipo) throw fotoInvalida();

    // Hasta dos filas: la suya y la de la placa.
    const previos = await this.prisma.vehiculo.findMany({
      where: { OR: [{ propietarioId }, { placa }] },
      select: { propietarioId: true },
    });
    if (previos.length)
      throw await this.conflicto(
        propietarioId,
        previos.some((v) => v.propietarioId === propietarioId),
      );

    // Sin datos personales en la clave.
    const clave = `vehiculos/${randomUUID()}`;
    try {
      await this.almacenamiento.subir(clave, foto.buffer, tipo);
    } catch {
      throw new ErrorNegocio(
        503,
        'ALMACENAMIENTO_NO_DISPONIBLE',
        'vehiculos.registro.no_disponible',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const vehiculo = await tx.vehiculo.create({
          data: {
            propietarioId,
            placa,
            marca: dto.marca,
            modelo: dto.modelo,
            color: dto.color,
            capacidad: Number(dto.capacidad),
            claveS3Foto: clave,
            consentimientoFotoEn: new Date(),
          },
          select: DEL_DUENO,
        });
        await this.auditoria.registrar(
          {
            accion: 'vehiculo.registro',
            entidad: 'vehiculo',
            entidadId: vehiculo.id,
            resultado: 'ok',
            actorId: propietarioId,
            detalle: { placa },
          },
          tx,
        );
        return vehiculo;
      });
    } catch (error) {
      await this.almacenamiento.borrar(clave);
      const codigo = (error as { code?: string }).code;
      // CA-2 en paralelo: el UNIQUE decide quién gana; se averigua cuál de los dos chocó.
      if (codigo === 'P2002') {
        const propio = await this.prisma.vehiculo.findUnique({
          where: { propietarioId },
          select: { id: true },
        });
        throw await this.conflicto(propietarioId, Boolean(propio));
      }
      // El mensaje de la BD puede traer la fila completa, con la clave de la foto (D-20).
      throw new Error(`No se pudo registrar el vehículo (${codigo ?? 'BD'})`);
    }
  }

  /** El dueño ve su vehículo; sin vehículo, 404 (CA-6 de HU-17 lo usa para invitar a registrarlo). */
  async mio(propietarioId: string): Promise<VehiculoDto> {
    const vehiculo = await this.prisma.vehiculo.findUnique({
      where: { propietarioId },
      select: DEL_DUENO,
    });
    if (!vehiculo)
      throw new ErrorNegocio(
        404,
        'NO_ENCONTRADO',
        'comun.errores.no_encontrado',
      );
    return vehiculo;
  }

  /** Proyección para HU-17 y HU-18: lo único que ve otra persona (CA-7). */
  publicoDe(propietarioId: string): Promise<VehiculoPublicoDto | null> {
    return this.prisma.vehiculo.findUnique({
      where: { propietarioId },
      select: PUBLICO,
    });
  }

  /** RN-4 antes que RN-1: si ya tiene vehículo no importa de quién sea la placa. No se dice quién la tiene. */
  private async conflicto(
    propietarioId: string,
    yaTieneVehiculo: boolean,
  ): Promise<ErrorNegocio> {
    const motivo = yaTieneVehiculo ? 'ya_registrado' : 'placa_duplicada';
    await this.auditoria.registrar({
      accion: 'vehiculo.registro',
      entidad: 'vehiculo',
      resultado: 'fallo',
      actorId: propietarioId,
      detalle: { motivo },
    });
    return yaTieneVehiculo
      ? new ErrorNegocio(
          409,
          'VEHICULO_YA_REGISTRADO',
          'vehiculos.registro.ya_registrado',
        )
      : new ErrorNegocio(
          409,
          'VEHICULO_PLACA_DUPLICADA',
          'vehiculos.registro.placa_duplicada',
        );
  }
}
