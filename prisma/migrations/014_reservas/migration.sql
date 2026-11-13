-- HU-19: reserva de un asiento con el pasaje en garantía. Dato institucional: lleva organizacion_id y RLS (A-13).
-- No borra ni transforma datos.

CREATE TABLE "reservas" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizacion_id" UUID NOT NULL,
    "viaje_id" UUID NOT NULL,
    "pasajero_id" UUID NOT NULL,
    -- RN-2: el precio publicado del viaje, fijado por el servidor.
    "monto" NUMERIC(12,2) NOT NULL,
    -- RN-10 (D-23). HU-20 agrega `cancelada` y `expirada`.
    "estado" TEXT NOT NULL DEFAULT 'pendiente',
    -- CA-4: una petición repetida devuelve la reserva original.
    "clave_idempotencia" TEXT NOT NULL,
    "motivo" TEXT,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reservas_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reservas_monto_chk" CHECK ("monto" > 0),
    CONSTRAINT "reservas_estado_chk" CHECK ("estado" IN ('pendiente', 'confirmada', 'abordada', 'verificada', 'pagada', 'fallida', 'verificacion_fallida'))
);

CREATE UNIQUE INDEX "reservas_clave_idempotencia_key" ON "reservas"("clave_idempotencia");
-- RN-1 y CA-10: una reserva activa por pasajero y viaje. Una que no se completó no cuenta.
CREATE UNIQUE INDEX "reservas_viaje_pasajero_activa_key" ON "reservas"("viaje_id", "pasajero_id") WHERE "estado" <> 'fallida';
CREATE INDEX "reservas_viaje_id_estado_idx" ON "reservas"("viaje_id", "estado");
CREATE INDEX "reservas_pasajero_id_creado_en_idx" ON "reservas"("pasajero_id", "creado_en" DESC);

ALTER TABLE "reservas" ADD CONSTRAINT "reservas_organizacion_id_fkey" FOREIGN KEY ("organizacion_id") REFERENCES "organizaciones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reservas" ADD CONSTRAINT "reservas_viaje_id_fkey" FOREIGN KEY ("viaje_id") REFERENCES "viajes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reservas" ADD CONSTRAINT "reservas_pasajero_id_fkey" FOREIGN KEY ("pasajero_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reservas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reservas" FORCE ROW LEVEL SECURITY;
CREATE POLICY "reservas_aislamiento" ON "reservas" USING (
  "organizacion_id" = nullif(current_setting('app.organizacion_id', true), '')::uuid
  OR current_setting('app.super_admin', true) = 'true'
);

-- El libro ya guardaba `reserva_id` (HU-14); ahora apunta a una reserva real. Falla si hubiera filas huérfanas (solo datos de prueba).
ALTER TABLE "movimientos_billetera" ADD CONSTRAINT "movimientos_billetera_reserva_id_fkey" FOREIGN KEY ("reserva_id") REFERENCES "reservas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- La cola on-chain gana el bloqueo de la reserva (D-10).
ALTER TABLE "trabajos_onchain" DROP CONSTRAINT "trabajos_onchain_operacion_chk";
ALTER TABLE "trabajos_onchain" ADD CONSTRAINT "trabajos_onchain_operacion_chk" CHECK ("operacion" IN ('acunar_recarga', 'bloquear_reserva'));

-- Rol de la API: sin DELETE. De una reserva solo avanzan su estado y su motivo; del viaje, sus cupos y su estado derivado (D-23).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uniride_app') THEN
    REVOKE ALL ON "reservas" FROM uniride_app;
    GRANT SELECT, INSERT ON "reservas" TO uniride_app;
    GRANT UPDATE ("estado", "motivo", "actualizado_en") ON "reservas" TO uniride_app;
    GRANT UPDATE ("cupos_disponibles", "estado") ON "viajes" TO uniride_app;
  END IF;
END $$;
