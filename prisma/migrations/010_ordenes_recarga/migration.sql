-- HU-13: órdenes de recarga (dato personal, D-07: sin organizacion_id ni RLS, se protege por dueño en la API),
-- cola on-chain (interna, D-10) y `fallido` como estado final del libro mayor. No borra ni transforma datos.

CREATE TABLE "ordenes_recarga" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "usuario_id" UUID NOT NULL,
    "billetera_id" UUID NOT NULL,
    "monto" NUMERIC(12,2) NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'pendiente',
    "hash_tx" TEXT,
    "expira_en" TIMESTAMPTZ(3) NOT NULL,
    "completada_en" TIMESTAMPTZ(3),
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ordenes_recarga_pkey" PRIMARY KEY ("id"),
    -- RN-1
    CONSTRAINT "ordenes_recarga_monto_chk" CHECK ("monto" BETWEEN 10 AND 500),
    CONSTRAINT "ordenes_recarga_estado_chk" CHECK ("estado" IN ('pendiente', 'procesando', 'completada', 'expirada')),
    CONSTRAINT "ordenes_recarga_hash_chk" CHECK ("hash_tx" IS NULL OR "hash_tx" ~ '^0x[0-9a-fA-F]{64}$'),
    CONSTRAINT "ordenes_recarga_completada_chk" CHECK ("estado" <> 'completada' OR ("hash_tx" IS NOT NULL AND "completada_en" IS NOT NULL))
);
CREATE INDEX "ordenes_recarga_usuario_id_expira_en_idx" ON "ordenes_recarga"("usuario_id", "expira_en");

ALTER TABLE "ordenes_recarga" ADD CONSTRAINT "ordenes_recarga_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ordenes_recarga" ADD CONSTRAINT "ordenes_recarga_billetera_id_fkey" FOREIGN KEY ("billetera_id") REFERENCES "billeteras"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "trabajos_onchain" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "movimiento_id" UUID NOT NULL,
    "operacion" TEXT NOT NULL,
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "proximo_intento_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimo_error" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'pendiente',
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trabajos_onchain_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "trabajos_onchain_operacion_chk" CHECK ("operacion" IN ('acunar_recarga')),
    CONSTRAINT "trabajos_onchain_estado_chk" CHECK ("estado" IN ('pendiente', 'terminado'))
);
CREATE UNIQUE INDEX "trabajos_onchain_movimiento_id_key" ON "trabajos_onchain"("movimiento_id");
CREATE INDEX "trabajos_onchain_estado_proximo_intento_en_idx" ON "trabajos_onchain"("estado", "proximo_intento_en");

ALTER TABLE "trabajos_onchain" ADD CONSTRAINT "trabajos_onchain_movimiento_id_fkey" FOREIGN KEY ("movimiento_id") REFERENCES "movimientos_billetera"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- `fallido` es final: un reintento con otra clave contaría doble si pudiera volver a confirmarse.
CREATE OR REPLACE FUNCTION "movimientos_billetera_solo_estado"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'estado' - 'hash_tx') IS DISTINCT FROM (to_jsonb(OLD) - 'estado' - 'hash_tx') THEN
    RAISE EXCEPTION 'movimientos_billetera es de solo inserción: solo cambian estado y hash_tx';
  END IF;
  IF OLD."estado" = 'confirmado' AND (NEW."estado", NEW."hash_tx") IS DISTINCT FROM (OLD."estado", OLD."hash_tx") THEN
    RAISE EXCEPTION 'un movimiento confirmado no cambia: una corrección es un movimiento nuevo';
  END IF;
  IF OLD."estado" = 'fallido' AND (NEW."estado", NEW."hash_tx") IS DISTINCT FROM (OLD."estado", OLD."hash_tx") THEN
    RAISE EXCEPTION 'un movimiento fallido no cambia: un reintento es un movimiento nuevo';
  END IF;
  RETURN NEW;
END $$;

-- Rol de la API: sin DELETE; de una orden escrita solo avanza el estado.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uniride_app') THEN
    REVOKE ALL ON "ordenes_recarga", "trabajos_onchain" FROM uniride_app;
    GRANT SELECT, INSERT ON "ordenes_recarga" TO uniride_app;
    GRANT UPDATE ("estado", "hash_tx", "completada_en") ON "ordenes_recarga" TO uniride_app;
    GRANT SELECT, INSERT ON "trabajos_onchain" TO uniride_app;
    GRANT UPDATE ("intentos", "proximo_intento_en", "ultimo_error", "estado") ON "trabajos_onchain" TO uniride_app;
  END IF;
END $$;
