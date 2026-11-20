-- PB-09: notificaciones push (FCM). Solo agrega: una columna y una cola.

-- Token FCM del teléfono con sesión. Dato personal (D-07): se protege por dueño, sin RLS. Un token es de un solo
-- usuario: si otra cuenta inicia sesión en el mismo teléfono, el token pasa a ella (lo hace la API).
ALTER TABLE "usuarios" ADD COLUMN "token_push" TEXT;
CREATE UNIQUE INDEX "usuarios_token_push_key" ON "usuarios"("token_push");

-- Cola de avisos, como `correos_salientes`: se encola en la transacción del evento y un worker envía con reintentos.
-- El token se lee al enviar (no se copia aquí), para que un cierre de sesión corte los avisos pendientes.
CREATE TABLE "notificaciones_push" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "usuario_id" UUID NOT NULL,
    "plantilla" TEXT NOT NULL,
    "datos" JSONB NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'pendiente',
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "proximo_intento_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimo_error" TEXT,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notificaciones_push_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notificaciones_push_estado_chk" CHECK ("estado" IN ('pendiente', 'enviado', 'fallido', 'sin_token'))
);
CREATE INDEX "notificaciones_push_estado_proximo_idx" ON "notificaciones_push"("estado", "proximo_intento_en");
ALTER TABLE "notificaciones_push" ADD CONSTRAINT "notificaciones_push_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uniride_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "notificaciones_push" TO uniride_app;
  END IF;
END $$;
