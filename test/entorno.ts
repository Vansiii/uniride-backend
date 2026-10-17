// Carga el .env de la raíz para las pruebas e2e (base PostgreSQL de `docker compose`).
try {
  process.loadEnvFile('../.env');
} catch {
  // en CI las variables ya vienen del entorno
}
