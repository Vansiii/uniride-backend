import { prepararEntorno, type Entorno } from '../ayudas-organizaciones.js';
import {
  ayudasViajes,
  cuerpoViaje,
  enMs,
  HORA_MS,
  type Conductor,
} from './ayudas-viajes.js';

const MINUTO_MS = 60_000;

describe('HU-17 · publicar viaje (e2e)', () => {
  let e: Entorno;
  const v = ayudasViajes(() => e);
  let org: Awaited<ReturnType<typeof v.organizacion>>;
  let otraOrg: Awaited<ReturnType<typeof v.organizacion>>;

  beforeAll(async () => {
    e = await prepararEntorno();
    org = await v.organizacion('Viajes A');
    otraOrg = await v.organizacion('Viajes B');
  });
  afterAll(async () => {
    await e.cerrar();
  });

  const nadaPublicado = async (c: Conductor) =>
    expect(await v.filas(c.id)).toEqual([]);

  describe('CA-1 · publicación válida', () => {
    it('crea el viaje en `publicado`, en la organización activa, con todos los cupos libres y auditoría', async () => {
      const c = await v.conductor(org.id);
      const cuerpo = cuerpoViaje();
      const r = await v.publicar(c, cuerpo).expect(201);
      expect(r.body).toEqual({
        id: expect.any(String),
        estado: 'publicado',
        cuposDisponibles: 3,
      });

      const [fila] = await v.filas(c.id);
      expect(fila).toMatchObject({
        id: r.body.id,
        organizacion_id: org.id,
        estado: 'publicado',
        cupos_totales: 3,
        cupos_disponibles: 3,
        precio_por_asiento: '10.50',
        origen_nombre: cuerpo.origenNombre,
        origen_lat: '-17.783327',
        destino_lng: '-63.195000',
      });
      expect(fila.fecha_hora_salida.toISOString()).toBe(cuerpo.fechaHoraSalida);

      const { rows } = await e.bd.query(
        `SELECT resultado, organizacion_id FROM registros_auditoria WHERE accion = 'viaje.publicacion' AND entidad_id = $1 AND actor_id = $2`,
        [r.body.id, c.id],
      );
      expect(rows).toEqual([{ resultado: 'ok', organizacion_id: org.id }]);
    });

    it('`mis-viajes` y el detalle lo muestran con los datos del plan y sin la foto del vehículo', async () => {
      const c = await v.conductor(org.id);
      const cuerpo = cuerpoViaje();
      const { body } = await v.publicar(c, cuerpo).expect(201);

      const mios = await v.misViajes(c.token).expect(200);
      expect(mios.body).toEqual([
        {
          id: body.id,
          origenNombre: cuerpo.origenNombre,
          destinoNombre: cuerpo.destinoNombre,
          fechaHoraSalida: cuerpo.fechaHoraSalida,
          cuposDisponibles: 3,
          precioPorAsiento: 10.5,
          estado: 'publicado',
        },
      ]);

      const d = await v.detalle(c.token, body.id).expect(200);
      expect(d.body).toEqual({
        id: body.id,
        origen: {
          nombre: cuerpo.origenNombre,
          lat: cuerpo.origenLat,
          lng: cuerpo.origenLng,
        },
        destino: {
          nombre: cuerpo.destinoNombre,
          lat: cuerpo.destinoLat,
          lng: cuerpo.destinoLng,
        },
        fechaHoraSalida: cuerpo.fechaHoraSalida,
        conductor: { nombre: 'Prueba' },
        vehiculo: expect.objectContaining({ marca: 'Toyota', color: 'Blanco' }),
        cuposTotales: 3,
        cuposDisponibles: 3,
        precioPorAsiento: 10.5,
        estado: 'publicado',
      });
      expect(Object.keys(d.body.vehiculo).sort()).toEqual([
        'color',
        'marca',
        'modelo',
        'placa',
      ]);
      expect(JSON.stringify(d.body)).not.toContain('clave-secreta-s3');
    });

    it('un viaje que no existe o un id malformado no llega a la BD', async () => {
      const c = await v.conductor(org.id);
      const r = await v
        .detalle(c.token, '11111111-1111-4111-8111-111111111111')
        .expect(404);
      expect(r.body.codigo).toBe('VIAJE_NO_ENCONTRADO');
      await v.detalle(c.token, 'no-es-uuid').expect(400);
    });
  });

  describe('CA-2 · cupos', () => {
    it('más cupos que la capacidad: 400 con el tope; justo la capacidad pasa', async () => {
      const c = await v.conductor(org.id, { capacidad: 2 });
      const r = await v
        .publicar(c, cuerpoViaje({ cuposTotales: 3 }))
        .expect(400);
      expect(r.body).toMatchObject({
        codigo: 'CUPOS_EXCEDEN_CAPACIDAD',
        maximo: 2,
      });
      await nadaPublicado(c);
      await v.publicar(c, cuerpoViaje({ cuposTotales: 2 })).expect(201);
    });

    it.each([0, -1, 1.5, '3'])(
      'cupos %s: VALIDACION_FALLIDA',
      async (cupos) => {
        const c = await v.conductor(org.id);
        await v.publicar(c, cuerpoViaje({ cuposTotales: cupos })).expect(400);
        await nadaPublicado(c);
      },
    );
  });

  describe('CA-3 · precio', () => {
    it.each([0.99, 20.01, 0, -5])(
      'precio %s: 400 con los límites de la organización',
      async (precioPorAsiento) => {
        const c = await v.conductor(org.id);
        const r = await v
          .publicar(c, cuerpoViaje({ precioPorAsiento }))
          .expect(400);
        expect(r.body).toMatchObject({
          codigo: 'PRECIO_FUERA_DE_RANGO',
          minimo: 1,
          maximo: 20,
        });
        await nadaPublicado(c);
      },
    );

    it.each([1, 20])('los límites %s valen', async (precioPorAsiento) => {
      const c = await v.conductor(org.id);
      await v.publicar(c, cuerpoViaje({ precioPorAsiento })).expect(201);
    });

    it('más de 2 decimales: no se redondea en silencio', async () => {
      const c = await v.conductor(org.id);
      await v.publicar(c, cuerpoViaje({ precioPorAsiento: 1.005 })).expect(400);
      await nadaPublicado(c);
    });

    it('el tope es el de cada organización, no un valor fijo', async () => {
      const cara = await v.organizacion('Viajes Cara');
      await e.bd.query(
        `UPDATE organizaciones SET precio_maximo_urc = 50 WHERE id = $1`,
        [cara.id],
      );
      const c = await v.conductor(cara.id);
      await v.publicar(c, cuerpoViaje({ precioPorAsiento: 30 })).expect(201);

      const limites = await e
        .api()
        .get('/api/v1/viajes/limites')
        .set(v.conToken(c.token))
        .expect(200);
      expect(limites.body).toEqual({ precioMinimo: 1, precioMaximo: 50 });
    });

    it('los límites piden membresía aprobada', async () => {
      const c = await v.conductor(org.id, { membresia: 'pendiente' });
      const r = await e
        .api()
        .get('/api/v1/viajes/limites')
        .set(v.conToken(c.token))
        .expect(403);
      expect(r.body.codigo).toBe('NO_AUTORIZADO');
    });
  });

  describe('CA-4 y RN-5 · horario', () => {
    it.each([
      ['pasado', -HORA_MS],
      ['con 14 minutos', 14 * MINUTO_MS],
      ['a más de 7 días', 7 * 24 * HORA_MS + MINUTO_MS],
    ])('%s: 400 HORARIO_INVALIDO', async (_, ms) => {
      const c = await v.conductor(org.id);
      const r = await v
        .publicar(c, cuerpoViaje({ fechaHoraSalida: enMs(ms) }))
        .expect(400);
      expect(r.body).toMatchObject({
        codigo: 'HORARIO_INVALIDO',
        minimoMinutos: 15,
        maximoDias: 7,
      });
      await nadaPublicado(c);
    });

    it.each([16 * MINUTO_MS, 7 * 24 * HORA_MS - MINUTO_MS])(
      'dentro de la ventana (%d ms) pasa',
      async (ms) => {
        const c = await v.conductor(org.id);
        await v
          .publicar(c, cuerpoViaje({ fechaHoraSalida: enMs(ms) }))
          .expect(201);
      },
    );

    it.each(['2026-11-20T10:00:00', 'mañana', '2026-13-45T10:00:00Z'])(
      'fecha %s (sin zona o inválida): 400',
      async (fechaHoraSalida) => {
        const c = await v.conductor(org.id);
        const r = await v
          .publicar(c, cuerpoViaje({ fechaHoraSalida }))
          .expect(400);
        expect(r.body.codigo).toBe('VALIDACION_FALLIDA');
      },
    );
  });

  describe('CA-5 · solapamiento', () => {
    const BASE = 24 * HORA_MS;
    const salidaA = (ms: number) => ({
      fechaHoraSalida: new Date(BASE + ms + ancla).toISOString(),
    });
    // Un instante fijo por prueba: "exactamente 2 horas" no depende del reloj entre peticiones.
    let ancla = 0;
    beforeEach(() => {
      ancla = Date.now();
    });

    it.each([0, MINUTO_MS, 2 * HORA_MS - 1, -(2 * HORA_MS - 1)])(
      'a %d ms de otro viaje activo: 409 y no se crea',
      async (ms) => {
        const c = await v.conductor(org.id);
        await v.publicar(c, cuerpoViaje(salidaA(0))).expect(201);
        const r = await v.publicar(c, cuerpoViaje(salidaA(ms))).expect(409);
        expect(r.body).toMatchObject({
          codigo: 'VIAJE_SOLAPADO',
          margenHoras: 2,
          salidaExistente: salidaA(0).fechaHoraSalida,
        });
        expect(await v.filas(c.id)).toHaveLength(1);
      },
    );

    it.each([2 * HORA_MS, -2 * HORA_MS])(
      'a exactamente %d ms pasa: es el margen mínimo',
      async (ms) => {
        const c = await v.conductor(org.id);
        await v.publicar(c, cuerpoViaje(salidaA(0))).expect(201);
        await v.publicar(c, cuerpoViaje(salidaA(ms))).expect(201);
      },
    );

    it.each(['reservado', 'en_curso'])(
      'un viaje %s también ocupa',
      async (estado) => {
        const c = await v.conductor(org.id);
        await v.publicar(c, cuerpoViaje(salidaA(0))).expect(201);
        await e.bd.query(
          `UPDATE viajes SET estado = $1 WHERE conductor_id = $2`,
          [estado, c.id],
        );
        await v.publicar(c, cuerpoViaje(salidaA(0))).expect(409);
      },
    );

    it.each(['cancelado', 'expirado', 'verificado', 'pagado'])(
      'un viaje %s ya no ocupa',
      async (estado) => {
        const c = await v.conductor(org.id);
        await v.publicar(c, cuerpoViaje(salidaA(0))).expect(201);
        await e.bd.query(
          `UPDATE viajes SET estado = $1 WHERE conductor_id = $2`,
          [estado, c.id],
        );
        await v.publicar(c, cuerpoViaje(salidaA(0))).expect(201);
      },
    );

    it('un viaje sin reservas cuya salida ya pasó no ocupa; uno reservado sí', async () => {
      const c = await v.conductor(org.id);
      await v.publicar(c).expect(201);
      await e.bd.query(
        `UPDATE viajes SET fecha_hora_salida = now() - interval '30 minutes' WHERE conductor_id = $1`,
        [c.id],
      );
      const pronto = cuerpoViaje({
        fechaHoraSalida: new Date(Date.now() + 20 * MINUTO_MS).toISOString(),
      });
      await e.bd.query(
        `UPDATE viajes SET estado = 'reservado' WHERE conductor_id = $1`,
        [c.id],
      );
      await v.publicar(c, pronto).expect(409);
      await e.bd.query(
        `UPDATE viajes SET estado = 'publicado' WHERE conductor_id = $1`,
        [c.id],
      );
      await v.publicar(c, pronto).expect(201);
    });

    it('otro conductor en el mismo horario no se ve afectado', async () => {
      const c1 = await v.conductor(org.id);
      const c2 = await v.conductor(org.id);
      await v.publicar(c1, cuerpoViaje(salidaA(0))).expect(201);
      await v.publicar(c2, cuerpoViaje(salidaA(0))).expect(201);
    });

    it('un viaje en otra de sus organizaciones también ocupa: RLS no lo esconde', async () => {
      const c = await v.conductor(org.id);
      await v.publicar(c, cuerpoViaje(salidaA(0))).expect(201);
      const enOtra = await v.cambiarOrganizacion(c, otraOrg.id);
      await v.publicar(enOtra, cuerpoViaje(salidaA(HORA_MS))).expect(409);
      expect(await v.filas(c.id)).toHaveLength(1);
    });

    it('publicaciones simultáneas: solo una entra', async () => {
      const c = await v.conductor(org.id);
      const respuestas = await Promise.all(
        Array.from({ length: 5 }, () => v.publicar(c, cuerpoViaje(salidaA(0)))),
      );
      expect(respuestas.map((r) => r.status).sort()).toEqual([
        201, 409, 409, 409, 409,
      ]);
      expect(await v.filas(c.id)).toHaveLength(1);
    });
  });

  describe('CA-6 · requisitos', () => {
    it.each([
      null,
      'no_verificada',
      'en_revision',
      'rechazada',
      'bloqueada_temporal',
    ])('identidad %s: 403 IDENTIDAD_NO_VERIFICADA', async (identidad) => {
      const c = await v.conductor(org.id, { identidad });
      const r = await v.publicar(c).expect(403);
      expect(r.body.codigo).toBe('IDENTIDAD_NO_VERIFICADA');
      await nadaPublicado(c);
    });

    it('sin vehículo: 403 CONDUCTOR_SIN_VEHICULO, que indica el requisito', async () => {
      const c = await v.conductor(org.id, { vehiculo: false });
      const r = await v.publicar(c).expect(403);
      expect(r.body.codigo).toBe('CONDUCTOR_SIN_VEHICULO');
      expect(r.body.mensaje).toMatch(/vehículo/);
      await nadaPublicado(c);
    });

    it('cuenta suspendida: 403 CUENTA_SUSPENDIDA al publicar y al pedir los límites', async () => {
      const c = await v.conductor(org.id);
      await e.bd.query(
        `UPDATE usuarios SET suspendida_en = now() WHERE id = $1`,
        [c.id],
      );
      const r = await v.publicar(c).expect(403);
      expect(r.body.codigo).toBe('CUENTA_SUSPENDIDA');
      await nadaPublicado(c);
      const limites = await e
        .api()
        .get('/api/v1/viajes/limites')
        .set(v.conToken(c.token))
        .expect(403);
      expect(limites.body.codigo).toBe('CUENTA_SUSPENDIDA');
    });

    it('membresía sin aprobar: 403 NO_AUTORIZADO', async () => {
      const c = await v.conductor(org.id, { membresia: 'pendiente' });
      const r = await v.publicar(c).expect(403);
      expect(r.body.codigo).toBe('NO_AUTORIZADO');
      await nadaPublicado(c);
    });
  });

  describe('RN-4 · datos del recorrido', () => {
    it.each([
      { origenLat: 90.1 },
      { origenLng: -180.5 },
      { destinoLat: 'x' },
      { destinoNombre: '   ' },
      { origenNombre: 'a'.repeat(201) },
    ])('%j: 400', async (malo) => {
      const c = await v.conductor(org.id);
      await v.publicar(c, cuerpoViaje(malo)).expect(400);
      await nadaPublicado(c);
    });

    it('origen y destino con las mismas coordenadas: 400 LUGARES_IGUALES', async () => {
      const c = await v.conductor(org.id);
      const { origenLat, origenLng } = cuerpoViaje();
      const r = await v
        .publicar(
          c,
          cuerpoViaje({ destinoLat: origenLat, destinoLng: origenLng }),
        )
        .expect(400);
      expect(r.body.codigo).toBe('LUGARES_IGUALES');
      await nadaPublicado(c);
    });

    it('un nombre con el carácter NUL no llega a PostgreSQL: se guarda sin él', async () => {
      const c = await v.conductor(org.id);
      await v
        .publicar(c, cuerpoViaje({ origenNombre: 'Plaza\u0000 Central' }))
        .expect(201);
      const [fila] = await v.filas(c.id);
      expect(fila.origen_nombre).toBe('Plaza Central');
    });
  });
});
