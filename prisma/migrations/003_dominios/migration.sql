-- HU-02: dominios de correo de cada organización (reglas de afiliación), con RLS (A-13).

CREATE TABLE "dominios_organizacion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizacion_id" UUID NOT NULL,
    "dominio" TEXT NOT NULL,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dominios_organizacion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dominios_organizacion_minusculas_chk" CHECK ("dominio" = lower("dominio") AND position('@' IN "dominio") = 0)
);
-- RN-2: un dominio pertenece a una sola organización en toda la plataforma.
CREATE UNIQUE INDEX "dominios_organizacion_dominio_key" ON "dominios_organizacion"("dominio");
CREATE INDEX "dominios_organizacion_organizacion_id_idx" ON "dominios_organizacion"("organizacion_id");

ALTER TABLE "dominios_organizacion" ADD CONSTRAINT "dominios_organizacion_organizacion_id_fkey" FOREIGN KEY ("organizacion_id") REFERENCES "organizaciones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dominios_organizacion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dominios_organizacion" FORCE ROW LEVEL SECURITY;
CREATE POLICY "dominios_organizacion_aislamiento" ON "dominios_organizacion" USING (
  "organizacion_id" = nullif(current_setting('app.organizacion_id', true), '')::uuid
  OR current_setting('app.super_admin', true) = 'true'
);

-- Registro (HU-05, HU-07): sin organización todavía, se averigua la dueña del dominio sin abrir RLS al llamador.
-- Devuelve solo el id de una organización activa. El SET vale solo dentro de la función y no llega a la transacción que la llama.
CREATE FUNCTION "organizacion_por_dominio"(p_dominio TEXT) RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
SET app.super_admin = 'true'
AS $$
  SELECT d."organizacion_id"
  FROM "dominios_organizacion" d
  JOIN "organizaciones" o ON o."id" = d."organizacion_id"
  WHERE d."dominio" = lower(trim(p_dominio)) AND o."estado" = 'activa'
$$;
REVOKE ALL ON FUNCTION "organizacion_por_dominio"(TEXT) FROM PUBLIC;

-- Rol de la API: quitar un dominio es borrar su fila (la auditoría guarda el valor anterior, CA-8).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uniride_app') THEN
    REVOKE ALL ON "dominios_organizacion" FROM uniride_app;
    GRANT SELECT, INSERT, DELETE ON "dominios_organizacion" TO uniride_app;
    GRANT EXECUTE ON FUNCTION "organizacion_por_dominio"(TEXT) TO uniride_app;
  END IF;
END $$;
