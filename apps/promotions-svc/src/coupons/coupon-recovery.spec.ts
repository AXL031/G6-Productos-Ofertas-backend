import {
  CouponCommandConsumer,
  type BrokerDelivery,
  type ConsumerChannelPort,
} from './coupon-consumer.js';
import { CouponCommandDeliveryHandler } from './coupon-amqp.js';
import { CouponCommandProcessor } from './coupon-transactions.js';

describe('Bounded local AMQP retry INT-12', () => {
  async function setup(handle: () => Promise<void>) {
    let deliver: ((message: BrokerDelivery | null) => void) | undefined;
    const ack = vi.fn(),
      close = vi.fn(async () => undefined),
      failed = vi.fn();
    const channel: ConsumerChannelPort = {
      ack,
      close,
      prefetch: async () => undefined,
      cancel: async () => undefined,
      consume: async (_queue, listener) => {
        deliver = listener;
        return { consumerTag: 'test' };
      },
    };
    const processor = new CouponCommandProcessor(
      {
        connect: async () => {
          throw new Error('unexpected DB');
        },
      },
      {
        verify: async () => {
          throw new Error('unexpected evidence');
        },
      },
    );
    const consumer = new CouponCommandConsumer(
      channel,
      new CouponCommandDeliveryHandler(processor),
      {
        authenticatedActor: async () => 'inventory-svc',
        handleOtherAssignedEvent: handle,
        failed,
      },
    );
    await consumer.start();
    deliver!({
      content: Buffer.from('{}'),
      fields: {
        exchange: 'po.eventos.x',
        routingKey: 'inventory.stock.changed',
      },
      properties: {},
    });
    return { consumer, ack, close, failed };
  }
  it('retries twice after initial technical failure and ACKs only successful durable completion', async () => {
    const handle = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error('PROMOTIONS_ASSIGNED_EVENT_FAILED'))
      .mockRejectedValueOnce(new Error('PROMOTIONS_ASSIGNED_EVENT_FAILED'));
    const f = await setup(handle);
    expect(f.ack).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.ack).toHaveBeenCalledOnce());
    expect(handle).toHaveBeenCalledTimes(3);
    expect(f.ack).toHaveBeenCalledOnce();
    expect(f.failed).not.toHaveBeenCalled();
    await f.consumer.stop();
  });
  it('pauses after three attempts without ACK or NACK/requeue loop', async () => {
    const handle = vi.fn(async () => {
      throw new Error('PROMOTIONS_ASSIGNED_EVENT_FAILED');
    });
    const f = await setup(handle);
    await vi.waitFor(() => expect(f.failed).toHaveBeenCalledOnce());
    expect(handle).toHaveBeenCalledTimes(3);
    expect(f.ack).not.toHaveBeenCalled();
    expect(f.failed).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
    await f.consumer.stop();
  });
  it('does not retry a malformed or unauthorized delivery blindly', async () => {
    const handle = vi.fn(async () => {
      throw new Error('INVALID_ASSIGNED_EVENT');
    });
    const f = await setup(handle);
    await vi.waitFor(() => expect(f.failed).toHaveBeenCalledOnce());
    expect(handle).toHaveBeenCalledOnce();
    expect(f.ack).not.toHaveBeenCalled();
    expect(f.failed).toHaveBeenCalledOnce();
    await f.consumer.stop();
  });
  it('cancels the backoff when shutting down', async () => {
    const handle = vi.fn(async () => {
      throw new Error('PROMOTIONS_ASSIGNED_EVENT_FAILED');
    });
    const f = await setup(handle);
    await Promise.resolve();
    await f.consumer.stop();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(handle).toHaveBeenCalledOnce();
    expect(f.ack).not.toHaveBeenCalled();
  });
});
