import type { CouponOutbox } from './coupon-outbox.js';

// Reuses the transactional publisher, including its confirm/locking semantics.
// This poll does not define message retry/DLX policy or mutate broker topology.
export class CouponOutboxPump {
  private running = false;
  private task?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly outbox: Pick<CouponOutbox, 'publishOne'>,
    private readonly failed: () => void,
  ) {}

  start(): void {
    if (this.running) throw new Error('COUPON_OUTBOX_PUMP_ALREADY_STARTED');
    this.running = true;
    this.task = this.run();
  }

  private async run(): Promise<void> {
    let pendingReported = false;
    while (this.running) {
      let outcome: 'empty' | 'published' | 'pending' = 'pending';
      try {
        outcome = await this.outbox.publishOne();
      } catch {
        // Both a transaction failure and a missing broker confirm leave work pending.
      }
      if (!this.running) break;
      if (outcome === 'pending' && !pendingReported) {
        pendingReported = true;
        try {
          this.failed();
        } catch {
          /* Observer cannot stop recovery. */
        }
      }
      if (outcome !== 'pending') pendingReported = false;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.wake = undefined;
          resolve();
        };
        const timer = setTimeout(done, outcome === 'published' ? 0 : 250);
        this.wake = done;
      });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.task;
  }
}
