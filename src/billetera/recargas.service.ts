import { Injectable } from '@nestjs/common';
import QRCode from 'qrcode';
import { AuditoriaService } from '../auditoria/auditoria.service.js';
import { PREFIJO_CLAVE_RECARGA } from '../blockchain/trabajos-onchain.service.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService } from '../comun/prisma.service.js';
import type { OrdenRecarga } from '../generated/prisma/client.js';
import { BilleteraService } from './billetera.service.js';
import type {
  EstadoOrden,
  OrdenRecargaCreadaDto,
  OrdenRecargaDto,
} from './dto/recarga.dto.js';
import { MovimientosService } from './movimientos.service.js';

const VIDA_ORDEN_MS = 15 * 60_000;
const MONTO_MINIMO = 10;
const MONTO_MAXIMO = 500;

/** RN-1 y RN-7: lo que llegó se valida sin redondear. `String` da `1e-7` o `1e+21`, que tampoco pasan. */
export function montoDeRecarga(monto: number): string {
  if (!/^-?\d+(\.\d{1,2})?$/.test(String(monto)))
    throw new ErrorNegocio(
      400,
      'MONTO_INVALIDO',
      'billetera.recarga.monto_invalido',
    );
  if (monto < MONTO_MINIMO || monto > MONTO_MAXIMO)
    throw new ErrorNegocio(
      400,
      'MONTO_FUERA_DE_RANGO',
      'billetera.recarga.monto_fuera_de_rango',
    );
  return monto.toFixed(2);
}

const aDto = (o: OrdenRecarga): OrdenRecargaDto => ({
  ordenId: o.id,
  monto: o.monto.toFixed(2),
  estado: o.estado as EstadoOrden,
  expiraEn: o.expiraEn,
  hashTx: o.hashTx,
});

/** Las órdenes se buscan siempre con el usuario del token: la de otra persona no existe para ti (A-10). */
@Injectable()
export class RecargasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billeteras: BilleteraService,
    private readonly movimientos: MovimientosService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async crear(
    usuarioId: string,
    monto: number,
  ): Promise<OrdenRecargaCreadaDto> {
    const montoValido = montoDeRecarga(monto);
    const { id: billeteraId } = await this.billeteras.exigir(usuarioId);
    const orden = await this.prisma.ordenRecarga.create({
      data: {
        usuarioId,
        billeteraId,
        monto: montoValido,
        expiraEn: new Date(Date.now() + VIDA_ORDEN_MS),
      },
    });
    const qrTexto = `uniride://recarga/${orden.id}`;
    const imagen = await QRCode.toBuffer(qrTexto);
    return {
      ...aDto(orden),
      qrTexto,
      qrImagenBase64: imagen.toString('base64'),
    };
  }

  async consultar(usuarioId: string, id: string): Promise<OrdenRecargaDto> {
    return aDto(await this.leer(usuarioId, id));
  }

  /**
   * Idempotente (A-09): el `UPDATE` condicional deja ganar a una sola confirmación, que escribe orden, movimiento y
   * trabajo juntos. Las demás, y las repeticiones, responden el estado actual.
   */
  async confirmar(usuarioId: string, id: string): Promise<OrdenRecargaDto> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.ordenRecarga.updateMany({
        where: {
          id,
          usuarioId,
          estado: 'pendiente',
          expiraEn: { gt: new Date() },
        },
        data: { estado: 'procesando' },
      });
      if (count === 0) return;
      const orden = await tx.ordenRecarga.findUniqueOrThrow({ where: { id } });
      const monto = orden.monto.toFixed(2);
      const { movimiento } = await this.movimientos.registrar(
        {
          billeteraId: orden.billeteraId,
          tipo: 'recarga',
          monto,
          claveIdempotencia: `${PREFIJO_CLAVE_RECARGA}${id}`,
        },
        tx,
      );
      await tx.trabajoOnchain.create({
        data: { movimientoId: movimiento.id, operacion: 'acunar_recarga' },
      });
      await this.auditoria.registrar(
        {
          accion: 'billetera.recarga.confirmada',
          entidad: 'orden_recarga',
          entidadId: id,
          resultado: 'ok',
          actorId: usuarioId,
          detalle: { monto },
        },
        tx,
      );
    });

    const orden = await this.leer(usuarioId, id);
    if (orden.estado === 'expirada')
      throw new ErrorNegocio(
        410,
        'ORDEN_EXPIRADA',
        'billetera.recarga.orden_expirada',
      );
    return aDto(orden);
  }

  /** La orden vencida pasa a `expirada` al leerla; una en `procesando` ya no vence (CA-5). */
  private async leer(usuarioId: string, id: string): Promise<OrdenRecarga> {
    await this.prisma.ordenRecarga.updateMany({
      where: {
        id,
        usuarioId,
        estado: 'pendiente',
        expiraEn: { lte: new Date() },
      },
      data: { estado: 'expirada' },
    });
    const orden = await this.prisma.ordenRecarga.findFirst({
      where: { id, usuarioId },
    });
    if (!orden)
      throw new ErrorNegocio(
        404,
        'NO_ENCONTRADO',
        'comun.errores.no_encontrado',
      );
    return orden;
  }
}
