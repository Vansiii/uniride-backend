import type { Response } from 'express';
import type { UsuarioToken } from '../comun/decoradores.js';
import { BilleteraController } from './billetera.controller.js';
import type { BilleteraService } from './billetera.service.js';

const USUARIO: UsuarioToken = { id: 'u1', org: null, cli: 'movil' };
const BILLETERA = {
  id: 'b1',
  direccion: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
  saldoUrc: '0.00',
  exploradorUrl: null,
};

function crear(creada: boolean) {
  const servicio = {
    crear: vi.fn().mockResolvedValue({ billetera: BILLETERA, creada }),
    mia: vi.fn().mockResolvedValue(BILLETERA),
  };
  const res = { status: vi.fn() };
  return {
    controlador: new BilleteraController(
      servicio as unknown as BilleteraService,
    ),
    servicio,
    res,
  };
}

describe('BilleteraController', () => {
  it.each([
    [true, 201],
    [false, 200],
  ])('POST con creada=%s responde %i', async (creada, estado) => {
    const { controlador, servicio, res } = crear(creada);
    const cuerpo = await controlador.crear(USUARIO, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(estado);
    expect(cuerpo).toBe(BILLETERA);
    expect(servicio.crear).toHaveBeenCalledWith(USUARIO.id);
  });

  it('GET mia consulta siempre al usuario del token', async () => {
    const { controlador, servicio } = crear(false);
    await expect(controlador.mia(USUARIO)).resolves.toBe(BILLETERA);
    expect(servicio.mia).toHaveBeenCalledWith(USUARIO.id);
  });
});
