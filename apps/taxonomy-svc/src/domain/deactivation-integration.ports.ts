import type { IdentidadBaja } from './deactivation-check.js';
import type { DeactivationIntentService } from './deactivation-intent.service.js';

/** Frontera pendiente: el transporte debe validar el envelope y deduplicar el message_id. */
export interface DeactivationCheckedConsumer {
  procesar(
    messageId: string,
    respuesta: IdentidadBaja & { result: unknown },
  ): Promise<void>;
}

/** Frontera pendiente: publicación real requiere topología y confirmaciones homologadas. */
export interface DeactivationOutboxPublisher {
  publicarPendientes(): Promise<void>;
}

/** Ejecución explícita; no instala temporizadores ni conexión a RabbitMQ. */
export class DeactivationRecoveryRunner {
  constructor(private readonly intentos: DeactivationIntentService) {}

  ejecutarUnaVez(): Promise<number> {
    return this.intentos.recuperarVencidas();
  }
}
