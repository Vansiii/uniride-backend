-- HU-17: viaje publicado por un conductor en su organización activa. Dato institucional: lleva organizacion_id y RLS (A-13).

CREATE TYPE "estado_viaje" AS ENUM ('publicado', 'reservado', 'en_curso', 'verificado', 'pagado', 'cancelado', 'expirado');

CREATE TABLE "viajes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizacion_id" UUID NOT NULL,
    "conductor_id" UUID NOT NULL,
    "vehiculo_id" UUID NOT NULL,
    "origen_nombre" TEXT NOT NULL,
    "origen_lat" DECIMAL(9,6) NOT NULL,
    "origen_lng" DECIMAL(9,6) NOT NULL,
    "destino_nombre" TEXT NOT NULL,
    "destino_lat" DECIMAL(9,6) NOT NULL,
    "destino_lng" DECIMAL(9,6) NOT NULL,
    "fecha_hora_salida" TIMESTAMPTZ(3) NOT NULL,
    "cupos_totales" INTEGER NOT NULL,
    "cupos_disponibles" INTEGER NOT NULL,
    "precio_por_asiento" DECIMAL(12,2) NOT NULL,
    "estado" "estado_viaje" NOT NULL DEFAULT 'publicado',
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "viajes_pkey" PRIMARY KEY ("id"),
    -- RN-3: la capacidad de un vehículo va de 1 a 6; el tope de su vehículo lo valida la API (CA-2).
    CONSTRAINT "viajes_cupos_totales_chk" CHECK ("cupos_totales" BETWEEN 1 AND 6),
    CONSTRAINT "viajes_cupos_disponibles_chk" CHECK ("cupos_disponibles" BETWEEN 0 AND "cupos_totales"),
    -- CA-3: el máximo depende de `organizaciones.precio_maximo_urc`; lo valida la API.
    CONSTRAINT "viajes_precio_chk" CHECK ("precio_por_asiento" >= 1),
    -- RN-4: WGS84.
    CONSTRAINT "viajes_origen_chk" CHECK ("origen_lat" BETWEEN -90 AND 90 AND "origen_lng" BETWEEN -180 AND 180),
    CONSTRAINT "viajes_destino_chk" CHECK ("destino_lat" BETWEEN -90 AND 90 AND "destino_lng" BETWEEN -180 AND 180)
);
CREATE INDEX "viajes_organizacion_id_estado_fecha_hora_salida_idx" ON "viajes"("organizacion_id", "estado", "fecha_hora_salida");
-- CA-5 y `mis-viajes`: los viajes de una persona, en todas sus organizaciones.
CREATE INDEX "viajes_conductor_id_fecha_hora_salida_idx" ON "viajes"("conductor_id", "fecha_hora_salida");

ALTER TABLE "viajes" ADD CONSTRAINT "viajes_organizacion_id_fkey" FOREIGN KEY ("organizacion_id") REFERENCES "organizaciones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "viajes" ADD CONSTRAINT "viajes_conductor_id_fkey" FOREIGN KEY ("conductor_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "viajes" ADD CONSTRAINT "viajes_vehiculo_id_fkey" FOREIGN KEY ("vehiculo_id") REFERENCES "vehiculos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "viajes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "viajes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "viajes_aislamiento" ON "viajes" USING (
  "organizacion_id" = nullif(current_setting('app.organizacion_id', true), '')::uuid
  OR current_setting('app.super_admin', true) = 'true'
);

-- Rol de la API: esta historia solo publica y lee; los cambios de estado y de cupos llegan con sus historias.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uniride_app') THEN
    REVOKE ALL ON "viajes" FROM uniride_app;
    GRANT SELECT, INSERT ON "viajes" TO uniride_app;
  END IF;
END $$;
