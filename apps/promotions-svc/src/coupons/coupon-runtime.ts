import type { CouponCommandDeliveryHandler } from './coupon-amqp.js';
import {
  CouponCommandConsumer,
  type ConsumerChannelPort,
  type CouponConsumerBoundary,
} from './coupon-consumer.js';
import type { CouponOutboxPump } from './coupon-outbox-pump.js';

export const COUPON_RUNTIME_BOUNDARY = Symbol('COUPON_RUNTIME_BOUNDARY');

export interface CouponRuntimeBoundary extends CouponConsumerBoundary {
  // Must verify evidence/eligibility adapters, all assigned-event handlers and
  // authenticated broker identity/ACL before opening a consumer channel.
  assertReady(): Promise<void>;
}

export class CouponRuntime {
  private consumer?: CouponCommandConsumer;
  private started = false;

  constructor(
    private readonly enabled: boolean,
    private readonly boundary: CouponRuntimeBoundary,
    private readonly openChannel: () => Promise<ConsumerChannelPort>,
    private readonly handler: CouponCommandDeliveryHandler,
    private readonly pump: CouponOutboxPump,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    if (this.started) throw new Error('COUPON_RUNTIME_ALREADY_STARTED');
    await this.boundary.assertReady();
    this.started = true;
    const channel = await this.openChannel();
    let failed = false;
    this.consumer = new CouponCommandConsumer(channel, this.handler, {
      authenticatedActor: (delivery) =>
        this.boundary.authenticatedActor(delivery),
      handleOtherAssignedEvent: (delivery) =>
        this.boundary.handleOtherAssignedEvent(delivery),
      failed: (code) => {
        failed = true;
        void this.pump.stop();
        this.boundary.failed(code);
      },
    });
    try {
      await this.consumer.start();
      if (failed) throw new Error('COUPON_RUNTIME_START_FAILED');
      this.pump.start();
    } catch {
      await this.consumer.stop();
      throw new Error('COUPON_RUNTIME_START_FAILED');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.stop();
    await this.pump.stop();
  }
}
