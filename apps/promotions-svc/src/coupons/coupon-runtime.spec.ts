import { CouponRuntime, type CouponRuntimeBoundary } from './coupon-runtime.js';
import { CouponOutboxPump } from './coupon-outbox-pump.js';
import { CouponCommandDeliveryHandler } from './coupon-amqp.js';
import { CouponCommandProcessor } from './coupon-transactions.js';
import type { BrokerDelivery } from './coupon-consumer.js';

function fixture(enabled: boolean) {
  let deliver: ((message: BrokerDelivery | null) => void) | undefined;
  const events = new Map<string, () => void>();
  const channel = {
    on: (event: string, listener: () => void) => events.set(event, listener),
    prefetch: vi.fn(async () => undefined),
    consume: vi.fn(
      async (
        _queue: string,
        listener: (message: BrokerDelivery | null) => void,
      ) => {
        deliver = listener;
        return { consumerTag: 'test' };
      },
    ),
    cancel: vi.fn(async () => undefined),
    ack: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const boundary: CouponRuntimeBoundary = {
    assertReady: vi.fn(async () => {
      throw new Error('CONTRACT_BOUNDARY_NOT_READY');
    }),
    authenticatedActor: vi.fn(async () => {
      throw new Error('AUTHENTICATED_ACTOR_UNAVAILABLE');
    }),
    handleOtherAssignedEvent: vi.fn(async () => {
      throw new Error('DISPATCHER_UNAVAILABLE');
    }),
    failed: vi.fn(),
  };
  const open = vi.fn(async () => channel);
  const pump = new CouponOutboxPump(
    { publishOne: async () => 'empty' },
    () => undefined,
  );
  const start = vi.spyOn(pump, 'start').mockImplementation(() => undefined);
  const stop = vi.spyOn(pump, 'stop');
  const handler = new CouponCommandDeliveryHandler(
    new CouponCommandProcessor(
      {
        connect: async () => {
          throw new Error('UNEXPECTED_DATABASE_ACCESS');
        },
      },
      {
        verify: async () => {
          throw new Error('UNAVAILABLE');
        },
      },
    ),
  );
  const runtime = new CouponRuntime(enabled, boundary, open, handler, pump);
  return {
    runtime,
    boundary,
    open,
    start,
    stop,
    channel,
    disconnected: () => events.get('close')?.(),
    deliver: (message: BrokerDelivery | null) => deliver?.(message),
  };
}

describe('coupon service lifecycle gate', () => {
  it('stops the pump on channel loss without inventing a reconnect or retry policy', async () => {
    const f = fixture(true);
    vi.mocked(f.boundary.assertReady).mockResolvedValue(undefined);
    await f.runtime.onApplicationBootstrap();
    f.disconnected();
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalled());
    expect(f.boundary.failed).toHaveBeenCalledWith('COUPON_CONSUMER_STOPPED');
    expect(f.channel.ack).not.toHaveBeenCalled();
    await f.runtime.onModuleDestroy();
  });
  it('does not check external boundaries, open channels or run Outbox by default', async () => {
    const f = fixture(false);
    await f.runtime.onApplicationBootstrap();
    expect(f.boundary.assertReady).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    await f.runtime.onModuleDestroy();
  });

  it('rejects activation before opening any channel when a dependency is missing', async () => {
    const f = fixture(true);
    await expect(f.runtime.onApplicationBootstrap()).rejects.toThrow(
      'CONTRACT_BOUNDARY_NOT_READY',
    );
    expect(f.open).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });

  it('starts only after preflight, delegates other assigned events, and stops after consumer failure', async () => {
    const f = fixture(true);
    vi.mocked(f.boundary.assertReady).mockResolvedValue(undefined);
    await f.runtime.onApplicationBootstrap();
    expect(f.channel.prefetch).toHaveBeenCalledWith(20);
    expect(f.start).toHaveBeenCalledOnce();
    const message = {
      fields: {
        routingKey: 'inventory.stock.changed',
        exchange: 'po.eventos.x',
      },
      properties: {},
      content: Buffer.from('{}'),
    };
    f.deliver(message);
    await vi.waitFor(() => expect(f.channel.close).toHaveBeenCalled());
    expect(f.boundary.handleOtherAssignedEvent).toHaveBeenCalledWith(message);
    expect(f.channel.ack).not.toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalled();
    await f.runtime.onModuleDestroy();
  });
});
