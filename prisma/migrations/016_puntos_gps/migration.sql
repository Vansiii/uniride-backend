-- HU-23: seguimiento del trayecto. Dato institucional: organizacion_id y RLS (A-13). No borra ni transforma datos.

-- RN-1: una posición cada 15 s por persona. Es del viaje y de la persona (la del conductor sirve a todas sus reservas).
-- RN-8: solo para verificar el viaje (y HU-25, HU-28); no sale en logs ni a terceros.
CREATE TABLE "puntos_gps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizacion_id" UUID NOT NULL,
    "viaje_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "precision_m" DOUBLE PRECISION NOT NULL,
    "tomada_en" TIMESTAMPTZ(3) NOT NULL,
    "simulada" BOOLEAN NOT NULL,
    "recibido_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "puntos_gps_pkey" PRIMARY KEY ("id")
);
-- CA-9: el repetido se ignora (ON CONFLICT DO NOTHING). También sirve al rango de la evaluación.
CREATE UNIQUE INDEX "puntos_gps_viaje_usuario_tomada_key" ON "puntos_gps"("viaje_id", "usuario_id", "tomada_en");

ALTER TABLE "puntos_gps" ADD CONSTRAINT "puntos_gps_organizacion_id_fkey" FOREIGN KEY ("organizacion_id") REFERENCES "organizaciones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "puntos_gps" ADD CONSTRAINT "puntos_gps_viaje_id_fkey" FOREIGN KEY ("viaje_id") REFERENCES "viajes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "puntos_gps" ADD CONSTRAINT "puntos_gps_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "puntos_gps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "puntos_gps" FORCE ROW LEVEL SECURITY;
CREATE POLICY "puntos_gps_aislamiento" ON "puntos_gps" USING (
  "organizacion_id" = nullif(current_setting('app.organizacion_id', true), '')::uuid
  OR current_setting('app.super_admin', true) = 'true'
);

-- CA-15: resultado de la evaluación de la reserva (pares, coincidencia, velocidad máxima, motivo).
ALTER TABLE "reservas" ADD COLUMN "evaluacion" JSONB;

-- Rol de la API: los puntos solo se insertan y se leen; de la reserva, además, se escribe la evaluación.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uniride_app') THEN
    REVOKE ALL ON "puntos_gps" FROM uniride_app;
    GRANT SELECT, INSERT ON "puntos_gps" TO uniride_app;
    GRANT UPDATE ("evaluacion") ON "reservas" TO uniride_app;
  END IF;
END $$;
