import { writeFileSync } from 'node:fs';
import {
  DOMINIO,
  organizacionConAdmin,
  prepararEntorno,
  type Entorno,
} from '../ayudas-organizaciones.js';
import { ayudasPresencia } from '../presencia/ayudas-presencia.js';
import { ayudasReservas } from '../reservas/ayudas-reservas.js';

/**
 * PB-06: mide el servidor con el mismo arnés de los e2e (la API real, PostgreSQL local y la cadena simulada). No es parte
 * de `npm run test:e2e`: se corre con `npm run test:carga` (o con `node scripts/carga.mjs` desde la raíz, que además
 * escribe el informe). Solo guarda las muestras en bruto; los percentiles y el veredicto los calcula el guion de la raíz.
 */
const USUARIOS_BUSQUEDA = 20;
const DURACION_BUSQUEDA_MS = Number(process.env.CARGA_DURACION_MS ?? 30_000);
const VIAJES_POR_ORGANIZACION = 110;
const USUARIOS_ABORDAJE = 10;
const RONDAS_ABORDAJE = Number(process.env.CARGA_RONDAS ?? 3);
const SALIDA = process.env.CARGA_SALIDA ?? 'carga-resultado.json';
const LUGARES = [
  'UAGRM, Módulos',
  'Plaza 24 de Septiembre',
  'Mercado Los Pozos',
  'Terminal Bimodal',
  'Parque Urbano',
];

describe('PB-06 · carga local', () => {
  let e: Entorno;
  const r = ayudasReservas(() => e);
  // Las ayudas de viajes que ya usa `r`: dos contadores de correos crearían el mismo `conductor1@…`.
  const v = r.v;
  const p = ayudasPresencia(() => e, r);
  const resultado: Record<string, unknown> = {};

  beforeAll(async () => {
    // RN-4: sin Play Integrity real; rige la simulación de desarrollo (nunca llega a producción).
    process.env.MODO_EMULADOR_DEV = 'true';
    e = await prepararEntorno();
    await e.crearUsuario(`super${DOMINIO}`, 'super_admin');
    await r.preparar();
  }, 120_000);
  afterAll(async () => {
    writeFileSync(SALIDA, JSON.stringify(resultado, null, 2));
    await e.cerrar();
  });

  it('búsqueda: 20 usuarios simultáneos durante 30 s sobre ≥ 200 viajes en 2 organizaciones', async () => {
    const superToken = await e.iniciar(`super${DOMINIO}`);
    const organizaciones = [
      await organizacionConAdmin(e, superToken, 'Carga A'),
      await organizacionConAdmin(e, superToken, 'Carga B'),
    ];
    // Un viaje real por organización (publicado por la API) y el resto clonado en la base, con otras horas y destinos.
    const salidas: number[] = [];
    for (const org of organizaciones) {
      const conductor = await v.conductor(org.id);
      const { body } = await v.publicar(conductor).expect(201);
      await e.bd.query(
        `INSERT INTO viajes (organizacion_id, conductor_id, vehiculo_id, origen_nombre, origen_lat, origen_lng, destino_nombre, destino_lat, destino_lng,
                             fecha_hora_salida, cupos_totales, cupos_disponibles, precio_por_asiento, estado)
         SELECT organizacion_id, conductor_id, vehiculo_id, origen_nombre, origen_lat, origen_lng,
                (ARRAY[${LUGARES.map((l) => `'${l}'`).join(',')}])[1 + g % ${LUGARES.length}], destino_lat, destino_lng,
                now() + make_interval(mins => 60 + 85 * g), cupos_totales, cupos_totales, precio_por_asiento, 'publicado'
         FROM viajes, generate_series(1, ${VIAJES_POR_ORGANIZACION}) g WHERE id = $1`,
        [body.id],
      );
      // Las búsquedas solo miran hasta 7 días adelante: los viajes sembrados caben todos (110 × 85 min ≈ 6,5 días).
      for (let g = 1; g <= VIAJES_POR_ORGANIZACION; g++)
        salidas.push((60 + 85 * g) / 60);
    }
    const { rows } = await e.bd.query(
      `SELECT count(*)::int AS n FROM viajes WHERE organizacion_id = ANY($1)`,
      [organizaciones.map((o) => o.id)],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(200);

    const usuarios = [];
    for (let i = 0; i < USUARIOS_BUSQUEDA; i++)
      usuarios.push(
        await v.conductor(organizaciones[i % 2].id, { vehiculo: false }),
      );

    const tiempos: number[] = [];
    let errores5xx = 0;
    let otrosErrores = 0;
    let sinResultados = 0;
    const fin = Date.now() + DURACION_BUSQUEDA_MS;
    await Promise.all(
      usuarios.map(async (u, i) => {
        let n = i;
        while (Date.now() < fin) {
          // Cada petición busca en otra hora (ventana de ±30 min), a veces con un destino.
          const horas = salidas[(n * 7) % salidas.length];
          const consulta = {
            origenLat: -17.783327,
            origenLng: -63.182129,
            horaSalida: new Date(Date.now() + horas * 3_600_000).toISOString(),
            ...(n % 3 === 0 && { destino: 'uagrm' }),
          };
          const t0 = performance.now();
          const res = await v.buscar(u.token, consulta);
          tiempos.push(performance.now() - t0);
          if (res.status >= 500) errores5xx++;
          else if (res.status !== 200) otrosErrores++;
          else if (!res.body.length) sinResultados++;
          n++;
        }
      }),
    );
    resultado.busqueda = {
      usuarios: USUARIOS_BUSQUEDA,
      duracionMs: DURACION_BUSQUEDA_MS,
      viajesSembrados: rows[0].n,
      organizaciones: organizaciones.length,
      tiempos,
      errores5xx,
      otrosErrores,
      sinResultados,
    };
    expect(tiempos.length).toBeGreaterThan(0);
  }, 300_000);

  it('abordaje: 10 usuarios simultáneos validan el desafío firmado, en rondas', async () => {
    const superToken = await e.iniciar(`super${DOMINIO}`);
    const org = await organizacionConAdmin(e, superToken, 'Carga Abordaje');
    const tiempos: number[] = [];
    let errores5xx = 0;
    let otrosErrores = 0;
    for (let ronda = 0; ronda < RONDAS_ABORDAJE; ronda++) {
      // 10 pasajeros repartidos en viajes de 3 (la capacidad del viaje de prueba); cada uno con su reserva confirmada.
      const peticiones: (() => Promise<{ status: number }>)[] = [];
      const escenarios = [];
      for (const cuantos of [3, 3, 3, 1])
        escenarios.push(await p.escenario(org.id, cuantos));
      for (const s of escenarios) {
        const llave = await p.llaveConductor(s);
        for (const pasajero of s.pasajeros) {
          const nonce = await p.codigo(s, llave);
          peticiones.push(() => p.abordar(pasajero, pasajero.reservaId, nonce));
        }
      }
      expect(peticiones).toHaveLength(USUARIOS_ABORDAJE);
      // Los 10 abordajes salen a la vez, con sus códigos recién emitidos (viven 30 s).
      await Promise.all(
        peticiones.map(async (enviar) => {
          const t0 = performance.now();
          const res = await enviar();
          tiempos.push(performance.now() - t0);
          if (res.status >= 500) errores5xx++;
          else if (res.status !== 200) otrosErrores++;
        }),
      );
    }
    resultado.abordaje = {
      usuarios: USUARIOS_ABORDAJE,
      rondas: RONDAS_ABORDAJE,
      tiempos,
      errores5xx,
      otrosErrores,
    };
    expect(tiempos).toHaveLength(USUARIOS_ABORDAJE * RONDAS_ABORDAJE);
  }, 600_000);
});
