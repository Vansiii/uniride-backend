import { Controller, Get } from '@nestjs/common';
import { Publico } from '../comun/decoradores.js';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('salud')
@Controller('salud')
export class SaludController {
  @Publico()
  @Get()
  @ApiOkResponse({ description: 'La API está en línea' })
  consultar(): { estado: 'ok' } {
    return { estado: 'ok' };
  }
}
