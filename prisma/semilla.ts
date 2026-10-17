// Crea el super administrador si no existe (HU-06). Uso: npm run prisma:semilla
// Ejecutar con Node 24 (quita los tipos solo). Borrar SUPER_ADMIN_CONTRASENA_INICIAL tras el primer uso.
import bcrypt from 'bcryptjs';
import pg from 'pg';

try {
  process.loadEnvFile('../.env');
} catch {
  // sin .env: se usan las variables del entorno
}

const correo = process.env.SUPER_ADMIN_CORREO?.trim().toLowerCase();
const contrasena = process.env.SUPER_ADMIN_CONTRASENA_INICIAL;
if (!correo || !contrasena) {
  console.log(
    'Semilla omitida: faltan SUPER_ADMIN_CORREO o SUPER_ADMIN_CONTRASENA_INICIAL.',
  );
  process.exit(0);
}

const cliente = new pg.Client({
  connectionString: process.env.DATABASE_URL_MIGRACIONES,
});
await cliente.connect();
const existente = await cliente.query(
  `SELECT 1 FROM usuarios WHERE rol_plataforma = 'super_admin' OR lower(correo) = $1`,
  [correo],
);
if (existente.rowCount === 0) {
  await cliente.query(
    `INSERT INTO usuarios (correo, hash_contrasena, nombre_completo, rol_plataforma)
     VALUES ($1, $2, 'Super administrador', 'super_admin')`,
    [correo, await bcrypt.hash(contrasena, 12)],
  );
  console.log('Super administrador creado.');
} else {
  console.log('El super administrador ya existe.');
}
await cliente.end();
