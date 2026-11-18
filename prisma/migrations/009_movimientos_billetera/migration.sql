-- HU-14: libro mayor de la billetera (RN-1). Dato personal (D-07): sin organizacion_id ni RLS, se protege por dueño en la API.
-- Solo inserción: de una fila ya escrita solo cambian `estado` y `hash_tx` (trigger y GRANT), y la API no tiene DELETE (A-09).
-- Lo confirmado queda congelado: una corrección posterior es un movimiento nuevo.

CREATE TABLE "movimientos_billetera" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "billetera_id" UUID NOT NULL,
    "tipo" TEXT NOT NULL,
    "monto" NUMERIC(12,2) NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'pendiente',
    -- Su llave foránea llega con HU-19.
    "reserva_id" UUID,
    "hash_tx" TEXT,
    "clave_idempotencia" TEXT NOT NULL,
    "metadatos" JSONB,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "movimientos_billetera_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "movimientos_billetera_monto_chk" CHECK ("monto" > 0),
    CONSTRAINT "movimientos_billetera_tipo_chk" CHECK ("tipo" IN ('recarga', 'bloqueo_reserva', 'liberacion_viaje', 'reembolso_reserva')),
    CONSTRAINT "movimientos_billetera_estado_chk" CHECK ("estado" IN ('pendiente', 'confirmado', 'fallido')),
    CONSTRAINT "movimientos_billetera_hash_chk" CHECK ("hash_tx" IS NULL OR "hash_tx" ~ '^0x[0-9a-fA-F]{64}$'),
    -- RN-3: lo confirmado tiene su transacción pública.
    CONSTRAINT "movimientos_billetera_confirmado_chk" CHECK ("estado" <> 'confirmado' OR "hash_tx" IS NOT NULL),
    -- Un bloqueo sin reserva nunca se podría resolver y dejaría el saldo retenido para siempre.
    CONSTRAINT "movimientos_billetera_reserva_chk" CHECK ("tipo" = 'recarga' OR "reserva_id" IS NOT NULL)
);
-- Art. 4.2 / A-09: una operación de dinero no se registra dos veces.
CREATE UNIQUE INDEX "movimientos_billetera_clave_idempotencia_key" ON "movimientos_billetera"("clave_idempotencia");
CREATE INDEX "movimientos_billetera_billetera_id_creado_en_idx" ON "movimientos_billetera"("billetera_id", "creado_en" DESC);
-- El bloqueo se resuelve con movimientos de la misma reserva, también en la billetera del conductor.
CREATE INDEX "movimientos_billetera_reserva_id_idx" ON "movimientos_billetera"("reserva_id");

ALTER TABLE "movimientos_billetera" ADD CONSTRAINT "movimientos_billetera_billetera_id_fkey" FOREIGN KEY ("billetera_id") REFERENCES "billeteras"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- También frena al rol dueño, al que el GRANT de abajo no limita.
CREATE FUNCTION "movimientos_billetera_solo_estado"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'estado' - 'hash_tx') IS DISTINCT FROM (to_jsonb(OLD) - 'estado' - 'hash_tx') THEN
    RAISE EXCEPTION 'movimientos_billetera es de solo inserción: solo cambian estado y hash_tx';
  END IF;
  IF OLD."estado" = 'confirmado' AND (NEW."estado", NEW."hash_tx") IS DISTINCT FROM (OLD."estado", OLD."hash_tx") THEN
    RAISE EXCEPTION 'un movimiento confirmado no cambia: una corrección es un movimiento nuevo';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "movimientos_billetera_inmutable"
BEFORE UPDATE ON "movimientos_billetera"
FOR EACH ROW EXECUTE FUNCTION "movimientos_billetera_solo_estado"();

-- Rol de la API: inserta, consulta y actualiza solo el avance de la transacción. Sin DELETE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uniride_app') THEN
    REVOKE ALL ON "movimientos_billetera" FROM uniride_app;
    GRANT SELECT, INSERT ON "movimientos_billetera" TO uniride_app;
    GRANT UPDATE ("estado", "hash_tx") ON "movimientos_billetera" TO uniride_app;
  END IF;
END $$;
