-- HU-18: búsqueda de viajes por organización, estado, ventana de salida y cupos. Empieza por las mismas columnas que el índice anterior, que ya no hace falta.
CREATE INDEX "idx_viajes_busqueda" ON "viajes"("organizacion_id", "estado", "fecha_hora_salida", "cupos_disponibles");
DROP INDEX "viajes_organizacion_id_estado_fecha_hora_salida_idx";
