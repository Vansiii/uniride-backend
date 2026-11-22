// PB-11 SP265: datos de demostración para el modelo de riesgo propio en una organización existente.
// Crea 13 personas de demostración con vehículo: 8 que viajan mezcladas (28 pares normales), un par sospechoso
// (11 viajes en 7 días sin moverse) y un anillo de 3 que se turna los roles y solo viaja entre sí.
// Uso (Node 24, desde backend/): npm run prisma:datos-riesgo [-- dominio]   (por defecto uagrm.edu.bo)
// Correrlo ANTES de desplegar la API: el modelo entrena al arrancar y luego cada 24 h.
// Sin dinero: las reservas van `pagada` sin movimientos de billetera (como el historial de datos-demo.ts) y con
// `anomalias_evaluadas_en`, así las reglas de HU-25 no bloquean a nadie; solo alertan el modelo y el anillo (RN-1).
// Marca: `reservas.evaluacion = {"origen":"datos_riesgo"}`, correos `riesgo.*@dominio` y el registro `datos_riesgo.carga`.
// Variables: DATABASE_URL_MIGRACIONES.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

try {
  process.loadEnvFile('../.env');
} catch {
  // sin .env: se usan las variables del entorno
}
if (!process.env.DATABASE_URL_MIGRACIONES)
  throw new Error('Falta DATABASE_URL_MIGRACIONES');

const dominio = process.argv[2] ?? 'uagrm.edu.bo';
const HORA_MS = 3_600_000;
const DIA_MS = 24 * HORA_MS;
const ahora = Date.now();
const hace = (ms: number) => new Date(ahora - ms);

let semilla = 20261121;
const azar = () => {
  semilla = (semilla + 0x6d2b79f5) | 0;
  let t = Math.imul(semilla ^ (semilla >>> 15), 1 | semilla);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const entre = (a: number, b: number) => a + Math.floor(azar() * (b - a + 1));

interface Lugar {
  nombre: string;
  lat: number;
  lng: number;
}
const BARRIOS: Lugar[] = [
  { nombre: 'Equipetrol, Av. San Martín', lat: -17.7637, lng: -63.1966 },
  { nombre: 'Plan 3000, Av. Che Guevara', lat: -17.8301, lng: -63.1146 },
  { nombre: 'Villa 1ro de Mayo', lat: -17.7908, lng: -63.1197 },
  { nombre: 'Urbarí, Av. Banzer', lat: -17.7345, lng: -63.1845 },
  { nombre: 'Pampa de la Isla', lat: -17.8049, lng: -63.1612 },
  { nombre: 'Radial 26 y 4to Anillo', lat: -17.8051, lng: -63.1494 },
];
const NOMBRES = [
  'Valeria Suárez Rivero',
  'Diego Chávez Antelo',
  'Camila Rojas Vaca',
  'Mauricio Paz Gutiérrez',
  'Lucía Montaño Ortiz',
  'Andrés Salvatierra Pinto',
  'Fernanda Áñez Roca',
  'Joaquín Terrazas Melgar',
  // par sospechoso
  'Rodrigo Céspedes Lima',
  'Gabriela Peña Justiniano',
  // anillo
  'Sergio Moreno Ibáñez',
  'Paola Arteaga Cuéllar',
  'Iván Saucedo Ribera',
];
const AUTOS = [
  ['Toyota', 'Corolla'],
  ['Suzuki', 'Swift'],
  ['Nissan', 'Sentra'],
  ['Hyundai', 'Accent'],
  ['Kia', 'Rio'],
];

async function principal() {
  const bd = new pg.Client({
    connectionString: process.env.DATABASE_URL_MIGRACIONES,
  });
  await bd.connect();
  const q = (sql: string, v: unknown[] = []) => bd.query(sql, v);
  try {
    const {
      rows: [org],
    } = await q(
      `SELECT o.id, o.nombre FROM organizaciones o JOIN dominios_organizacion d ON d.organizacion_id = o.id
       WHERE d.dominio = $1 LIMIT 1`,
      [dominio],
    );
    if (!org) throw new Error(`No hay organización con el dominio ${dominio}`);
    const { rows: previa } = await q(
      `SELECT 1 FROM registros_auditoria WHERE accion = 'datos_riesgo.carga' AND organizacion_id = $1`,
      [org.id],
    );
    if (previa.length) {
      console.log(`Ya cargado en ${org.nombre}; no se repite.`);
      return;
    }
    const destino: Lugar = (
      await q(
        `SELECT destino_nombre AS nombre, destino_lat::float AS lat, destino_lng::float AS lng
         FROM viajes WHERE organizacion_id = $1 GROUP BY 1, 2, 3 ORDER BY count(*) DESC LIMIT 1`,
        [org.id],
      )
    ).rows[0] ?? { nombre: 'Campus', lat: -17.7791, lng: -63.1946 };

    await q('BEGIN');
    const personas: { id: string; vehiculo: string; barrio: Lugar }[] = [];
    for (const [i, nombre] of NOMBRES.entries()) {
      const id = randomUUID();
      const vehiculo = randomUUID();
      // Las cuentas del anillo y del par son nuevas (entre 4 y 20 días); las normales, de meses.
      const creado = hace((i >= 8 ? entre(4, 20) : entre(60, 400)) * DIA_MS);
      const correo = `riesgo.${i + 1}.${randomBytes(2).toString('hex')}@${dominio}`;
      await q(
        `INSERT INTO usuarios (id, correo, hash_contrasena, nombre_completo, ultima_organizacion_id, consentimiento_datos_en, creado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$6)`,
        // Sin contraseña utilizable: son personas de demostración, nadie inicia sesión con ellas.
        [
          id,
          correo,
          `sin-acceso:${randomBytes(16).toString('hex')}`,
          nombre,
          org.id,
          creado,
        ],
      );
      await q(
        `INSERT INTO membresias (organizacion_id, usuario_id, rol, estado, correo_institucional, decidido_en, creado_en)
         VALUES ($1,$2,'miembro','aprobada',$3,$4,$4)`,
        [org.id, id, correo, creado],
      );
      const placa = `${entre(1000, 9999)}${String.fromCharCode(65 + entre(0, 25), 65 + entre(0, 25), 65 + entre(0, 25))}`;
      const [marca, modelo] = AUTOS[i % AUTOS.length];
      await q(
        `INSERT INTO vehiculos (id, propietario_id, placa, marca, modelo, color, capacidad, clave_s3_foto, consentimiento_foto_en, creado_en)
         VALUES ($1,$2,$3,$4,$5,'Gris',4,$6,$7,$7)`,
        [
          vehiculo,
          id,
          placa,
          marca,
          modelo,
          `demo/vehiculos/${placa}.jpg`,
          creado,
        ],
      );
      personas.push({ id, vehiculo, barrio: BARRIOS[i % BARRIOS.length] });
    }

    let viajes = 0;
    /** Viaje pagado del conductor con una reserva del pasajero y sus pruebas de presencia aceptadas. */
    const viaje = async (
      c: (typeof personas)[number],
      p: (typeof personas)[number],
      salida: Date,
      real: boolean,
      calificar: boolean,
    ) => {
      const viajeId = randomUUID();
      const reservaId = randomUUID();
      const precio = entre(8, 14).toFixed(2);
      await q(
        `INSERT INTO viajes (id, organizacion_id, conductor_id, vehiculo_id, origen_nombre, origen_lat, origen_lng, destino_nombre,
           destino_lat, destino_lng, fecha_hora_salida, cupos_totales, cupos_disponibles, precio_por_asiento, estado, creado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,3,2,$12,'pagado',$13)`,
        [
          viajeId,
          org.id,
          c.id,
          c.vehiculo,
          c.barrio.nombre,
          c.barrio.lat,
          c.barrio.lng,
          destino.nombre,
          destino.lat,
          destino.lng,
          salida,
          precio,
          new Date(salida.getTime() - DIA_MS),
        ],
      );
      await q(
        `INSERT INTO reservas (id, organizacion_id, viaje_id, pasajero_id, monto, estado, clave_idempotencia, evaluacion,
           anomalias_evaluadas_en, creado_en, actualizado_en)
         VALUES ($1,$2,$3,$4,$5,'pagada',$6,$7,now(),$8,$9)`,
        [
          reservaId,
          org.id,
          viajeId,
          p.id,
          precio,
          `riesgo:${reservaId}`,
          JSON.stringify({ origen: 'datos_riesgo' }),
          new Date(salida.getTime() - 6 * HORA_MS),
          new Date(salida.getTime() + HORA_MS),
        ],
      );
      // Real: del barrio al campus en 20–40 min. Simulado: se baja donde subió, al minuto.
      const minutos = real ? entre(20, 40) : 1;
      const bajada = real ? destino : c.barrio;
      for (const [tipo, lugar, en] of [
        ['abordaje', c.barrio, salida],
        ['bajada', bajada, new Date(salida.getTime() + minutos * 60_000)],
      ] as const)
        await q(
          `INSERT INTO pruebas_presencia (organizacion_id, reserva_id, tipo, pasajero_lat, pasajero_lng, resultado, hash_prueba, creado_en)
           VALUES ($1,$2,$3,$4,$5,'aceptada','datos-riesgo',$6)`,
          [
            org.id,
            reservaId,
            tipo,
            lugar.lat + (azar() - 0.5) * 0.0004,
            lugar.lng + (azar() - 0.5) * 0.0004,
            en,
          ],
        );
      if (calificar)
        for (const [autor, destinatario] of [
          [p.id, c.id],
          [c.id, p.id],
        ])
          await q(
            `INSERT INTO calificaciones (organizacion_id, reserva_id, autor_id, destinatario_id, estrellas, creado_en)
             VALUES ($1,$2,$3,$4,5,$5)`,
            [
              org.id,
              reservaId,
              autor,
              destinatario,
              new Date(salida.getTime() + 2 * HORA_MS),
            ],
          );
      viajes++;
    };

    // 28 pares normales: cada una viaja una vez con cada una de las otras 7 en los últimos 25 días.
    const mezcla = personas.slice(0, 8);
    let k = 0;
    for (let i = 0; i < mezcla.length; i++)
      for (let j = i + 1; j < mezcla.length; j++)
        await viaje(
          mezcla[i],
          mezcla[j],
          hace((++k * 21 + entre(0, 5)) * HORA_MS),
          true,
          azar() < 0.4,
        );

    // Par sospechoso: 11 viajes en 7 días, sin desplazamiento, siempre se califican entre sí.
    const [s1, s2] = personas.slice(8, 10);
    for (let j = 0; j < 11; j++)
      await viaje(
        j % 3 ? s1 : s2,
        j % 3 ? s2 : s1,
        hace((j * 14 + 3) * HORA_MS),
        false,
        true,
      );

    // Anillo: 3 cuentas nuevas que se turnan de conductor; 4 viajes con cada una y con nadie más.
    const anillo = personas.slice(10);
    let m = 0;
    for (const [x, y] of [
      [0, 1],
      [1, 2],
      [2, 0],
    ])
      for (let j = 0; j < 4; j++)
        await viaje(
          anillo[j % 2 ? y : x],
          anillo[j % 2 ? x : y],
          hace((++m * 17 + 5) * HORA_MS),
          true,
          true,
        );

    await q(
      `INSERT INTO registros_auditoria (accion, entidad, entidad_id, resultado, organizacion_id, detalle)
       VALUES ('datos_riesgo.carga','organizacion',$1::text,'ok',$1::uuid,$2)`,
      [org.id, JSON.stringify({ personas: personas.length, viajes })],
    );
    await q('COMMIT');
    console.log(
      `${org.nombre}: ${personas.length} personas y ${viajes} viajes de demostración del modelo de riesgo.`,
    );
  } catch (error) {
    await q('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await bd.end();
  }
}

await principal();
