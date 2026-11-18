-- HU-10: historial de dispositivos y revinculación (Capa 2).
-- Permite conservar dispositivos anteriores inactivos (RN-6) manteniendo la regla de un solo dispositivo activo por cuenta (RN-1 / A-02).

-- Quita la restricción de unicidad estricta por usuario
DROP INDEX IF EXISTS "dispositivos_usuario_id_key";

-- Agrega la columna desactivado_en
ALTER TABLE "dispositivos" ADD COLUMN "desactivado_en" TIMESTAMPTZ(3);

-- Índice general para consultas por usuarioId
CREATE INDEX "dispositivos_usuario_id_idx" ON "dispositivos"("usuario_id");

-- Índice único parcial (RN-1): solo un dispositivo activo por usuario
CREATE UNIQUE INDEX "dispositivos_usuario_activo_key" ON "dispositivos"("usuario_id") WHERE "activo";

