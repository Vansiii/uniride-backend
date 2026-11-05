import { MotorFacialSimulado } from './motor-facial-simulado.js';

const imagen = (marca = '') =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(marca)]);

describe('MotorFacialSimulado', () => {
  it('la sesión que crea es una prueba de vida válida con el rostro genérico', async () => {
    const motor = new MotorFacialSimulado();
    const sesion = await motor.crearSesionLiveness();
    const r = await motor.obtenerResultadoLiveness(sesion);
    expect(r).toMatchObject({ exitosa: true, confianza: 99 });
    expect(await motor.compararRostros(r.imagenReferencia!, imagen())).toBe(98);
  });

  it('~spoof y las sesiones desconocidas fallan (A-01)', async () => {
    const motor = new MotorFacialSimulado();
    const sesion = await motor.crearSesionLiveness();
    for (const id of [`${sesion}~spoof`, 'otra-cosa', '', 'sim-abc'])
      expect(await motor.obtenerResultadoLiveness(id)).toMatchObject({
        exitosa: false,
        confianza: 5,
      });
  });

  it('~<id> liga la sesión a ese rostro y la comparación distingue rostros', async () => {
    const motor = new MotorFacialSimulado();
    const sesion = await motor.crearSesionLiveness();
    const { imagenReferencia } = await motor.obtenerResultadoLiveness(
      `${sesion}~ana`,
    );
    expect(
      await motor.compararRostros(imagenReferencia!, imagen('ROSTRO:ana')),
    ).toBe(98);
    expect(
      await motor.compararRostros(imagenReferencia!, imagen('ROSTRO:beto')),
    ).toBe(20);
  });

  it.each(['SIN_ROSTRO', 'BORROSA'])(
    'un carnet con %s es ilegible: no se compara ni se indexa',
    async (marca) => {
      const motor = new MotorFacialSimulado();
      expect(
        await motor.compararRostros(imagen('ROSTRO:a'), imagen(marca)),
      ).toBeNull();
      await expect(motor.indexarRostro(imagen(marca), 'u1')).rejects.toThrow();
    },
  );

  it('detecta el rostro de otra cuenta, no el propio, y deja de detectarlo al desindexar', async () => {
    const motor = new MotorFacialSimulado();
    const faceId = await motor.indexarRostro(imagen('ROSTRO:ana'), 'u1');
    expect(faceId).toMatch(/^sim-face-/);
    expect(await motor.buscarRostroDuplicado(imagen('ROSTRO:ana'), 'u2')).toBe(
      true,
    );
    expect(await motor.buscarRostroDuplicado(imagen('ROSTRO:ana'), 'u1')).toBe(
      false,
    );
    expect(await motor.buscarRostroDuplicado(imagen('ROSTRO:beto'), 'u2')).toBe(
      false,
    );
    await motor.desindexarRostro(faceId);
    expect(await motor.buscarRostroDuplicado(imagen('ROSTRO:ana'), 'u2')).toBe(
      false,
    );
  });
});
