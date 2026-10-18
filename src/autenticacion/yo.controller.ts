import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UsuarioActual, type UsuarioToken } from '../comun/decoradores.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService } from '../comun/prisma.service.js';

@ApiTags('yo')
@ApiBearerAuth()
@Controller('yo')
export class YoController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async consultar(@UsuarioActual() actual: UsuarioToken) {
    const u = await this.prisma.usuario.findUnique({
      where: { id: actual.id },
    });
    if (!u)
      throw new ErrorNegocio(
        401,
        'NO_AUTENTICADO',
        'comun.errores.no_autenticado',
      );
    return {
      id: u.id,
      nombreCompleto: u.nombreCompleto,
      correo: u.correo,
      rolPlataforma: u.rolPlataforma,
      organizacionActiva: u.ultimaOrganizacionId,
      // ponytail: vacío hasta que HU-05 cree `membresias`; ahí se llena con el estado por organización (CA-7).
      membresias: [] as unknown[],
    };
  }
}
