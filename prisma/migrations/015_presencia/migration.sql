-- HU-22: verificación de abordaje. Datos institucionales: llevan organizacion_id y RLS (A-13). No borra ni transforma datos.

-- D-22: llave de trayecto (sin biometría) del conductor (reserva_id nulo) o del pasajero. Vale para un viaje y su dispositivo.
CREATE TABLE "llaves_trayecto" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizacion_id" UUID NOT NULL,
    "viaje_id" UUID NOT NULL,
    "reserva_id" UUID,
    "usuario_id" UUID NOT NULL,
    "dispositivo_id" UUID NOT NULL,
    "llave_publica" TEXT NOT NULL,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revocada_en" TIMESTAMPTZ(3),
    CONSTRAINT "llaves_trayecto_pkey" PRIMARY KEY ("id")
);
-- Una llave vigente por persona y viaje: registrar otra revoca la anterior.
CREATE UNIQUE INDEX "llaves_trayecto_viaje_usuario_vigente_key" ON "llaves_trayecto"("viaje_id", "usuario_id") WHERE "revocada_en" IS NULL;

-- RN-1: código de un solo uso y 30 s de vida. Es del viaje: sirve a cualquier pasajero, una vez.
CREATE TABLE "desafios_handshake" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizacion_id" UUID NOT NULL,
    "viaje_id" UUID NOT NULL,
    "tipo" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "conductor_lat" DOUBLE PRECISION NOT NULL,
    "conductor_lng" DOUBLE PRECISION NOT NULL,
    "conductor_precision_m" DOUBLE PRECISION NOT NULL,
    "conductor_tomada_en" TIMESTAMPTZ(3) NOT NULL,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vence_en" TIMESTAMPTZ(3) NOT NULL,
    "usado_en" TIMESTAMPTZ(3),
    "reserva_id" UUID,
    CONSTRAINT "desafios_handshake_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "desafios_handshake_tipo_chk" CHECK ("tipo" IN ('abordaje', 'bajada'))
);
CREATE UNIQUE INDEX "desafios_handshake_nonce_key" ON "desafios_handshake"("nonce");

-- CA-13: cada intento con reserva propia, aceptado o rechazado. Las posiciones solo sirven para verificar.
CREATE TABLE "pruebas_presencia" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizacion_id" UUID NOT NULL,
    "reserva_id" UUID NOT NULL,
    -- Nulo si el código no existía o ya no servía: no hay desafío que citar.
    "desafio_id" UUID,
    "tipo" TEXT NOT NULL,
    "pasajero_lat" DOUBLE PRECISION,
    "pasajero_lng" DOUBLE PRECISION,
    "pasajero_precision_m" DOUBLE PRECISION,
    "distancia_m" DOUBLE PRECISION,
    "veredicto_integridad" TEXT,
    "resultado" TEXT NOT NULL,
    "motivo" TEXT,
    "hash_prueba" TEXT,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pruebas_presencia_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pruebas_presencia_tipo_chk" CHECK ("tipo" IN ('abordaje', 'bajada')),
    CONSTRAINT "pruebas_presencia_resultado_chk" CHECK ("resultado" IN ('aceptada', 'rechazada')),
    CONSTRAINT "pruebas_presencia_aceptada_chk" CHECK ("resultado" = 'rechazada' OR "hash_prueba" IS NOT NULL)
);
-- CA-14: una sola prueba aceptada por reserva y tipo.
CREATE UNIQUE INDEX "pruebas_presencia_reserva_tipo_aceptada_key" ON "pruebas_presencia"("reserva_id", "tipo") WHERE "resultado" = 'aceptada';

ALTER TABLE "llaves_trayecto" ADD CONSTRAINT "llaves_trayecto_organizacion_id_fkey" FOREIGN KEY ("organizacion_id") REFERENCES "organizaciones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "llaves_trayecto" ADD CONSTRAINT "llaves_trayecto_viaje_id_fkey" FOREIGN KEY ("viaje_id") REFERENCES "viajes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "llaves_trayecto" ADD CONSTRAINT "llaves_trayecto_reserva_id_fkey" FOREIGN KEY ("reserva_id") REFERENCES "reservas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "llaves_trayecto" ADD CONSTRAINT "llaves_trayecto_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "llaves_trayecto" ADD CONSTRAINT "llaves_trayecto_dispositivo_id_fkey" FOREIGN KEY ("dispositivo_id") REFERENCES "dispositivos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "desafios_handshake" ADD CONSTRAINT "desafios_handshake_organizacion_id_fkey" FOREIGN KEY ("organizacion_id") REFERENCES "organizaciones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "desafios_handshake" ADD CONSTRAINT "desafios_handshake_viaje_id_fkey" FOREIGN KEY ("viaje_id") REFERENCES "viajes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "desafios_handshake" ADD CONSTRAINT "desafios_handshake_reserva_id_fkey" FOREIGN KEY ("reserva_id") REFERENCES "reservas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pruebas_presencia" ADD CONSTRAINT "pruebas_presencia_organizacion_id_fkey" FOREIGN KEY ("organizacion_id") REFERENCES "organizaciones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pruebas_presencia" ADD CONSTRAINT "pruebas_presencia_reserva_id_fkey" FOREIGN KEY ("reserva_id") REFERENCES "reservas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pruebas_presencia" ADD CONSTRAINT "pruebas_presencia_desafio_id_fkey" FOREIGN KEY ("desafio_id") REFERENCES "desafios_handshake"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "llaves_trayecto" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "llaves_trayecto" FORCE ROW LEVEL SECURITY;
CREATE POLICY "llaves_trayecto_aislamiento" ON "llaves_trayecto" USING (
  "organizacion_id" = nullif(current_setting('app.organizacion_id', true), '')::uuid
  OR current_setting('app.super_admin', true) = 'true'
);
ALTER TABLE "desafios_handshake" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "desafios_handshake" FORCE ROW LEVEL SECURITY;
CREATE POLICY "desafios_handshake_aislamiento" ON "desafios_handshake" USING (
  "organizacion_id" = nullif(current_setting('app.organizacion_id', true), '')::uuid
  OR current_setting('app.super_admin', true) = 'true'
);
ALTER TABLE "pruebas_presencia" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pruebas_presencia" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pruebas_presencia_aislamiento" ON "pruebas_presencia" USING (
  "organizacion_id" = nullif(current_setting('app.organizacion_id', true), '')::uuid
  OR current_setting('app.super_admin', true) = 'true'
);

-- Rol de la API: sin DELETE. De una llave solo se marca la revocación; de un desafío, su uso; una prueba no cambia.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uniride_app') THEN
    REVOKE ALL ON "llaves_trayecto", "desafios_handshake", "pruebas_presencia" FROM uniride_app;
    GRANT SELECT, INSERT ON "llaves_trayecto", "desafios_handshake", "pruebas_presencia" TO uniride_app;
    GRANT UPDATE ("revocada_en") ON "llaves_trayecto" TO uniride_app;
    GRANT UPDATE ("usado_en", "reserva_id") ON "desafios_handshake" TO uniride_app;
  END IF;
END $$;
