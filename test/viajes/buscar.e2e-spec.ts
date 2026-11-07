import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import { ayudasViajes, cuerpoViaje, enMs, HORA_MS } from './ayudas-viajes.js';

const MINUTO_MS = 60_000;

describe('HU-18 · buscar viajes (e2e)', () => {
  let e: Entorno;
  const v = ayudasViajes(() => e);
  let org: string;
  let pasajero: string;
  /** Cada prueba busca en su propia zona: los viajes de las demás quedan a más de 1 km. */
  let zona = 0;
  const lngBase = -63.18;
  const nuevaLat = () => -18 - ++zona * 0.1;

  beforeAll(async () => {
    e = await prepararEntorno();
    org = (await v.organizacion('Buscar A')).id;
    pasajero = (await v.conductor(org)).token;
  });
  afterAll(async () => {
    await e.cerrar();
  });

  const publicarEn = async (origenLat: number, extra: object = {}) => {
    const c = await v.conductor(org);
    const fechaHoraSalida = enMs(3 * HORA_MS);
    const { body } = await v
      .publicar(
        c,
        cuerpoViaje({
          origenLat,
          origenLng: lngBase,
          fechaHoraSalida,
          ...extra,
        }),
      )
      .expect(201);
    return { id: body.id as string, conductor: c, fechaHoraSalida };
  };
  const ids = (r: { body: { id: string }[] }) => r.body.map((x) => x.id);
  const buscarEn = (
    origenLat: number,
    horaSalida: string,
    origenLng = lngBase,
  ) => v.buscar(pasajero, { origenLat, origenLng, horaSalida });

  describe('CA-1 · radio de 1 km y ventana de ± 30 minutos', () => {
    it('al pie del límite: a 999 m aparece y a 1001 m no', async () => {
      const lat = nuevaLat();
      const { id, fechaHoraSalida } = await publicarEn(lat);
      const dentro = await buscarEn(lat + 0.00899, fechaHoraSalida).expect(200);
      expect(ids(dentro)).toEqual([id]);
      expect(dentro.body[0].distanciaKm).toBe(1);
      const fuera = await buscarEn(lat + 0.009, fechaHoraSalida).expect(200);
      expect(ids(fuera)).toEqual([]);
    });

    it('la longitud se corrige por la latitud: 0,0094° son 995 m aquí, no 1045 m', async () => {
      const lat = nuevaLat();
      const { id, fechaHoraSalida } = await publicarEn(lat);
      const r = await buscarEn(lat, fechaHoraSalida, lngBase + 0.0094);
      expect(ids(r)).toEqual([id]);
    });

    it('la ventana incluye ± 30 minutos justos y nada más', async () => {
      const lat = nuevaLat();
      const { id, fechaHoraSalida } = await publicarEn(lat);
      const salida = new Date(fechaHoraSalida).getTime();
      const a = (ms: number) => new Date(salida + ms).toISOString();
      for (const dentro of [30 * MINUTO_MS, -30 * MINUTO_MS])
        expect(ids(await buscarEn(lat, a(dentro)).expect(200))).toEqual([id]);
      for (const fuera of [30 * MINUTO_MS + 1, -30 * MINUTO_MS - 1])
        expect(ids(await buscarEn(lat, a(fuera)).expect(200))).toEqual([]);
    });

    it('una hora con otra zona horaria es el mismo instante', async () => {
      const lat = nuevaLat();
      const { id, fechaHoraSalida } = await publicarEn(lat);
      const local = new Date(new Date(fechaHoraSalida).getTime() - 4 * HORA_MS)
        .toISOString()
        .replace('Z', '-04:00');
      expect(ids(await buscarEn(lat, local).expect(200))).toEqual([id]);
    });

    it('sale ordenado por hora de salida', async () => {
      const lat = nuevaLat();
      const salida = Date.now() + 3 * HORA_MS;
      const iso = (ms: number) => new Date(salida + ms).toISOString();
      const tarde = await publicarEn(lat, {
        fechaHoraSalida: iso(10 * MINUTO_MS),
      });
      const pronto = await publicarEn(lat, { fechaHoraSalida: iso(0) });
      expect(ids(await buscarEn(lat, iso(5 * MINUTO_MS)).expect(200))).toEqual([
        pronto.id,
        tarde.id,
      ]);
    });

    // Estas coordenadas dan 1,0000000000000002 y -1,0000000000000002 en la fórmula: sin acotar, acos falla y responde 500.
    it('buscar desde el punto exacto de salida responde, con distancia 0', async () => {
      const { id, fechaHoraSalida } = await publicarEn(-17.698356);
      const r = await buscarEn(-17.698356, fechaHoraSalida).expect(200);
      expect(ids(r)).toEqual([id]);
      expect(r.body[0].distanciaKm).toBe(0);
    });

    it('buscar desde el punto opuesto del planeta responde vacío', async () => {
      const { fechaHoraSalida } = await publicarEn(-17.698356);
      const r = await buscarEn(17.698356, fechaHoraSalida, lngBase + 180);
      expect(r.status).toBe(200);
      expect(r.body).toEqual([]);
    });
  });

  describe('CA-2 y RN-4 · datos públicos del viaje', () => {
    it('trae lo que ve el pasajero y solo eso', async () => {
      const lat = nuevaLat();
      const { id, conductor, fechaHoraSalida } = await publicarEn(lat);
      await e.bd.query(
        `UPDATE usuarios SET nombre_completo = 'Juan Carlos Pérez Soliz' WHERE id = $1`,
        [conductor.id],
      );
      const r = await buscarEn(lat, fechaHoraSalida).expect(200);
      const { rows } = await e.bd.query(
        `SELECT placa FROM vehiculos WHERE propietario_id = $1`,
        [conductor.id],
      );
      expect(r.body).toEqual([
        {
          id,
          origenNombre: 'Plaza 24 de Septiembre',
          distanciaKm: 0,
          destinoNombre: 'UAGRM, Módulos',
          fechaHoraSalida,
          cuposDisponibles: 3,
          precioPorAsiento: 10.5,
          conductor: {
            nombre: 'Juan',
            verificado: true,
            calificacionPromedio: null,
            esNuevo: true,
            miembroDesde: expect.any(String),
          },
          vehiculo: {
            placa: rows[0].placa,
            marca: 'Toyota',
            modelo: 'Corolla',
            color: 'Blanco',
          },
        },
      ]);
      const texto = JSON.stringify(r.body);
      for (const sensible of ['clave-secreta-s3', 'Pérez', '@', 'hash-'])
        expect(texto).not.toContain(sensible);
    });

    it('el detalle tampoco da el nombre completo', async () => {
      const lat = nuevaLat();
      const { id, conductor } = await publicarEn(lat);
      await e.bd.query(
        `UPDATE usuarios SET nombre_completo = 'Juan Carlos Pérez Soliz' WHERE id = $1`,
        [conductor.id],
      );
      const d = await v.detalle(pasajero, id).expect(200);
      expect(d.body.conductor).toEqual({ nombre: 'Juan' });
    });
  });

  describe('CA-4 · lo que ya no se puede tomar no aparece', () => {
    const cambiar = (id: string, set: string) =>
      e.bd.query(`UPDATE viajes SET ${set} WHERE id = $1`, [id]);

    it('sin cupos', async () => {
      const lat = nuevaLat();
      const { id, fechaHoraSalida } = await publicarEn(lat);
      await cambiar(id, 'cupos_disponibles = 0');
      expect(ids(await buscarEn(lat, fechaHoraSalida).expect(200))).toEqual([]);
    });

    it('cuya hora de salida ya pasó, aunque siga dentro de la ventana y en `publicado`', async () => {
      const lat = nuevaLat();
      const { id } = await publicarEn(lat);
      await cambiar(id, `fecha_hora_salida = now() - interval '1 minute'`);
      expect(ids(await buscarEn(lat, enMs(0)).expect(200))).toEqual([]);
    });

    it('`reservado` con cupos aparece', async () => {
      const lat = nuevaLat();
      const { id, fechaHoraSalida } = await publicarEn(lat);
      await cambiar(id, `estado = 'reservado'`);
      expect(ids(await buscarEn(lat, fechaHoraSalida).expect(200))).toEqual([
        id,
      ]);
    });

    it.each(['en_curso', 'verificado', 'pagado', 'cancelado', 'expirado'])(
      '`%s` no aparece',
      async (estado) => {
        const lat = nuevaLat();
        const { id, fechaHoraSalida } = await publicarEn(lat);
        await cambiar(id, `estado = '${estado}'`);
        expect(ids(await buscarEn(lat, fechaHoraSalida).expect(200))).toEqual(
          [],
        );
      },
    );

    it('de un conductor con la cuenta suspendida no aparece, y vuelve al reactivarla', async () => {
      const lat = nuevaLat();
      const { id, conductor, fechaHoraSalida } = await publicarEn(lat);
      await e.bd.query(
        `UPDATE usuarios SET suspendida_en = now() WHERE id = $1`,
        [conductor.id],
      );
      expect(ids(await buscarEn(lat, fechaHoraSalida).expect(200))).toEqual([]);
      await e.bd.query(
        `UPDATE usuarios SET suspendida_en = NULL WHERE id = $1`,
        [conductor.id],
      );
      expect(ids(await buscarEn(lat, fechaHoraSalida).expect(200))).toEqual([
        id,
      ]);
    });
  });

  describe('CA-5 · conductor sin reseñas (D-17)', () => {
    it('sale verificado y nuevo, sin calificación', async () => {
      const lat = nuevaLat();
      const { fechaHoraSalida } = await publicarEn(lat);
      const r = await buscarEn(lat, fechaHoraSalida).expect(200);
      expect(r.body[0].conductor).toMatchObject({
        verificado: true,
        esNuevo: true,
        calificacionPromedio: null,
      });
    });

    it('un conductor que perdió la verificación no sale como verificado', async () => {
      const lat = nuevaLat();
      const { conductor, fechaHoraSalida } = await publicarEn(lat);
      await e.bd.query(
        `UPDATE identidades SET estado = 'rechazada' WHERE usuario_id = $1`,
        [conductor.id],
      );
      const r = await buscarEn(lat, fechaHoraSalida).expect(200);
      expect(r.body[0].conductor.verificado).toBe(false);
    });
  });

  describe('CA-6 · rendimiento', () => {
    it('con más de 50 viajes en la zona responde en menos de 2 s y con el tope', async () => {
      const lat = nuevaLat();
      const { conductor, fechaHoraSalida } = await publicarEn(lat);
      await e.bd.query(
        `INSERT INTO viajes (organizacion_id, conductor_id, vehiculo_id, origen_nombre, origen_lat, origen_lng,
           destino_nombre, destino_lat, destino_lng, fecha_hora_salida, cupos_totales, cupos_disponibles, precio_por_asiento)
         SELECT organizacion_id, conductor_id, vehiculo_id, origen_nombre, origen_lat, origen_lng,
           destino_nombre, destino_lat, destino_lng, fecha_hora_salida + (n || ' seconds')::interval, cupos_totales, cupos_disponibles, precio_por_asiento
         FROM viajes, generate_series(1, 60) n WHERE conductor_id = $1`,
        [conductor.id],
      );
      const inicio = performance.now();
      const r = await buscarEn(lat, fechaHoraSalida).expect(200);
      expect(performance.now() - inicio).toBeLessThan(2000);
      expect(r.body).toHaveLength(50);
    });
  });

  describe('spec §4 · entradas inválidas', () => {
    const hora = () => enMs(HORA_MS);

    it.each([
      ['latitud mayor que 90', { origenLat: '90.1', origenLng: '-63' }],
      ['latitud menor que -90', { origenLat: '-90.1', origenLng: '-63' }],
      ['longitud mayor que 180', { origenLat: '-17', origenLng: '180.1' }],
      ['longitud menor que -180', { origenLat: '-17', origenLng: '-180.1' }],
      ['texto', { origenLat: 'abc', origenLng: '-63' }],
      ['vacío, que no es 0', { origenLat: '', origenLng: '-63' }],
      ['infinito', { origenLat: 'Infinity', origenLng: '-63' }],
      ['repetida', { origenLat: ['-17', '-18'], origenLng: '-63' }],
      ['sin latitud', { origenLng: '-63' }],
      ['sin longitud', { origenLat: '-17' }],
    ])('coordenadas: %s da 400', async (_, consulta) => {
      const r = await v
        .buscar(pasajero, { ...consulta, horaSalida: hora() })
        .expect(400);
      expect(r.body.codigo).toBe('COORDENADAS_INVALIDAS');
      expect(r.body.mensaje).toBe('Las coordenadas no son válidas.');
    });

    it.each([
      ['sin hora', undefined],
      ['no es fecha', 'mañana'],
      ['sin zona', '2026-11-03T07:30:00'],
      ['forma ISO que Date no entiende', '2026-11-03T07Z'],
      ['fecha que no existe', '2026-02-30T07:30:00Z'],
      ['año 0000', '0000-01-01T00:00:00Z'],
    ])('hora: %s da 400', async (_, horaSalida) => {
      const r = await v
        .buscar(pasajero, { origenLat: '-17', origenLng: '-63', horaSalida })
        .expect(400);
      expect(r.body.codigo).toBe('VALIDACION_FALLIDA');
    });

    it.each([
      ['del año 9999', '9999-12-31T23:59:59Z'],
      ['de ayer', enMs(-24 * HORA_MS)],
      [
        'a 8 días, más allá de lo que se puede publicar',
        enMs(8 * 24 * HORA_MS),
      ],
    ])('una hora %s no falla: lista vacía', async (_, horaSalida) => {
      const r = await v
        .buscar(pasajero, { origenLat: '-17', origenLng: '-63', horaSalida })
        .expect(200);
      expect(r.body).toEqual([]);
    });

    it('coordenadas en los extremos son válidas', async () => {
      await v
        .buscar(pasajero, {
          origenLat: '90',
          origenLng: '-180',
          horaSalida: hora(),
        })
        .expect(200);
    });
  });
});
