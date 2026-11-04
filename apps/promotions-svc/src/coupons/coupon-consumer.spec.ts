import {
  CouponCommandConsumer,
  type BrokerDelivery,
} from './coupon-consumer.js';
import { CouponCommandDeliveryHandler } from './coupon-amqp.js';
import {
  CouponCommandProcessor,
  type SqlPool,
  type CouponEvidenceProvider,
} from './coupon-transactions.js';

describe('continuous coupon consumer boundaries', () => {
  it('ACKs another assigned event only after its dispatcher resolves the durable commit', async () => {
    let deliver: ((message: BrokerDelivery | null) => void) | undefined;
    let commit: (() => void) | undefined;
    const durable = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const channel = {
      prefetch: async () => undefined,
      consume: async (
        _queue: string,
        callback: (message: BrokerDelivery | null) => void,
        _options: { noAck: false },
      ) => {
        deliver = callback;
        return { consumerTag: 'tag' };
      },
      ack: vi.fn(),
      cancel: async () => undefined,
      close: async () => undefined,
    };
    const processor = new CouponCommandProcessor(
      {
        connect: async () => {
          throw new Error('Unexpected coupon access');
        },
      },
      {
        verify: async () => {
          throw new Error('Unexpected evidence access');
        },
      },
    );
    const boundary = {
      authenticatedActor: async () => 'catalog-svc',
      handleOtherAssignedEvent: vi.fn(async () => durable),
      failed: vi.fn(),
    };
    const consumer = new CouponCommandConsumer(
      channel,
      new CouponCommandDeliveryHandler(processor),
      boundary,
    );
    await consumer.start();
    const message: BrokerDelivery = {
      content: Buffer.from('{}'),
      properties: {},
      fields: {
        exchange: 'po.eventos.x',
        routingKey: 'catalog.product.deactivated',
      },
    };
    deliver?.(message);
    await vi.waitFor(() =>
      expect(boundary.handleOtherAssignedEvent).toHaveBeenCalledOnce(),
    );
    expect(channel.ack).not.toHaveBeenCalled();
    commit?.();
    await vi.waitFor(() => expect(channel.ack).toHaveBeenCalledWith(message));
    expect(boundary.failed).not.toHaveBeenCalled();
    await consumer.stop();
  });
  it('uses manual ACK/prefetch and never discards another assigned event', async () => {
    let deliver: ((message: BrokerDelivery | null) => void) | undefined;
    const channel = {
      prefetch: vi.fn(async () => undefined),
      consume: vi.fn(
        async (
          _queue: string,
          callback: (message: BrokerDelivery | null) => void,
          _options: { noAck: false },
        ) => {
          deliver = callback;
          return { consumerTag: 'tag' };
        },
      ),
      ack: vi.fn(),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const pool: SqlPool = {
      connect: async () => {
        throw new Error('must-not-connect');
      },
    };
    const evidence: CouponEvidenceProvider = {
      verify: async () => {
        throw new Error('must-not-verify');
      },
    };
    const boundary = {
      authenticatedActor: vi.fn(async () => 'modulo-ventas'),
      handleOtherAssignedEvent: vi.fn(async () => {
        throw new Error('dispatcher-unavailable');
      }),
      failed: vi.fn(),
    };
    const consumer = new CouponCommandConsumer(
      channel,
      new CouponCommandDeliveryHandler(
        new CouponCommandProcessor(pool, evidence),
      ),
      boundary,
    );
    await consumer.start();
    expect(channel.prefetch).toHaveBeenCalledWith(20);
    expect(channel.consume).toHaveBeenCalledWith(
      'po.promociones.q',
      expect.any(Function),
      { noAck: false },
    );
    deliver?.({
      content: Buffer.from('{}'),
      fields: {
        exchange: 'po.eventos.x',
        routingKey: 'inventory.stock.changed',
      },
      properties: {},
    });
    await vi.waitFor(() => expect(channel.close).toHaveBeenCalled());
    expect(boundary.handleOtherAssignedEvent).toHaveBeenCalledOnce();
    expect(channel.ack).not.toHaveBeenCalled();
    expect(boundary.failed).toHaveBeenCalledWith('COUPON_CONSUMER_STOPPED');
    await consumer.stop();
  });
});
