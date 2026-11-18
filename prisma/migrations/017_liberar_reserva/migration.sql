-- HU-24: la cola on-chain también libera el pago de una reserva verificada.
ALTER TABLE "trabajos_onchain" DROP CONSTRAINT "trabajos_onchain_operacion_chk";
ALTER TABLE "trabajos_onchain" ADD CONSTRAINT "trabajos_onchain_operacion_chk" CHECK ("operacion" IN ('acunar_recarga', 'bloquear_reserva', 'liberar_reserva'));
