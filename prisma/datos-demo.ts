// Datos de demostración realistas (5 organizaciones, ~60 personas, viajes, reservas, calificaciones y billeteras).
// Uso (Node 24, desde backend/): npm run prisma:datos-demo
// El dinero entra por el camino real: recargas, bloqueos y pagos se encolan en `trabajos_onchain` y los procesa el worker
// de la API (cadena real o simulada), así el libro y la cadena coinciden (AGENTS.md §5.7). Solo unos pocos viajes llevan
// dinero (el relayer y el verificador pagan gas de Amoy); el resto del historial va sin movimientos.
// Marca de los datos: `reservas.evaluacion = {"origen":"datos_demo"}` y el registro de auditoría `datos_demo.carga`.
// Variables: DATABASE_URL_MIGRACIONES, WALLET_ENCRYPTION_KEY, IDENTIDAD_SECRETO; opcional DEMO_CONTRASENA y CADENA_RPC_URL.
import bcrypt from 'bcryptjs';
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Contract, JsonRpcProvider, Wallet, hexlify } from 'ethers';
import pg from 'pg';

try {
  process.loadEnvFile('../.env');
} catch {
  // sin .env: se usan las variables del entorno
}

const env = process.env;
for (const nombre of [
  'DATABASE_URL_MIGRACIONES',
  'WALLET_ENCRYPTION_KEY',
  'IDENTIDAD_SECRETO',
])
  if (!env[nombre]) throw new Error(`Falta ${nombre}`);
if (!/^[0-9a-fA-F]{64}$/.test(env.WALLET_ENCRYPTION_KEY!))
  throw new Error('WALLET_ENCRYPTION_KEY debe tener 64 caracteres hexadecimales');

// --- Utilidades -----------------------------------------------------------------------------------------------------

let semilla = 20261118;
const azar = () => {
  // mulberry32: mismos datos en cada corrida
  semilla = (semilla + 0x6d2b79f5) | 0;
  let t = Math.imul(semilla ^ (semilla >>> 15), 1 | semilla);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const entre = (a: number, b: number) => a + Math.floor(azar() * (b - a + 1));
const elegir = <T>(lista: readonly T[]): T => lista[entre(0, lista.length - 1)];
const barajar = <T>(lista: readonly T[]): T[] => {
  const copia = [...lista];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = entre(0, i);
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
};
const sinTildes = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ñ/gi, 'n');
const HORA_MS = 3_600_000;
const DIA_MS = 24 * HORA_MS;
const ahora = Date.now();
const hace = (ms: number) => new Date(ahora - ms);

/** Misma construcción que `backend/src/billetera/custodia.ts` (AES-256-GCM con la dirección como dato autenticado). */
function cifrarLlave(llavePrivada: string, direccion: string): string {
  const iv = randomBytes(12);
  const cifrador = createCipheriv(
    'aes-256-gcm',
    Buffer.from(env.WALLET_ENCRYPTION_KEY!, 'hex'),
    iv,
  );
  cifrador.setAAD(Buffer.from(direccion));
  const texto = Buffer.concat([cifrador.update(llavePrivada, 'utf8'), cifrador.final()]);
  return [iv, cifrador.getAuthTag(), texto].map((p) => p.toString('base64')).join('.');
}

/** Misma construcción que `identidad/documento.ts`; los números son de demostración y no coinciden con carnets reales. */
const hashDocumento = (numero: string) =>
  createHmac('sha256', env.IDENTIDAD_SECRETO!)
    .update(numero.toUpperCase().replace(/[^0-9A-Z]/g, ''))
    .digest('hex');

const haversineKm = (a: Lugar, b: Lugar) => {
  const rad = (g: number) => (g * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

// --- Catálogos ------------------------------------------------------------------------------------------------------

interface Lugar {
  nombre: string;
  lat: number;
  lng: number;
}

// Coordenadas aproximadas de Santa Cruz de la Sierra.
const BARRIOS: Lugar[] = [
  { nombre: 'Equipetrol, Av. San Martín', lat: -17.7637, lng: -63.1966 },
  { nombre: 'Plan 3000, Av. Che Guevara', lat: -17.8301, lng: -63.1146 },
  { nombre: 'Villa 1ro de Mayo', lat: -17.7908, lng: -63.1197 },
  { nombre: 'Los Pozos, Av. Santos Dumont', lat: -17.7899, lng: -63.1676 },
  { nombre: 'Urbarí, Av. Banzer', lat: -17.7345, lng: -63.1845 },
  { nombre: 'La Ramada, 3er Anillo', lat: -17.7456, lng: -63.1721 },
  { nombre: 'Pampa de la Isla', lat: -17.8049, lng: -63.1612 },
  { nombre: 'Av. Virgen de Cotoca y 4to Anillo', lat: -17.7595, lng: -63.1535 },
  { nombre: 'Av. Cristo Redentor y 5to Anillo', lat: -17.7254, lng: -63.174 },
  { nombre: 'Barrio Mutualista', lat: -17.7952, lng: -63.1775 },
  { nombre: 'Av. Beni y 2do Anillo', lat: -17.7708, lng: -63.1786 },
  { nombre: 'Plaza 24 de Septiembre', lat: -17.7834, lng: -63.1821 },
  { nombre: 'Av. Roca y Coronado', lat: -17.7871, lng: -63.1702 },
  { nombre: 'Av. Alemana y 3er Anillo', lat: -17.7522, lng: -63.1769 },
  { nombre: 'Radial 26 y 4to Anillo', lat: -17.8051, lng: -63.1494 },
  { nombre: 'Av. Busch y 3er Anillo', lat: -17.7693, lng: -63.2011 },
];

const CATALOGO = [
  {
    nombre: 'Universidad Autónoma Gabriel René Moreno',
    tipo: 'universidad',
    dominio: 'uagrm.edu.bo',
    precioMax: 15,
    personas: 24,
    conductores: 9,
    destino: { nombre: 'Ciudad Universitaria UAGRM, Av. Busch', lat: -17.7791, lng: -63.1946 },
  },
  {
    nombre: 'Universidad Privada de Santa Cruz de la Sierra (UPSA)',
    tipo: 'universidad',
    dominio: 'upsa.edu.bo',
    precioMax: 20,
    personas: 12,
    conductores: 5,
    destino: { nombre: 'Campus UPSA, Av. Paraguá y 4to Anillo', lat: -17.7469, lng: -63.1546 },
  },
  {
    nombre: 'Universidad Católica Boliviana "San Pablo" - Santa Cruz',
    tipo: 'universidad',
    dominio: 'ucb.edu.bo',
    precioMax: 18,
    personas: 10,
    conductores: 4,
    destino: { nombre: 'Campus UCB, 2do Anillo', lat: -17.7788, lng: -63.1763 },
  },
  {
    nombre: 'Agroindustrial Oriente S.A.',
    tipo: 'empresa',
    dominio: 'agroriente.com.bo',
    precioMax: 25,
    personas: 8,
    conductores: 3,
    destino: { nombre: 'Planta Agroindustrial Oriente, Parque Industrial', lat: -17.8087, lng: -63.1371 },
  },
  {
    nombre: 'Logística Chiquitana S.R.L.',
    tipo: 'empresa',
    dominio: 'logisticachiquitana.com.bo',
    precioMax: 25,
    personas: 6,
    conductores: 3,
    destino: { nombre: 'Centro de Distribución, Zona Franca', lat: -17.7508, lng: -63.1119 },
  },
] as const;

const NOMBRES = [
  'María', 'José', 'Luis', 'Ana', 'Carlos', 'Daniela', 'Jorge', 'Camila', 'Marco', 'Valeria',
  'Diego', 'Fernanda', 'Andrés', 'Paola', 'Gonzalo', 'Lucía', 'Rodrigo', 'Gabriela', 'Pablo', 'Carolina',
  'Sergio', 'Alejandra', 'Hugo', 'Natalia', 'Iván', 'Mariana', 'Álvaro', 'Rocío', 'Mauricio', 'Karen',
  'Eduardo', 'Patricia', 'Ricardo', 'Silvia', 'Óscar', 'Verónica', 'Cristian', 'Milenka', 'Boris', 'Jimena',
];
const APELLIDOS = [
  'Rojas', 'Vargas', 'Mamani', 'Quispe', 'Flores', 'Gutiérrez', 'Suárez', 'Justiniano', 'Roca', 'Parada',
  'Salvatierra', 'Barba', 'Chávez', 'Peña', 'Soliz', 'Cuéllar', 'Egüez', 'Añez', 'Moreno', 'Vaca',
  'Terrazas', 'Landívar', 'Montaño', 'Arteaga', 'Céspedes', 'Durán', 'Ribera', 'Zeballos', 'Camacho', 'Ortiz',
  'Paz', 'Medina', 'Antelo', 'Saucedo', 'Velasco', 'Hurtado', 'Claure', 'Aguilera', 'Menacho', 'Cortez',
];
const VEHICULOS: { marca: string; modelo: string; capacidad: number }[] = [
  { marca: 'Toyota', modelo: 'Corolla', capacidad: 4 },
  { marca: 'Suzuki', modelo: 'Swift', capacidad: 4 },
  { marca: 'Nissan', modelo: 'Sentra', capacidad: 4 },
  { marca: 'Hyundai', modelo: 'i10', capacidad: 4 },
  { marca: 'Kia', modelo: 'Rio', capacidad: 4 },
  { marca: 'Toyota', modelo: 'Yaris', capacidad: 4 },
  { marca: 'Chevrolet', modelo: 'Spark', capacidad: 3 },
  { marca: 'Toyota', modelo: 'Hilux', capacidad: 4 },
  { marca: 'Suzuki', modelo: 'Vitara', capacidad: 4 },
  { marca: 'Honda', modelo: 'Fit', capacidad: 4 },
  { marca: 'Toyota', modelo: 'RAV4', capacidad: 4 },
  { marca: 'Mazda', modelo: 'Demio', capacidad: 4 },
];
const COLORES = ['Blanco', 'Plata', 'Negro', 'Gris', 'Rojo', 'Azul', 'Verde oscuro', 'Beige'];
const COMENTARIOS_CONDUCTOR = [
  'Puntual y muy amable.', 'Buen manejo, llegamos a tiempo.', 'Auto limpio y cómodo.', 'Excelente conductor.',
  'Saludó y respetó la ruta.', 'Todo bien, recomendado.', 'Un poco de demora al salir, pero buen viaje.',
];
const COMENTARIOS_PASAJERO = [
  'Puntual en el punto de encuentro.', 'Muy educado.', 'Sin problemas, buen pasajero.', 'Llegó a tiempo.',
];
const LETRAS = 'ABCDEFGHJKLMNPRSTUVXYZ';

// --- Conexión -------------------------------------------------------------------------------------------------------

const cliente = new pg.Client({ connectionString: env.DATABASE_URL_MIGRACIONES });
await cliente.connect();
await cliente.query("SELECT set_config('app.super_admin', 'true', false)");
const q = (texto: string, valores: unknown[] = []) => cliente.query(texto, valores);

const { rows: [{ n: existentes }] } = await q('SELECT count(*)::int AS n FROM organizaciones');
if (existentes > 0 && env.DEMO_FORZAR !== '1') {
  console.log('Ya hay organizaciones: datos de demostración omitidos (DEMO_FORZAR=1 para forzar).');
  await cliente.end();
  process.exit(0);
}

// Se omiten las organizaciones del catálogo que ya existen (por nombre o dominio): así convive con datos previos.
const { rows: yaExisten } = await q(
  `SELECT nombre_normalizado AS clave FROM organizaciones
   UNION SELECT dominio FROM dominios_organizacion`,
);
const claves = new Set(yaExisten.map((f) => f.clave as string));
const ORGANIZACIONES = CATALOGO.filter((o) => !claves.has(o.nombre.toLowerCase()) && !claves.has(o.dominio));
if (ORGANIZACIONES.length < 3) throw new Error('Se necesitan al menos 3 organizaciones nuevas del catálogo.');

// --- Fase 1: estructura ---------------------------------------------------------------------------------------------

const contrasena = env.DEMO_CONTRASENA ?? `Demo-${randomBytes(9).toString('base64url')}#7`;
const hashContrasena = await bcrypt.hash(contrasena, 12);

interface Persona {
  id: string;
  orgIdx: number;
  nombre: string;
  correo: string;
  admin: boolean;
  creadoEn: Date;
  conductor: boolean;
  verificada: boolean;
  billeteraId?: string;
  direccion?: string;
  vehiculoId?: string;
  capacidad?: number;
  barrio: Lugar;
}
interface Viaje {
  id: string;
  orgIdx: number;
  conductor: Persona;
  salida: Date;
  total: number;
  precio: number;
  origen: Lugar;
  destino: Lugar;
  estado: string;
  reservas: { id: string; pasajero: Persona }[];
}

const nombresUsados = new Set<string>();
const correosUsados = new Set<string>();
const nuevaPersona = (orgIdx: number, admin: boolean, conductor: boolean): Persona => {
  let nombre = '';
  let apellido1 = '';
  let apellido2 = '';
  do {
    nombre = elegir(NOMBRES);
    apellido1 = elegir(APELLIDOS);
    apellido2 = elegir(APELLIDOS);
  } while (nombresUsados.has(`${nombre} ${apellido1} ${apellido2}`));
  nombresUsados.add(`${nombre} ${apellido1} ${apellido2}`);
  let correo = `${sinTildes(nombre)}.${sinTildes(apellido1)}`.toLowerCase();
  if (correosUsados.has(`${correo}@${ORGANIZACIONES[orgIdx].dominio}`))
    correo += `.${sinTildes(apellido2)[0].toLowerCase()}`;
  correo = `${correo}@${ORGANIZACIONES[orgIdx].dominio}`;
  correosUsados.add(correo);
  return {
    id: randomUUID(),
    orgIdx,
    nombre: `${nombre} ${apellido1} ${apellido2}`,
    correo,
    admin,
    creadoEn: hace(entre(40, 75) * DIA_MS + entre(0, 20) * HORA_MS),
    conductor,
    verificada: true,
    barrio: elegir(BARRIOS),
  };
};

const personas: Persona[] = [];
ORGANIZACIONES.forEach((org, orgIdx) => {
  for (let i = 0; i < org.personas; i++)
    personas.push(nuevaPersona(orgIdx, i === 0, i > 0 && i <= org.conductores));
});
// Altas recientes sin verificar (sin billetera ni vehículo): una por organización grande.
const sinVerificar = personas.filter((x) => !x.admin && !x.conductor).slice(-3);
for (const p of sinVerificar) p.verificada = false;

const orgIds = ORGANIZACIONES.map(() => randomUUID());
const porOrg = (orgIdx: number) => personas.filter((p) => p.orgIdx === orgIdx);

await q('BEGIN');
try {
  for (const [i, org] of ORGANIZACIONES.entries()) {
    await q(
      `INSERT INTO organizaciones (id, nombre, nombre_normalizado, tipo, modo_aprobacion, precio_maximo_urc, creado_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [orgIds[i], org.nombre, org.nombre.toLowerCase(), org.tipo, i < 3 ? 'automatica' : 'manual', org.precioMax, hace((80 - i * 4) * DIA_MS)],
    );
    await q('INSERT INTO dominios_organizacion (organizacion_id, dominio) VALUES ($1,$2)', [orgIds[i], org.dominio]);
  }

  let carnet = 9_000_000;
  for (const p of personas) {
    await q(
      `INSERT INTO usuarios (id, correo, hash_contrasena, nombre_completo, ultima_organizacion_id, consentimiento_datos_en, creado_en)
       VALUES ($1,$2,$3,$4,$5,$6,$6)`,
      [p.id, p.correo, hashContrasena, p.nombre, orgIds[p.orgIdx], p.creadoEn],
    );
    const aprobada = p.verificada || p.admin;
    await q(
      `INSERT INTO membresias (organizacion_id, usuario_id, rol, estado, correo_institucional, decidido_en, motivo, creado_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        orgIds[p.orgIdx], p.id, p.admin ? 'admin_organizacion' : 'miembro',
        aprobada ? 'aprobada' : p === sinVerificar[0] ? 'rechazada' : 'pendiente',
        p.correo,
        aprobada || p === sinVerificar[0] ? new Date(p.creadoEn.getTime() + HORA_MS) : null,
        p === sinVerificar[0] ? 'El correo institucional no pudo validarse.' : null,
        p.creadoEn,
      ],
    );
    if (!p.verificada) continue;
    const verificadoEn = new Date(p.creadoEn.getTime() + 2 * HORA_MS);
    await q(
      `INSERT INTO identidades (usuario_id, documento_hash, estado, similitud_facial, consentimiento_en, verificado_en, creado_en)
       VALUES ($1,$2,'verificada',$3,$4,$5,$4)`,
      [p.id, hashDocumento(`DEMO-${++carnet}`), (94 + azar() * 5.5).toFixed(2), p.creadoEn, verificadoEn],
    );
    const cuenta = new Wallet(hexlify(randomBytes(32)));
    p.direccion = cuenta.address;
    p.billeteraId = randomUUID();
    await q(
      'INSERT INTO billeteras (id, usuario_id, direccion, llave_custodia_ref, creado_en) VALUES ($1,$2,$3,$4,$5)',
      [p.billeteraId, p.id, cuenta.address, cifrarLlave(cuenta.privateKey, cuenta.address), verificadoEn],
    );
  }

  const placas = new Set<string>();
  for (const p of personas.filter((x) => x.conductor && x.verificada)) {
    const auto = elegir(VEHICULOS);
    let placa = '';
    do {
      placa = `${entre(1000, 5999)}${elegir([...LETRAS])}${elegir([...LETRAS])}${elegir([...LETRAS])}`;
    } while (placas.has(placa));
    placas.add(placa);
    p.vehiculoId = randomUUID();
    p.capacidad = auto.capacidad;
    await q(
      `INSERT INTO vehiculos (id, propietario_id, placa, marca, modelo, color, capacidad, clave_s3_foto, consentimiento_foto_en, creado_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [p.vehiculoId, p.id, placa, auto.marca, auto.modelo, elegir(COLORES), auto.capacidad, `demo/vehiculos/${placa}.jpg`, new Date(p.creadoEn.getTime() + 5 * HORA_MS)],
    );
  }

  // --- Viajes ---------------------------------------------------------------------------------------------------------
  const conductores = personas.filter((p) => p.vehiculoId);
  const viajes: Viaje[] = [];
  const salidaLocal = (dias: number, tarde: boolean) => {
    const fecha = new Date(ahora + dias * DIA_MS);
    const hora = tarde ? entre(17, 19) : entre(6, 8);
    // Bolivia es UTC-4 todo el año.
    return new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate(), hora + 4, elegir([0, 15, 30, 45])));
  };
  for (const c of conductores) {
    const org = ORGANIZACIONES[c.orgIdx];
    const usados = new Set<string>();
    const crear = (dias: number, tarde: boolean) => {
      const clave = `${dias}-${tarde}`;
      if (usados.has(clave)) return;
      usados.add(clave);
      const origen = c.barrio;
      const destino = org.destino;
      const km = haversineKm(origen, destino);
      const precio = Math.min(org.precioMax, Math.max(3, Math.round(km * 0.9 * 2) / 2));
      const [desde, hasta] = tarde ? [destino, origen] : [origen, destino];
      viajes.push({
        id: randomUUID(), orgIdx: c.orgIdx, conductor: c, salida: salidaLocal(dias, tarde),
        total: Math.min(c.capacidad!, entre(2, 4)), precio, origen: desde, destino: hasta,
        estado: dias < 0 ? 'pagado' : 'publicado', reservas: [],
      });
    };
    for (let i = 0; i < 4; i++) crear(-entre(1, 30), azar() < 0.4);
    for (let i = 0; i < 2; i++) crear(entre(1, 6), azar() < 0.4);
  }
  const pasados = viajes.filter((v) => v.salida.getTime() < ahora);
  const futuros = viajes.filter((v) => v.salida.getTime() >= ahora);

  // Con dinero real: unos pocos viajes pasados pagados, reservas futuras confirmadas y una cancelación con reembolso.
  const idsDinero = (lista: Viaje[], cuantos: number, orgs: number[]) =>
    barajar(lista).filter((v) => orgs.includes(v.orgIdx)).slice(0, cuantos);
  const dineroPasados = idsDinero(pasados, 6, [0, 0, 1, 2]);
  const dineroFuturos = idsDinero(futuros.filter((v) => !dineroPasados.some((d) => d.conductor === v.conductor)), 9, [0, 1, 2]);
  const viajeCancelado = dineroFuturos.pop()!;
  // Los pasados con dinero se publican provisionalmente en el futuro: así el worker de vencimientos no los expira
  // antes de la fase 3, que los lleva a su fecha real.
  const fechaRealDinero = new Map(dineroPasados.map((v) => [v.id, v.salida]));
  for (const v of dineroPasados) {
    v.salida = new Date(ahora + 3 * HORA_MS);
    v.estado = 'publicado';
  }
  // Otros pasados: algunos sin pasajeros (expirado/cancelado) para que el historial no sea perfecto.
  for (const v of pasados.filter((x) => !dineroPasados.includes(x))) {
    const r = azar();
    v.estado = r < 0.07 ? 'expirado' : r < 0.15 ? 'cancelado' : 'pagado';
  }

  const pasajerosPosibles = (orgIdx: number, conductorId: string) =>
    porOrg(orgIdx).filter((p) => p.billeteraId && p.id !== conductorId && !p.admin);
  const dineroTodos = [...dineroPasados, ...dineroFuturos, viajeCancelado];
  // Pasajeros con dinero real: pocos y repetidos (viajeros frecuentes).
  const grupoDinero: Record<number, Persona[]> = {};
  for (const orgIdx of [0, 1, 2])
    grupoDinero[orgIdx] = barajar(pasajerosPosibles(orgIdx, '')).filter((p) => !p.conductor).slice(0, orgIdx === 0 ? 4 : 3);
  const reservasDinero: { viaje: Viaje; pasajero: Persona; id: string }[] = [];
  const turno: Record<number, number> = { 0: 0, 1: 0, 2: 0 };
  for (const v of dineroTodos) {
    const grupo = grupoDinero[v.orgIdx];
    const pasajero = grupo[turno[v.orgIdx]++ % grupo.length];
    reservasDinero.push({ viaje: v, pasajero, id: randomUUID() });
  }

  for (const v of viajes) {
    const marcaTiempo = new Date(Math.min(ahora, v.salida.getTime()) - entre(1, 6) * DIA_MS);
    const delDinero = reservasDinero.find((r) => r.viaje === v);
    let reservas: Persona[] = [];
    if (v.estado === 'pagado') {
      const candidatos = barajar(pasajerosPosibles(v.orgIdx, v.conductor.id));
      reservas = candidatos.slice(0, entre(1, Math.min(3, v.total)));
    }
    const nReservas = reservas.length + (delDinero ? 1 : 0);
    await q(
      `INSERT INTO viajes (id, organizacion_id, conductor_id, vehiculo_id, origen_nombre, origen_lat, origen_lng, destino_nombre, destino_lat,
         destino_lng, fecha_hora_salida, cupos_totales, cupos_disponibles, precio_por_asiento, estado, creado_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::estado_viaje,$16)`,
      [
        v.id, orgIds[v.orgIdx], v.conductor.id, v.conductor.vehiculoId, v.origen.nombre, v.origen.lat, v.origen.lng,
        v.destino.nombre, v.destino.lat, v.destino.lng, v.salida, v.total, v.total - nReservas, v.precio.toFixed(2),
        v.estado, marcaTiempo,
      ],
    );
    for (const pasajero of reservas) {
      const reservaId = randomUUID();
      v.reservas.push({ id: reservaId, pasajero });
      const creada = new Date(v.salida.getTime() - entre(2, 20) * HORA_MS);
      await q(
        `INSERT INTO reservas (id, organizacion_id, viaje_id, pasajero_id, monto, estado, clave_idempotencia, evaluacion,
           anomalias_evaluadas_en, creado_en, actualizado_en)
         VALUES ($1,$2,$3,$4,$5,'pagada',$6,$7,now(),$8,$9)`,
        [reservaId, orgIds[v.orgIdx], v.id, pasajero.id, v.precio.toFixed(2), `demo:${reservaId}`, JSON.stringify({ origen: 'datos_demo' }), creada, new Date(v.salida.getTime() + HORA_MS)],
      );
    }
  }

  // Calificaciones de los viajes pagados (sin dinero): el pasajero casi siempre califica; el conductor, a veces.
  let nCalificaciones = 0;
  for (const v of viajes.filter((x) => x.estado === 'pagado'))
    for (const r of v.reservas) {
      const cuando = (h: number) => new Date(v.salida.getTime() + h * HORA_MS);
      const estrellas = () => (azar() < 0.62 ? 5 : azar() < 0.8 ? 4 : azar() < 0.6 ? 3 : entre(1, 2));
      const insertar = async (autor: string, destinatario: string, comentarios: string[], horas: number) => {
        const n = estrellas();
        await q(
          `INSERT INTO calificaciones (organizacion_id, reserva_id, autor_id, destinatario_id, estrellas, comentario, creado_en)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [orgIds[v.orgIdx], r.id, autor, destinatario, n, n >= 4 && azar() < 0.45 ? elegir(comentarios) : null, cuando(horas)],
        );
        nCalificaciones++;
      };
      if (azar() < 0.85) await insertar(r.pasajero.id, v.conductor.id, COMENTARIOS_CONDUCTOR, entre(2, 20));
      if (azar() < 0.45) await insertar(v.conductor.id, r.pasajero.id, COMENTARIOS_PASAJERO, entre(2, 30));
    }

  // Recargas con dinero real (fase 2): se encolan aquí y el worker las acuña.
  const necesidad = new Map<Persona, number>();
  for (const r of reservasDinero) necesidad.set(r.pasajero, (necesidad.get(r.pasajero) ?? 0) + r.viaje.precio);
  const extras = barajar(personas.filter((p) => p.billeteraId && !p.admin && !necesidad.has(p))).slice(0, 2);
  extras.forEach((p, i) => necesidad.set(p, i === 0 ? 30 : 15));
  const recargas: { persona: Persona; monto: number }[] = [];
  for (const [persona, falta] of necesidad) {
    const monto = Math.min(500, Math.max(10, Math.ceil((falta + 20) / 10) * 10));
    recargas.push({ persona, monto });
    const ordenId = randomUUID();
    const creada = hace(entre(26, 34) * DIA_MS);
    await q(
      `INSERT INTO ordenes_recarga (id, usuario_id, billetera_id, monto, estado, expira_en, creado_en)
       VALUES ($1,$2,$3,$4,'procesando',$5,$6)`,
      [ordenId, persona.id, persona.billeteraId, monto.toFixed(2), new Date(creada.getTime() + 15 * 60_000), creada],
    );
    const { rows: [mov] } = await q(
      `INSERT INTO movimientos_billetera (billetera_id, tipo, monto, estado, clave_idempotencia, creado_en)
       VALUES ($1,'recarga',$2,'pendiente',$3,$4) RETURNING id`,
      [persona.billeteraId, monto.toFixed(2), `recarga:${ordenId}`, creada],
    );
    await q("INSERT INTO trabajos_onchain (movimiento_id, operacion) VALUES ($1,'acunar_recarga')", [mov.id]);
  }

  await q('COMMIT');
  console.log(
    `Fase 1 lista: ${ORGANIZACIONES.length} organizaciones, ${personas.length} personas, ${conductores.length} vehículos, ` +
      `${viajes.length} viajes, ${nCalificaciones} calificaciones, ${recargas.length} recargas en cola.`,
  );

  // --- Esperas y fases con dinero -------------------------------------------------------------------------------------
  const esperarCola = async (etiqueta: string) => {
    const limite = Date.now() + 25 * 60_000;
    for (;;) {
      const { rows: [e] } = await q(
        `SELECT count(*) FILTER (WHERE estado = 'pendiente')::int AS pendientes,
                coalesce(max(intentos) FILTER (WHERE estado = 'pendiente'), 0)::int AS maximo,
                max(ultimo_error) FILTER (WHERE estado = 'pendiente') AS error
         FROM trabajos_onchain`,
      );
      if (e.pendientes === 0) return console.log(`${etiqueta}: cola vacía.`);
      if (e.maximo >= 3 || Date.now() > limite)
        throw new Error(`${etiqueta}: ${e.pendientes} trabajos sin terminar (intentos ${e.maximo}, error ${e.error ?? '-'}).`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  };
  await esperarCola('Recargas');

  // Fase 2: los bloqueos de las reservas con dinero.
  await q('BEGIN');
  for (const r of reservasDinero) {
    const v = r.viaje;
    const creada = new Date(Math.min(ahora, (fechaRealDinero.get(v.id) ?? v.salida).getTime()) - entre(8, 30) * HORA_MS);
    await q(
      `INSERT INTO reservas (id, organizacion_id, viaje_id, pasajero_id, monto, estado, clave_idempotencia, evaluacion, anomalias_evaluadas_en,
         creado_en, actualizado_en)
       VALUES ($1,$2,$3,$4,$5,'pendiente',$6,$7,now(),$8,$8)`,
      [r.id, orgIds[v.orgIdx], v.id, r.pasajero.id, v.precio.toFixed(2), `demo:${r.id}`, JSON.stringify({ origen: 'datos_demo' }), creada],
    );
    const { rows: [mov] } = await q(
      `INSERT INTO movimientos_billetera (billetera_id, tipo, monto, estado, reserva_id, clave_idempotencia, creado_en)
       VALUES ($1,'bloqueo_reserva',$2,'pendiente',$3,$4,$5) RETURNING id`,
      [r.pasajero.billeteraId, v.precio.toFixed(2), r.id, `reserva:${r.id}`, creada],
    );
    await q("INSERT INTO trabajos_onchain (movimiento_id, operacion) VALUES ($1,'bloquear_reserva')", [mov.id]);
  }
  await q('COMMIT');
  await esperarCola('Bloqueos');

  // Fase 3: viajes pasados verificados (pago al conductor) y el viaje cancelado (reembolso al pasajero).
  await q('BEGIN');
  for (const r of reservasDinero) {
    const v = r.viaje;
    const real = fechaRealDinero.get(v.id);
    if (real) {
      await q('UPDATE viajes SET fecha_hora_salida = $1 WHERE id = $2', [real, v.id]);
      await q("UPDATE reservas SET estado = 'verificada', actualizado_en = $1 WHERE id = $2 AND estado = 'confirmada'", [new Date(real.getTime() + HORA_MS), r.id]);
      const { rows: [mov] } = await q(
        `INSERT INTO movimientos_billetera (billetera_id, tipo, monto, estado, reserva_id, clave_idempotencia, metadatos, creado_en)
         VALUES ($1,'liberacion_viaje',$2,'pendiente',$3,$4,$5,$6) RETURNING id`,
        [v.conductor.billeteraId, v.precio.toFixed(2), r.id, `liberacion:${r.id}`, JSON.stringify({ hashPrueba: hexlify(randomBytes(32)) }), new Date(real.getTime() + HORA_MS)],
      );
      await q("INSERT INTO trabajos_onchain (movimiento_id, operacion) VALUES ($1,'liberar_reserva')", [mov.id]);
    } else if (v === viajeCancelado) {
      // Sin correo: el reembolso lo encola el script, no el worker de vencimientos (que avisaría a una dirección de demostración).
      await q("UPDATE viajes SET estado = 'cancelado', cupos_disponibles = cupos_totales WHERE id = $1", [v.id]);
      await q("UPDATE reservas SET estado = 'cancelada', motivo = 'cancelada_conductor' WHERE id = $1 AND estado = 'confirmada'", [r.id]);
      const { rows: [mov] } = await q(
        `INSERT INTO movimientos_billetera (billetera_id, tipo, monto, estado, reserva_id, clave_idempotencia, metadatos)
         VALUES ($1,'reembolso_reserva',$2,'pendiente',$3,$4,$5) RETURNING id`,
        [r.pasajero.billeteraId, v.precio.toFixed(2), r.id, `reembolso:${r.id}`, JSON.stringify({ porcentajePasajeroBps: 10000, montoConductor: '0.00', motivo: 'cancelada_conductor' })],
      );
      await q("INSERT INTO trabajos_onchain (movimiento_id, operacion) VALUES ($1,'reembolsar_reserva')", [mov.id]);
    }
  }
  await q('COMMIT');
  await esperarCola('Pagos y reembolso');

  // Estados finales de las reservas con dinero y calificaciones de los viajes pagados con dinero real.
  const { rows: estados } = await q(
    `SELECT r.estado, count(*)::int AS n FROM reservas r WHERE r.evaluacion->>'origen' = 'datos_demo' AND r.id = ANY($1::uuid[]) GROUP BY 1`,
    [reservasDinero.map((r) => r.id)],
  );
  console.log('Reservas con dinero:', JSON.stringify(estados));
  for (const r of reservasDinero.filter((x) => fechaRealDinero.has(x.viaje.id))) {
    const real = fechaRealDinero.get(r.viaje.id)!;
    await q(
      `INSERT INTO calificaciones (organizacion_id, reserva_id, autor_id, destinatario_id, estrellas, comentario, creado_en)
       SELECT $1,$2,$3,$4,$5,$6,$7 WHERE EXISTS (SELECT 1 FROM reservas WHERE id = $2 AND estado = 'pagada')`,
      [orgIds[r.viaje.orgIdx], r.id, r.pasajero.id, r.viaje.conductor.id, azar() < 0.7 ? 5 : 4, azar() < 0.5 ? elegir(COMENTARIOS_CONDUCTOR) : null, new Date(real.getTime() + 5 * HORA_MS)],
    );
  }

  await q(
    `INSERT INTO registros_auditoria (accion, entidad, resultado, detalle)
     VALUES ('datos_demo.carga','sistema','ok',$1)`,
    [JSON.stringify({ organizaciones: ORGANIZACIONES.length, personas: personas.length, viajes: viajes.length })],
  );

  // --- Comprobación contra la cadena ------------------------------------------------------------------------------------
  if (env.BLOCKCHAIN_SIMULADA !== 'true' && env.DIRECCION_TOKEN_URC && env.CADENA_RPC_URL) {
    const proveedor = new JsonRpcProvider(env.CADENA_RPC_URL);
    const token = new Contract(env.DIRECCION_TOKEN_URC, ['function balanceOf(address) view returns (uint256)'], proveedor);
    const { rows } = await q(
      `SELECT b.direccion,
         coalesce(sum(CASE m.tipo WHEN 'bloqueo_reserva' THEN -m.monto ELSE m.monto END) FILTER (WHERE m.estado = 'confirmado'), 0)::text AS contable
       FROM billeteras b JOIN movimientos_billetera m ON m.billetera_id = b.id GROUP BY b.direccion`,
    );
    let diferencias = 0;
    for (const f of rows) {
      const cadena = ((await token.balanceOf(f.direccion)) as bigint) / 10n ** 16n; // 18 decimales → centésimas
      const libro = BigInt(Math.round(Number(f.contable) * 100));
      if (cadena !== libro) {
        diferencias++;
        console.log(`DIFERENCIA ${f.direccion}: cadena ${cadena} vs libro ${libro} (centésimas)`);
      }
    }
    console.log(`Conciliación: ${rows.length} billeteras, ${diferencias} diferencias.`);
  }
} catch (error) {
  await q('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await cliente.end();
}

console.log(`\nContraseña de todas las cuentas de demostración: ${contrasena}`);
console.log(`Administradores de organización: ${personas.filter((p) => p.admin).map((p) => p.correo).join(', ')}`);
