import type { IdentidadBaja } from './deactivation-check.js';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { DeactivationIntentService } from './deactivation-intent.service.js';

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

/** Inicia solo tras verificar la identidad de DB; nunca solapa ejecuciones. */
@Injectable()
export class DeactivationRecoveryRunner implements OnModuleDestroy {
  private readonly logger = new Logger(DeactivationRecoveryRunner.name);
  private timer?: ReturnType<typeof setInterval>;
  private enCurso?: Promise<void>;
  private cerrado = false;
  constructor(private readonly intentos: DeactivationIntentService) {}

  ejecutarUnaVez(): Promise<number> {
    return this.intentos.recuperarVencidas();
  }

  iniciar(): void {
    if (this.timer || this.cerrado) return;
    this.timer = setInterval(() => {
      if (this.enCurso || this.cerrado) return;
      this.enCurso = this.ejecutarUnaVez()
        .then(() => undefined)
        .catch(() =>
          this.logger.error({
            event: 'taxonomy.deactivation.recovery_failed',
            service: 'taxonomy-svc',
            component: 'deactivation_recovery',
            state: 'failed',
            reason: 'PERSISTENCE_OR_CONFIGURATION_FAILURE',
          }),
        )
        .finally(() => {
          this.enCurso = undefined;
        });
    }, 10_000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.cerrado = true;
    if (this.timer) clearInterval(this.timer);
    await this.enCurso;
  }
}
