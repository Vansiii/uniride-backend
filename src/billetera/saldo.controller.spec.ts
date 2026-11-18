import type { UsuarioToken } from '../comun/decoradores.js';
import type { ConciliacionService } from './conciliacion.service.js';
import type { ConsultaMovimientosDto } from './dto/saldo.dto.js';
import type { MovimientosService } from './movimientos.service.js';
import { SaldoController } from './saldo.controller.js';

const USUARIO: UsuarioToken = { id: 'u1', org: null, cli: 'movil' };

describe('SaldoController', () => {
  it('saldo y movimientos consultan siempre al usuario del token', async () => {
    const saldo = { moneda: 'URC' };
    const pagina = { items: [] };
    const conciliacion = { saldo: vi.fn().mockResolvedValue(saldo) };
    const movimientos = { listar: vi.fn().mockResolvedValue(pagina) };
    const controlador = new SaldoController(
      conciliacion as unknown as ConciliacionService,
      movimientos as unknown as MovimientosService,
    );
    const consulta = { pagina: 2, limite: 5 } as ConsultaMovimientosDto;

    await expect(controlador.saldo(USUARIO)).resolves.toBe(saldo);
    await expect(controlador.listar(USUARIO, consulta)).resolves.toBe(pagina);
    expect(conciliacion.saldo).toHaveBeenCalledWith('u1');
    expect(movimientos.listar).toHaveBeenCalledWith('u1', consulta);
  });
});
