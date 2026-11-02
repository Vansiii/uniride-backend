import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { UsuarioActual, type UsuarioToken } from '../comun/decoradores.js';
import { ErrorNegocio } from '../comun/error-negocio.js';
import { PrismaService } from '../comun/prisma.service.js';

class MembresiaYoDto {
  @ApiProperty({ format: 'uuid' }) organizacionId!: string;
  @ApiProperty({ description: 'Nombre de la organización' })
  organizacion!: string;
  @ApiProperty({ enum: ['miembro', 'admin_organizacion'] }) rol!: string;
  @ApiProperty({ enum: ['pendiente', 'aprobada', 'rechazada'] })
  estado!: string;
}

class YoDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() nombreCompleto!: string;
  @ApiProperty() correo!: string;
  @ApiProperty({ type: String, nullable: true }) rolPlataforma!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  organizacionActiva!: string | null;
  @ApiProperty({
    type: [MembresiaYoDto],
    description: 'Todas las del usuario, en cada organización',
  })
  membresias!: MembresiaYoDto[];
}

@ApiTags('yo')
@ApiBearerAuth()
@Controller('yo')
export class YoController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOkResponse({ type: YoDto })
  async consultar(@UsuarioActual() actual: UsuarioToken): Promise<YoDto> {
    const u = await this.prisma.usuario.findUnique({
      where: { id: actual.id },
    });
    if (!u)
      throw new ErrorNegocio(
        401,
        'NO_AUTENTICADO',
        'comun.errores.no_autenticado',
      );
    // Son del propio usuario en todas sus organizaciones: se filtra por dueño y solo salen estos cuatro campos (HU-06 CA-7).
    const membresias = await this.prisma.comoSuperAdmin((tx) =>
      tx.membresia.findMany({
        where: { usuarioId: u.id },
        orderBy: { creadoEn: 'asc' },
        select: {
          organizacionId: true,
          rol: true,
          estado: true,
          organizacion: { select: { nombre: true } },
        },
      }),
    );
    return {
      id: u.id,
      nombreCompleto: u.nombreCompleto,
      correo: u.correo,
      rolPlataforma: u.rolPlataforma,
      organizacionActiva: u.ultimaOrganizacionId,
      membresias: membresias.map((m) => ({
        organizacionId: m.organizacionId,
        organizacion: m.organizacion.nombre,
        rol: m.rol,
        estado: m.estado,
      })),
    };
  }
}
