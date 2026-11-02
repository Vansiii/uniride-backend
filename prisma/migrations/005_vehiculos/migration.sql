-- HU-11: vehículo del conductor. Dato personal (D-07): sin organizacion_id ni RLS, se protege por dueño en la API.
-- La foto vive cifrada en S3; aquí solo su clave, que nunca sale de la API (D-20).

CREATE TABLE "vehiculos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "propietario_id" UUID NOT NULL,
    "placa" TEXT NOT NULL,
    "marca" TEXT NOT NULL,
    "modelo" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "capacidad" INTEGER NOT NULL,
    "clave_s3_foto" TEXT NOT NULL,
    "consentimiento_foto_en" TIMESTAMPTZ(3) NOT NULL,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vehiculos_pkey" PRIMARY KEY ("id"),
    -- RN-3: asientos para pasajeros, sin contar al conductor.
    CONSTRAINT "vehiculos_capacidad_chk" CHECK ("capacidad" BETWEEN 1 AND 6),
    -- RN-2: placa boliviana ya normalizada (CA-3).
    CONSTRAINT "vehiculos_placa_chk" CHECK ("placa" ~ '^[0-9]{3,4}[A-Z]{3}$')
);
-- RN-1: única en todo UniRide.
CREATE UNIQUE INDEX "vehiculos_placa_key" ON "vehiculos"("placa");
-- RN-4: un vehículo por conductor en v1.
CREATE UNIQUE INDEX "vehiculos_propietario_id_key" ON "vehiculos"("propietario_id");

ALTER TABLE "vehiculos" ADD CONSTRAINT "vehiculos_propietario_id_fkey" FOREIGN KEY ("propietario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rol de la API: en v1 no se edita ni se borra (spec §5).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uniride_app') THEN
    REVOKE ALL ON "vehiculos" FROM uniride_app;
    GRANT SELECT, INSERT ON "vehiculos" TO uniride_app;
  END IF;
END $$;
