import { defineConfig } from 'prisma/config';

// En local se usa el .env de la raíz del monorepo; en Docker, CI y AWS las variables ya vienen del entorno.
try {
  process.loadEnvFile('../.env');
} catch {
  // sin .env: se usan las variables del entorno
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Las migraciones usan el rol dueño; la API usa DATABASE_URL (rol sin privilegios, RLS forzado).
  datasource: { url: process.env.DATABASE_URL_MIGRACIONES },
});
