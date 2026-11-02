import { consumptionName, restorationName } from './coupon-command.js';
import { setTimeout as delay } from 'node:timers/promises';
import { promotionsBrokerBinding } from './event-contract.generated.js';
import {
  CouponCommandDeliveryHandler,
  type CouponDelivery,
} from './coupon-amqp.js';

export interface BrokerDelivery extends CouponDelivery {
  properties: CouponDelivery['properties'] & { userId?: string };
}
export interface ConsumerChannelPort {
  on?(event: 'close' | 'error', listener: () => void): unknown;
  prefetch(count: number): Promise<unknown>;
  consume(
    queue: string,
    listener: (message: BrokerDelivery | null) => void,
    options: { noAck: false },
  ): Promise<{ consumerTag: string }>;
  cancel(consumerTag: string): Promise<unknown>;
  ack(message: BrokerDelivery): void;
  close(): Promise<void>;
}
export interface CouponConsumerBoundary {
  authenticatedActor(delivery: BrokerDelivery): Promise<string>;
  handleOtherAssignedEvent(delivery: BrokerDelivery): Promise<void>;
  failed(code: 'COUPON_CONSUMER_STOPPED'): void;
}

// One instance per dedicated channel; its supervisor owns reconnection/retry policy.
// Other events on the shared queue require the real #75 dispatcher, never a no-op.
export class CouponCommandConsumer {
  private consumerTag?: string;
  private started = false;
  private stopping = false;
  private readonly pending = new Set<Promise<void>>();
  private readonly retryAbort = new AbortController();

  constructor(
    private readonly channel: ConsumerChannelPort,
    private readonly handler: CouponCommandDeliveryHandler,
    private readonly boundary: CouponConsumerBoundary,
  ) {}

  async start(): Promise<void> {
    if (this.started) throw new Error('COUPON_CONSUMER_ALREADY_STARTED');
    this.started = true;
    this.channel.on?.('close', () => {
      void this.fail();
    });
    this.channel.on?.('error', () => {
      void this.fail();
    });
    try {
      await this.channel.prefetch(promotionsBrokerBinding.prefetch);
      const consumer = await this.channel.consume(
        promotionsBrokerBinding.queue,
        (message) => {
          if (!message) {
            void this.fail();
            return;
          }
          if (this.stopping) return;
          const processing = this.dispatchWithRetry(message).catch(() =>
            this.fail(),
          );
          this.pending.add(processing);
          void processing.then(() => this.pending.delete(processing));
        },
        { noAck: false },
      );
      this.consumerTag = consumer.consumerTag;
      if (this.stopping)
        await this.channel.cancel(consumer.consumerTag).catch(() => undefined);
    } catch {
      await this.fail();
      throw new Error('COUPON_CONSUMER_START_FAILED');
    }
  }

  private async dispatch(message: BrokerDelivery): Promise<void> {
    if (
      [consumptionName, restorationName].includes(message.fields.routingKey)
    ) {
      const actor = await this.boundary.authenticatedActor(message);
      await this.handler.handle(message, actor, () =>
        this.channel.ack(message),
      );
    } else {
      // Dispatch resolves only after its own durable commit; ACK belongs to this
      // channel, after completion, just as it does for coupon commands.
      await this.boundary.handleOtherAssignedEvent(message);
      this.channel.ack(message);
    }
  }

  private async dispatchWithRetry(message: BrokerDelivery): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.stopping) return;
      try {
        await this.dispatch(message);
        return;
      } catch (error) {
        const transient =
          error instanceof Error &&
          [
            'COUPON_COMMAND_FAILED',
            'PROMOTIONS_ASSIGNED_EVENT_FAILED',
          ].includes(error.message);
        if (!transient || attempt === 2) throw error;
        await delay(100 * 2 ** attempt, undefined, {
          signal: this.retryAbort.signal,
        });
      }
    }
  }

  private async fail(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.retryAbort.abort();
    try {
      this.boundary.failed('COUPON_CONSUMER_STOPPED');
    } catch {
      /* Observer cannot suppress closing. */
    }
    await this.channel.close().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.retryAbort.abort();
    if (this.consumerTag)
      await this.channel.cancel(this.consumerTag).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(this.pending),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 3000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      await this.channel.close().catch(() => undefined);
    }
  }
}
