import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('salud')
@Controller('salud')
export class SaludController {
  @Get()
  @ApiOkResponse({ description: 'La API está en línea' })
  consultar(): { estado: 'ok' } {
    return { estado: 'ok' };
  }
}
