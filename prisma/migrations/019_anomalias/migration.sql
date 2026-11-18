-- HU-25: detección de anomalías y bloqueo preventivo. No borra ni transforma datos.

-- Los bloqueos son de la persona (D-07), no de una organización: se cuentan en todas sus organizaciones (RN-8).
-- Solo inserción: levantar un bloqueo es dejar que venza (RN-7); extenderlo es insertar otro de fin mayor (CA-9).
CREATE TABLE "bloqueos_preventivos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tipo" TEXT NOT NULL,
    "usuario_id" UUID NOT NULL,
    "usuario_par_id" UUID,
    "patron" TEXT NOT NULL,
    "reserva_id" UUID NOT NULL,
    "vence_en" TIMESTAMPTZ(3) NOT NULL,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bloqueos_preventivos_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bloqueos_preventivos_tipo_chk" CHECK ("tipo" IN ('par', 'cuenta')),
    CONSTRAINT "bloqueos_preventivos_patron_chk" CHECK ("patron" IN ('viajes_repetidos', 'sin_desplazamiento', 'verificaciones_fallidas')),
    CONSTRAINT "bloqueos_preventivos_par_chk" CHECK (("tipo" = 'cuenta') = ("usuario_par_id" IS NULL)),
    -- En el par se guarda ordenado, así una sola fila sirve a los dos roles.
    CONSTRAINT "bloqueos_preventivos_orden_chk" CHECK ("usuario_par_id" IS NULL OR "usuario_id" < "usuario_par_id")
);
-- CA-10: la misma evaluación repetida no duplica bloqueos.
CREATE UNIQUE INDEX "bloqueos_preventivos_reserva_patron_usuario_key" ON "bloqueos_preventivos"("reserva_id", "patron", "usuario_id");
CREATE INDEX "bloqueos_preventivos_usuario_vence_idx" ON "bloqueos_preventivos"("usuario_id", "vence_en");
CREATE INDEX "bloqueos_preventivos_par_vence_idx" ON "bloqueos_preventivos"("usuario_par_id", "vence_en");

ALTER TABLE "bloqueos_preventivos" ADD CONSTRAINT "bloqueos_preventivos_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bloqueos_preventivos" ADD CONSTRAINT "bloqueos_preventivos_usuario_par_id_fkey" FOREIGN KEY ("usuario_par_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bloqueos_preventivos" ADD CONSTRAINT "bloqueos_preventivos_reserva_id_fkey" FOREIGN KEY ("reserva_id") REFERENCES "reservas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Reserva ya evaluada por el tic de anomalías; las pagadas anteriores quedan sin evaluar y el primer tic las evalúa.
ALTER TABLE "reservas" ADD COLUMN "anomalias_evaluadas_en" TIMESTAMPTZ(3);
CREATE INDEX "reservas_anomalias_pendientes_idx" ON "reservas"("estado") WHERE "anomalias_evaluadas_en" IS NULL AND "estado" IN ('pagada', 'verificacion_fallida');

-- Rol de la API: sin UPDATE ni DELETE sobre los bloqueos (A-08).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uniride_app') THEN
    REVOKE ALL ON "bloqueos_preventivos" FROM uniride_app;
    GRANT SELECT, INSERT ON "bloqueos_preventivos" TO uniride_app;
    GRANT UPDATE ("anomalias_evaluadas_en") ON "reservas" TO uniride_app;
  END IF;
END $$;
