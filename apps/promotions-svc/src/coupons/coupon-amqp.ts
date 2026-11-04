import type { CouponResult } from './coupon-command.js';
import { couponContracts } from './coupon-contract.generated.js';
import { matchesSchema, record } from './schema-validator.js';
import { CouponCommandProcessor } from './coupon-transactions.js';
import type { ConfirmedResultPublisher } from './coupon-outbox.js';

type Listener = (...args: unknown[]) => void;
export interface ConfirmChannelPort {
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
  publish(
    exchange: string,
    key: string,
    body: Buffer,
    options: Record<string, unknown>,
    callback: (error: unknown) => void,
  ): boolean;
  close(): Promise<void>;
}

// Use a dedicated confirm channel. This adapter never declares shared topology.
export class CouponAmqpPublisher implements ConfirmedResultPublisher {
  constructor(private readonly channel: ConfirmChannelPort) {}

  async publishConfirmed(result: CouponResult): Promise<void> {
    const contract = couponContracts[result.name];
    if (
      !contract ||
      !matchesSchema(result, contract.schema) ||
      result.kind !== 'result'
    )
      throw new Error('INVALID_COUPON_RESULT');
    await new Promise<void>((resolve, reject) => {
      let returned = false;
      let finished = false;
      const clean = () => {
        clearTimeout(timer);
        this.channel.removeListener('return', onReturn);
        this.channel.removeListener('close', onFailure);
        this.channel.removeListener('error', onFailure);
      };
      const finish = (success: boolean) => {
        if (finished) return;
        finished = true;
        clean();
        if (success) resolve();
        else reject(new Error('PUBLISH_NOT_CONFIRMED'));
      };
      const onReturn: Listener = (message) => {
        if (
          record(message) &&
          record(message.properties) &&
          message.properties.messageId === result.message_id
        )
          returned = true;
      };
      const onFailure: Listener = () => finish(false);
      const timer = setTimeout(() => {
        finish(false);
        void this.channel.close().catch(() => undefined);
      }, 2000);
      this.channel.on('return', onReturn);
      this.channel.on('close', onFailure);
      this.channel.on('error', onFailure);
      try {
        this.channel.publish(
          contract.exchange,
          contract.routingKey,
          Buffer.from(JSON.stringify(result)),
          {
            persistent: true,
            mandatory: true,
            contentType: 'application/json',
            messageId: result.message_id,
            correlationId: result.correlation_id,
            type: result.name,
            appId: 'promotions-svc',
          },
          (error) => finish(!error && !returned),
        );
      } catch {
        finish(false);
      }
    });
  }
}

export interface CouponDelivery {
  content: Buffer;
  fields: { exchange: string; routingKey: string };
  properties: { contentType?: string; messageId?: string };
}

export class CouponCommandDeliveryHandler {
  constructor(private readonly processor: CouponCommandProcessor) {}

  async handle(
    delivery: CouponDelivery,
    authenticatedActor: string,
    ack: () => void,
  ): Promise<CouponResult> {
    if (
      delivery.content.length > 65536 ||
      delivery.properties.contentType !== 'application/json'
    )
      throw new Error('INVALID_COUPON_DELIVERY');
    let body: unknown;
    try {
      body = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(delivery.content),
      );
    } catch {
      throw new Error('INVALID_COUPON_DELIVERY');
    }
    const name = record(body) && typeof body.name === 'string' ? body.name : '';
    const contract = couponContracts[name];
    if (
      !contract ||
      !name.endsWith('.requested') ||
      delivery.fields.exchange !== contract.exchange ||
      delivery.fields.routingKey !== contract.routingKey ||
      (delivery.properties.messageId !== undefined &&
        delivery.properties.messageId !==
          (record(body) ? body.message_id : null))
    ) {
      throw new Error('INVALID_COUPON_DELIVERY');
    }
    const result = await this.processor.process(body, authenticatedActor);
    // A technical failure leaves the delivery unacknowledged; retry/DLX belongs to its authorized supervisor.
    ack();
    return result;
  }
}
