
-- CreateTable
CREATE TABLE "usuarios" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "correo" TEXT NOT NULL,
    "hash_contrasena" TEXT NOT NULL,
    "nombre_completo" TEXT NOT NULL,
    "rol_plataforma" TEXT,
    "estado_identidad" TEXT NOT NULL DEFAULT 'no_verificada',
    "intentos_fallidos" INTEGER NOT NULL DEFAULT 0,
    "bloqueado_hasta" TIMESTAMPTZ(3),
    "ultima_organizacion_id" UUID,
    "consentimiento_datos_en" TIMESTAMPTZ(3),
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tokens_refresco" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "usuario_id" UUID NOT NULL,
    "hash_token" TEXT NOT NULL,
    "tipo_cliente" TEXT NOT NULL,
    "vence_en" TIMESTAMPTZ(3) NOT NULL,
    "sesion_vence_en" TIMESTAMPTZ(3) NOT NULL,
    "revocado_en" TIMESTAMPTZ(3),
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tokens_refresco_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registros_auditoria" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizacion_id" UUID,
    "actor_id" UUID,
    "accion" TEXT NOT NULL,
    "entidad" TEXT NOT NULL,
    "entidad_id" TEXT,
    "resultado" TEXT NOT NULL,
    "detalle" JSONB,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registros_auditoria_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tokens_refresco_hash_token_key" ON "tokens_refresco"("hash_token");

-- CreateIndex
CREATE INDEX "tokens_refresco_usuario_id_idx" ON "tokens_refresco"("usuario_id");

-- CreateIndex
CREATE INDEX "registros_auditoria_organizacion_id_idx" ON "registros_auditoria"("organizacion_id");

-- AddForeignKey
ALTER TABLE "tokens_refresco" ADD CONSTRAINT "tokens_refresco_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Un correo por cuenta, sin distinguir mayúsculas
CREATE UNIQUE INDEX "usuarios_correo_minusculas_key" ON "usuarios"(lower("correo"));

-- Las tablas de datos personales (D-07) se protegen por dueño en la API, no con RLS.
-- La auditoría lleva organización: RLS (A-13). Las filas sin organización solo las ve el super admin.
ALTER TABLE "registros_auditoria" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "registros_auditoria" FORCE ROW LEVEL SECURITY;

CREATE POLICY "auditoria_lectura" ON "registros_auditoria" FOR SELECT USING (
  "organizacion_id" = nullif(current_setting('app.organizacion_id', true), '')::uuid
  OR current_setting('app.super_admin', true) = 'true'
);
-- Registrar es siempre válido (también eventos personales sin organización); leer no.
CREATE POLICY "auditoria_insercion" ON "registros_auditoria" FOR INSERT WITH CHECK (true);

-- Rol de la API (lo crea docker/postgres/01-rol-app.sh): sin borrado; auditoría solo inserción.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uniride_app') THEN
    REVOKE ALL ON "usuarios", "tokens_refresco", "registros_auditoria" FROM uniride_app;
    GRANT SELECT, INSERT, UPDATE ON "usuarios", "tokens_refresco" TO uniride_app;
    GRANT SELECT, INSERT ON "registros_auditoria" TO uniride_app;
  END IF;
END $$;
