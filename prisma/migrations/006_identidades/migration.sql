-- HU-08: verificación de identidad. Dato personal (D-07): sin organizacion_id ni RLS, se protege por dueño en la API.
-- Fuente de verdad del estado de identidad (usuarios.estado_identidad no se usa). El hash del documento, la clave
-- del carnet en S3 y el face id nunca salen de la API (CA-8). Sin fila = no verificada.

CREATE TABLE "identidades" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "usuario_id" UUID NOT NULL,
    -- HMAC-SHA256 del número de carnet normalizado; solo se llena al verificar (A-02).
    "documento_hash" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'no_verificada',
    "similitud_facial" DECIMAL(5,2),
    "clave_s3_carnet" TEXT,
    "face_id_coleccion" TEXT,
    "intentos_fallidos" INTEGER NOT NULL DEFAULT 0,
    "bloqueado_hasta" TIMESTAMPTZ(3),
    "consentimiento_en" TIMESTAMPTZ(3) NOT NULL,
    "verificado_en" TIMESTAMPTZ(3),
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "identidades_pkey" PRIMARY KEY ("id"),
    -- RN-6
    CONSTRAINT "identidades_estado_chk" CHECK ("estado" IN ('no_verificada', 'en_revision', 'verificada', 'rechazada', 'bloqueada_temporal')),
    CONSTRAINT "identidades_intentos_chk" CHECK ("intentos_fallidos" >= 0),
    CONSTRAINT "identidades_similitud_chk" CHECK ("similitud_facial" IS NULL OR "similitud_facial" BETWEEN 0 AND 100),
    -- Verificada exige documento y fecha: ningún camino deja una identidad verificada a medias.
    CONSTRAINT "identidades_verificada_chk" CHECK ("estado" <> 'verificada' OR ("documento_hash" IS NOT NULL AND "verificado_en" IS NOT NULL))
);
-- Una identidad por cuenta.
CREATE UNIQUE INDEX "identidades_usuario_id_key" ON "identidades"("usuario_id");
-- RN-2 / A-02: un documento, una sola cuenta en toda la plataforma (varios NULL permitidos).
CREATE UNIQUE INDEX "identidades_documento_hash_key" ON "identidades"("documento_hash");

ALTER TABLE "identidades" ADD CONSTRAINT "identidades_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rol de la API: nunca borra una identidad.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uniride_app') THEN
    REVOKE ALL ON "identidades" FROM uniride_app;
    GRANT SELECT, INSERT, UPDATE ON "identidades" TO uniride_app;
  END IF;
END $$;
