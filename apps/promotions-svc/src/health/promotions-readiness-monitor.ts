import { Inject, Injectable } from '@nestjs/common';
import { PromotionsConfigService } from '../infrastructure/config/promotions-config.js';
import {
  PROMOTIONS_OPERATION_LOGGER,
  PromotionsOperationLogger,
} from '../infrastructure/logging/operation-logger.js';
import { PromotionsReadinessService } from './promotions-readiness.service.js';

// Opt-in internal monitoring only. /health remains liveness; no new HTTP route
// is published until the Architecture/OpenAPI readiness discrepancy is resolved.
@Injectable()
export class PromotionsReadinessMonitor {
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private last?: string;
  private task?: Promise<void>;
  constructor(
    @Inject(PromotionsConfigService)
    private readonly config: PromotionsConfigService,
    @Inject(PromotionsReadinessService)
    private readonly readiness: PromotionsReadinessService,
    @Inject(PROMOTIONS_OPERATION_LOGGER)
    private readonly logger: PromotionsOperationLogger,
  ) {}
  async onApplicationBootstrap(): Promise<void> {
    if (
      !this.config.settings.dependencyProbesEnabled ||
      this.stopped ||
      this.task
    )
      return;
    this.task = this.sample();
    await this.task;
  }
  private async sample(): Promise<void> {
    try {
      const state = await this.readiness.check(
        this.config.settings.couponRuntimeEnabled,
      );
      if (this.stopped) return;
      const snapshot = JSON.stringify(state);
      if (snapshot !== this.last) {
        this.logger.readiness(state);
        this.last = snapshot;
      }
    } catch {
      // An unexpected monitoring failure must not become an unhandled rejection
      // or expose dependency diagnostics. Ordinary probe failures resolve down.
      if (!this.stopped) {
        const failed = {
          status: 'not_ready' as const,
          service: 'promotions-svc' as const,
          dependencies: { database: 'down' as const, broker: 'down' as const },
        };
        const snapshot = JSON.stringify(failed);
        if (snapshot !== this.last) this.logger.readiness(failed);
        this.last = snapshot;
      }
    } finally {
      if (!this.stopped) {
        this.timer = setTimeout(() => {
          this.task = this.sample();
        }, 5000);
        this.timer.unref();
      }
    }
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.readiness.beforeApplicationShutdown();
    await this.task;
  }
}
