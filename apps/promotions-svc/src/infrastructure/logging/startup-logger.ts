import { PromotionsConfigurationError } from '../config/promotions-config.js';

export class PromotionsStartupLogger {
  constructor(
    private readonly write: (line: string) => void = (line) => {
      process.stdout.write(`${line}\n`);
    },
  ) {}

  runtimeStopped(): void {
    this.operational('COUPON_CONSUMER_STOPPED');
  }

  outboxPending(): void {
    this.operational('COUPON_OUTBOX_PENDING');
  }

  private operational(
    code: 'COUPON_CONSUMER_STOPPED' | 'COUPON_OUTBOX_PENDING',
  ): void {
    this.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        service: 'promotions-svc',
        code,
      }),
    );
  }

  started(): void {
    this.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        service: 'promotions-svc',
        code: 'APPLICATION_STARTED',
      }),
    );
  }

  failed(error: unknown): void {
    // Never serialize raw exceptions, stacks, configuration or request values.
    this.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        service: 'promotions-svc',
        code:
          error instanceof PromotionsConfigurationError
            ? 'CONFIGURATION_INVALID'
            : 'APPLICATION_START_FAILED',
        ...(error instanceof PromotionsConfigurationError
          ? { variables: error.variables }
          : {}),
      }),
    );
  }
}
