-- HU-01: organizaciones, membresías, invitaciones y cola de correos, con RLS (A-13).

CREATE TABLE "organizaciones" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "nombre" TEXT NOT NULL,
    "nombre_normalizado" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "modo_aprobacion" TEXT NOT NULL DEFAULT 'manual',
    "precio_maximo_urc" DECIMAL(12,2) NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'activa',
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organizaciones_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organizaciones_tipo_chk" CHECK ("tipo" IN ('universidad', 'empresa')),
    CONSTRAINT "organizaciones_precio_chk" CHECK ("precio_maximo_urc" > 0)
);
CREATE UNIQUE INDEX "organizaciones_nombre_normalizado_key" ON "organizaciones"("nombre_normalizado");

CREATE TABLE "membresias" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizacion_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "rol" TEXT NOT NULL,
    "estado" TEXT NOT NULL,
    "correo_institucional" TEXT,
    "decidido_por" UUID,
    "decidido_en" TIMESTAMPTZ(3),
    "motivo" TEXT,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "membresias_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "membresias_rol_chk" CHECK ("rol" IN ('miembro', 'admin_organizacion'))
);
CREATE UNIQUE INDEX "membresias_organizacion_id_usuario_id_key" ON "membresias"("organizacion_id", "usuario_id");
CREATE UNIQUE INDEX "membresias_correo_institucional_key" ON "membresias"(lower("correo_institucional"));

CREATE TABLE "invitaciones" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizacion_id" UUID NOT NULL,
    "correo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "hash_token" TEXT NOT NULL,
    "vence_en" TIMESTAMPTZ(3) NOT NULL,
    "usada_en" TIMESTAMPTZ(3),
    "reemplazada_en" TIMESTAMPTZ(3),
    "creado_por" UUID NOT NULL,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invitaciones_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invitaciones_hash_token_key" ON "invitaciones"("hash_token");
CREATE INDEX "invitaciones_organizacion_id_idx" ON "invitaciones"("organizacion_id");

CREATE TABLE "correos_salientes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "destinatario" TEXT NOT NULL,
    "plantilla" TEXT NOT NULL,
    "datos" JSONB NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'pendiente',
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "proximo_intento_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimo_error" TEXT,
    "referencia_tipo" TEXT,
    "referencia_id" UUID,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "correos_salientes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "correos_salientes_estado_proximo_intento_en_idx" ON "correos_salientes"("estado", "proximo_intento_en");
CREATE INDEX "correos_salientes_referencia_tipo_referencia_id_idx" ON "correos_salientes"("referencia_tipo", "referencia_id");

ALTER TABLE "membresias" ADD CONSTRAINT "membresias_organizacion_id_fkey" FOREIGN KEY ("organizacion_id") REFERENCES "organizaciones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membresias" ADD CONSTRAINT "membresias_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invitaciones" ADD CONSTRAINT "invitaciones_organizacion_id_fkey" FOREIGN KEY ("organizacion_id") REFERENCES "organizaciones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS (A-13): sin contexto la consulta devuelve 0 filas. `organizaciones` filtra por su propio id.
ALTER TABLE "organizaciones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizaciones" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organizaciones_aislamiento" ON "organizaciones" USING (
  "id" = nullif(current_setting('app.organizacion_id', true), '')::uuid
  OR current_setting('app.super_admin', true) = 'true'
);

ALTER TABLE "membresias" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membresias" FORCE ROW LEVEL SECURITY;
CREATE POLICY "membresias_aislamiento" ON "membresias" USING (
  "organizacion_id" = nullif(current_setting('app.organizacion_id', true), '')::uuid
  OR current_setting('app.super_admin', true) = 'true'
);

ALTER TABLE "invitaciones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitaciones" FORCE ROW LEVEL SECURITY;
CREATE POLICY "invitaciones_aislamiento" ON "invitaciones" USING (
  "organizacion_id" = nullif(current_setting('app.organizacion_id', true), '')::uuid
  OR current_setting('app.super_admin', true) = 'true'
);

-- Rol de la API: sin borrado.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uniride_app') THEN
    REVOKE ALL ON "organizaciones", "membresias", "invitaciones", "correos_salientes" FROM uniride_app;
    GRANT SELECT, INSERT, UPDATE ON "organizaciones", "membresias", "invitaciones", "correos_salientes" TO uniride_app;
  END IF;
END $$;
