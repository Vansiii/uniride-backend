-- HU-20: cancelación con reembolso y expiración de reservas y viajes.
-- No borra ni transforma datos.

-- Estados nuevos de la reserva (D-23): cancelada y expirada.
ALTER TABLE "reservas" DROP CONSTRAINT "reservas_estado_chk";
ALTER TABLE "reservas" ADD CONSTRAINT "reservas_estado_chk" CHECK ("estado" IN ('pendiente', 'confirmada', 'abordada', 'verificada', 'pagada', 'fallida', 'verificacion_fallida', 'cancelada', 'expirada'));

-- El pasajero puede volver a reservar si canceló o su reserva previa expiró (RN-1, CA-2).
DROP INDEX "reservas_viaje_pasajero_activa_key";
CREATE UNIQUE INDEX "reservas_viaje_pasajero_activa_key" ON "reservas"("viaje_id", "pasajero_id") WHERE "estado" NOT IN ('fallida', 'cancelada', 'expirada');

-- Tipo de movimiento para la compensación del 50 % al conductor si el pasajero cancela tarde (D-18).
ALTER TABLE "movimientos_billetera" DROP CONSTRAINT "movimientos_billetera_tipo_chk";
ALTER TABLE "movimientos_billetera" ADD CONSTRAINT "movimientos_billetera_tipo_chk" CHECK ("tipo" IN ('recarga', 'bloqueo_reserva', 'liberacion_viaje', 'reembolso_reserva', 'compensacion_cancelacion'));

-- Operación de reembolso en la cola on-chain (reembolsar_reserva).
ALTER TABLE "trabajos_onchain" DROP CONSTRAINT "trabajos_onchain_operacion_chk";
ALTER TABLE "trabajos_onchain" ADD CONSTRAINT "trabajos_onchain_operacion_chk" CHECK ("operacion" IN ('acunar_recarga', 'bloquear_reserva', 'liberar_reserva', 'reembolsar_reserva'));
