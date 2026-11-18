-- HU-21: calificación mutua. Solo agrega: una tabla con RLS y una función de lectura del promedio público.

-- Una calificación no se edita ni se borra (RN-5): el rol de la API solo inserta y lee. Una por reserva y por autor (CA-3, CA-12).
CREATE TABLE "calificaciones" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizacion_id" UUID NOT NULL,
    "reserva_id" UUID NOT NULL,
    "autor_id" UUID NOT NULL,
    "destinatario_id" UUID NOT NULL,
    "estrellas" INTEGER NOT NULL,
    "comentario" TEXT,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "calificaciones_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "calificaciones_estrellas_chk" CHECK ("estrellas" BETWEEN 1 AND 5),
    CONSTRAINT "calificaciones_comentario_chk" CHECK ("comentario" IS NULL OR char_length("comentario") <= 140),
    CONSTRAINT "calificaciones_distintos_chk" CHECK ("autor_id" <> "destinatario_id")
);
CREATE UNIQUE INDEX "calificaciones_reserva_autor_key" ON "calificaciones"("reserva_id", "autor_id");
CREATE INDEX "calificaciones_destinatario_idx" ON "calificaciones"("destinatario_id");

ALTER TABLE "calificaciones" ADD CONSTRAINT "calificaciones_organizacion_id_fkey" FOREIGN KEY ("organizacion_id") REFERENCES "organizaciones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "calificaciones" ADD CONSTRAINT "calificaciones_reserva_id_fkey" FOREIGN KEY ("reserva_id") REFERENCES "reservas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "calificaciones" ADD CONSTRAINT "calificaciones_autor_id_fkey" FOREIGN KEY ("autor_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "calificaciones" ADD CONSTRAINT "calificaciones_destinatario_id_fkey" FOREIGN KEY ("destinatario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Sin FORCE a propósito: la función de abajo la lee como dueña de la tabla (el rol de la API sí queda sujeto a la política).
ALTER TABLE "calificaciones" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "calificaciones_aislamiento" ON "calificaciones" USING (
  "organizacion_id" = nullif(current_setting('app.organizacion_id', true), '')::uuid
  OR current_setting('app.super_admin', true) = 'true'
);

-- Promedio público de una persona en todas sus organizaciones (RN-4, CA-6, CA-11): devuelve solo agregados, nunca autor ni comentario.
-- Excluye a los pares con bloqueo de HU-25 vigente o existente en los 7 días previos al pago (RN-7, CA-10). Con `search_path` fijo.
CREATE FUNCTION "promedio_calificacion"(p_usuario UUID)
RETURNS TABLE ("promedio" NUMERIC, "cantidad" INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT round(avg(c."estrellas")::numeric, 1), count(*)::int
  FROM "calificaciones" c
  JOIN LATERAL (
    SELECT min(m."creado_en") AS pagada_en FROM "movimientos_billetera" m
    WHERE m."reserva_id" = c."reserva_id" AND m."tipo" = 'liberacion_viaje') p ON true
  WHERE c."destinatario_id" = p_usuario
    AND NOT EXISTS (
      SELECT 1 FROM "bloqueos_preventivos" b
      WHERE b."tipo" = 'par'
        AND b."usuario_id" = least(c."autor_id", c."destinatario_id")
        AND b."usuario_par_id" = greatest(c."autor_id", c."destinatario_id")
        AND b."vence_en" > coalesce(p.pagada_en, c."creado_en") - interval '7 days')
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uniride_app') THEN
    REVOKE ALL ON "calificaciones" FROM uniride_app;
    GRANT SELECT, INSERT ON "calificaciones" TO uniride_app;
    REVOKE ALL ON FUNCTION "promedio_calificacion"(UUID) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION "promedio_calificacion"(UUID) TO uniride_app;
  END IF;
END $$;
