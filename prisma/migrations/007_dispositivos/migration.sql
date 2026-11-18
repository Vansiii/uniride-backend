-- HU-09: dispositivo vinculado a la cuenta (Capa 2). Dato personal (D-07): sin organizacion_id ni RLS, se protege por dueño en la API.
-- Solo se guarda la llave pública del Keystore; la privada nunca sale del teléfono.

CREATE TABLE "dispositivos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "usuario_id" UUID NOT NULL,
    "llave_publica" TEXT NOT NULL,
    "algoritmo" TEXT NOT NULL DEFAULT 'ECDSA_P256',
    "modelo_dispositivo" TEXT NOT NULL,
    "veredicto_integridad" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "vinculado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimo_uso_en" TIMESTAMPTZ(3),
    CONSTRAINT "dispositivos_pkey" PRIMARY KEY ("id"),
    -- RN-2: solo ECDSA sobre P-256.
    CONSTRAINT "dispositivos_algoritmo_chk" CHECK ("algoritmo" = 'ECDSA_P256'),
    CONSTRAINT "dispositivos_llave_publica_chk" CHECK (length("llave_publica") > 0),
    CONSTRAINT "dispositivos_modelo_chk" CHECK (length("modelo_dispositivo") > 0),
    -- RN-1: no se vincula sin un veredicto de integridad.
    CONSTRAINT "dispositivos_veredicto_chk" CHECK (length("veredicto_integridad") > 0)
);
-- RN-3 / A-02: un dispositivo por cuenta; el UNIQUE decide la vinculación concurrente.
CREATE UNIQUE INDEX "dispositivos_usuario_id_key" ON "dispositivos"("usuario_id");

ALTER TABLE "dispositivos" ADD CONSTRAINT "dispositivos_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rol de la API: vincula, actualiza `ultimo_uso_en` y (HU-10) desactiva; no borra.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uniride_app') THEN
    REVOKE ALL ON "dispositivos" FROM uniride_app;
    GRANT SELECT, INSERT, UPDATE ON "dispositivos" TO uniride_app;
  END IF;
END $$;
