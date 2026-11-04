import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { loadInventoryConfig } from '../config/inventory.config.js';
import { OutboxPublisherService } from '../outbox/outbox-publisher.service.js';
import { ReservationExpirationService } from '../reservations/reservation-expiration.service.js';
import { SanitizedLogger } from '../logging/sanitized-logger.js';

@Injectable()
export class InventoryWorkersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new SanitizedLogger(
    new Logger(InventoryWorkersService.name),
  );
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopping = false;
  private readonly metrics = {
    cycles: 0,
    expirationFailures: 0,
    outboxFailures: 0,
    lastDurationMs: 0,
  };

  getMetrics() {
    return { ...this.metrics, running: this.running, stopping: this.stopping };
  }

  constructor(
    private readonly expiration: ReservationExpirationService,
    private readonly outbox: OutboxPublisherService,
  ) {}

  onModuleInit(): void {
    const config = loadInventoryConfig();
    this.timer = setInterval(
      () => void this.runOnce(config.workerBatchSize),
      config.workerIntervalMs,
    );
    this.timer.unref();
    void this.runOnce(config.workerBatchSize);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private async runOnce(batchSize: number): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    const startedAt = Date.now();
    this.metrics.cycles++;
    try {
      try {
        const result = await this.expiration.expirarReservasVencidas(batchSize);
        this.metrics.expirationFailures += result.fallidas;
      } catch (error) {
        this.metrics.expirationFailures++;
        this.logger.error({
          event: 'inventory.worker.expiration_failed',
          error,
        });
      }
      try {
        const result = await this.outbox.dispatchPending(batchSize);
        this.metrics.outboxFailures +=
          result.failed +
          (result.reason && result.reason !== 'NOT_CONFIGURED' ? 1 : 0);
      } catch (error) {
        this.metrics.outboxFailures++;
        this.logger.error({ event: 'inventory.worker.outbox_failed', error });
      }
    } finally {
      this.metrics.lastDurationMs = Date.now() - startedAt;
      this.running = false;
    }
  }
}
