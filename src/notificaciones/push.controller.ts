import { Body, Controller, Delete, HttpCode, Post, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';
import { UsuarioActual, type UsuarioToken } from '../comun/decoradores.js';
import { PrismaService } from '../comun/prisma.service.js';
import { recortar } from '../comun/validaciones.js';
import { PushService } from './push.service.js';

export class TokenPushDto {
  @ApiProperty({ description: 'Token FCM del teléfono (registration token)' })
  @recortar()
  @IsString()
  @MaxLength(4096)
  @Matches(/^[\w:.-]+$/)
  token!: string;
}

/** PB-09: el teléfono con sesión registra su token FCM. Solo del propio usuario: no hay id en la ruta. */
@ApiTags('notificaciones')
@ApiBearerAuth()
@Controller('yo/token-push')
export class PushController {
  constructor(
    private readonly push: PushService,
    private readonly prisma: PrismaService,
  ) {}

  @Put()
  @HttpCode(204)
  @ApiOperation({ summary: 'Registra el token push del teléfono con sesión' })
  @ApiNoContentResponse()
  async guardar(
    @UsuarioActual() u: UsuarioToken,
    @Body() dto: TokenPushDto,
  ): Promise<void> {
    await this.push.guardarToken(u.id, dto.token);
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: 'Deja de enviar avisos a este usuario' })
  @ApiNoContentResponse()
  async quitar(@UsuarioActual() u: UsuarioToken): Promise<void> {
    await this.push.quitarToken(u.id);
  }

  @Post('prueba')
  @HttpCode(204)
  @ApiOperation({ summary: 'Envía un aviso de prueba al propio teléfono' })
  @ApiNoContentResponse()
  async probar(@UsuarioActual() u: UsuarioToken): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { nombreCompleto } = await tx.usuario.findUniqueOrThrow({
        where: { id: u.id },
        select: { nombreCompleto: true },
      });
      await this.push.encolar(tx, u.id, 'prueba', {
        nombre: nombreCompleto.trim().split(' ')[0],
      });
    });
  }
}
