-- HU-12: billetera de la persona. Dato personal (D-07): sin organizacion_id ni RLS, se protege por dueño en la API.
-- La llave privada se guarda solo cifrada con AES-256-GCM (A-12); nunca en texto claro.

CREATE TABLE "billeteras" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "usuario_id" UUID NOT NULL,
    "direccion" TEXT NOT NULL,
    "llave_custodia_ref" TEXT NOT NULL,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billeteras_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billeteras_direccion_chk" CHECK ("direccion" ~ '^0x[0-9a-fA-F]{40}$')
);
-- RN-2 / A-02: una billetera por usuario; el UNIQUE decide la creación concurrente.
CREATE UNIQUE INDEX "billeteras_usuario_id_key" ON "billeteras"("usuario_id");
CREATE UNIQUE INDEX "billeteras_direccion_key" ON "billeteras"("direccion");

ALTER TABLE "billeteras" ADD CONSTRAINT "billeteras_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Spec §4, cuenta suspendida: sin efecto sobre filas existentes; nada la escribe hasta una HU de administración.
ALTER TABLE "usuarios" ADD COLUMN "suspendida_en" TIMESTAMPTZ(3);

-- Rol de la API: crea y consulta. La billetera no se modifica ni se borra.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uniride_app') THEN
    REVOKE ALL ON "billeteras" FROM uniride_app;
    GRANT SELECT, INSERT ON "billeteras" TO uniride_app;
  END IF;
END $$;
