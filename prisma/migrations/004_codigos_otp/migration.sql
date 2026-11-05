-- HU-05: códigos OTP de un solo uso (registro; luego HU-07 y HU-34).
-- Dato personal (D-07): sin organizacion_id ni RLS, se protege por correo en la API.

CREATE TABLE "codigos_otp" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "correo" TEXT NOT NULL,
    "proposito" TEXT NOT NULL,
    "hash_codigo" TEXT NOT NULL,
    "datos" JSONB NOT NULL,
    "vence_en" TIMESTAMPTZ(3) NOT NULL,
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "bloqueado_hasta" TIMESTAMPTZ(3),
    "usado_en" TIMESTAMPTZ(3),
    "invalidado_en" TIMESTAMPTZ(3),
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "codigos_otp_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "codigos_otp_correo_minusculas_chk" CHECK ("correo" = lower("correo")),
    CONSTRAINT "codigos_otp_proposito_chk" CHECK ("proposito" IN ('registro', 'agregar_organizacion', 'recuperacion'))
);
-- Límites de reenvío (1/min, 5/h) y búsqueda del código vigente.
CREATE INDEX "codigos_otp_correo_proposito_creado_en_idx" ON "codigos_otp"("correo", "proposito", "creado_en");

-- Rol de la API: sin borrado.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uniride_app') THEN
    REVOKE ALL ON "codigos_otp" FROM uniride_app;
    GRANT SELECT, INSERT, UPDATE ON "codigos_otp" TO uniride_app;
  END IF;
END $$;
