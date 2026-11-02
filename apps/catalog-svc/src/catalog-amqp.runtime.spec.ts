import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { connect, type ConsumeMessage, type ChannelModel } from 'amqplib';
import { CatalogAmqpRuntime } from './catalog-amqp.js';
import type { CatalogMessageService } from './catalog-message.service.js';
import type { CatalogTelemetry } from './catalog-telemetry.js';

vi.mock('amqplib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('amqplib')>()),
  connect: vi.fn(),
}));

describe('Catalog AMQP lifecycle (transport doubles, not broker E2E)', () => {
  const settings = {
    isolatedTestRecovery: true as const,
    connection: {
      url: 'amqp://catalog:fixture@localhost/g6-productos-ofertas',
      user: 'catalog',
      producerUsers: {
        'inventory-svc': 'inventory',
        'pricing-svc': 'pricing',
        'taxonomy-svc': 'taxonomy',
        'bulk-svc': 'bulk',
      },
    },
  };
  let active: CatalogAmqpRuntime | undefined;
  const record = vi.fn();
  function fixture() {
    let receive: (message: ConsumeMessage | null) => void = () => {
      throw new Error('not consuming');
    };
    const consumer = Object.assign(new EventEmitter(), {
      prefetch: vi.fn(async () => undefined),
      consume: vi.fn(async (_queue: string, callback: typeof receive) => {
        receive = callback;
        return { consumerTag: 'fixture' };
      }),
      ack: vi.fn(),
    });
    const publisher = Object.assign(new EventEmitter(), {
      publish: vi.fn(
        (
          _x: string,
          _k: string,
          _b: Buffer,
          _p: unknown,
          confirm: (error?: Error) => void,
        ) => {
          queueMicrotask(() => confirm());
          return true;
        },
      ),
      close: vi.fn(async () => undefined),
    });
    const connection = Object.assign(new EventEmitter(), {
      createChannel: vi.fn(async () => consumer),
      createConfirmChannel: vi.fn(async () => publisher),
      close: vi.fn(async () => {
        connection.emit('close');
      }),
    });
    return {
      consumer,
      publisher,
      connection,
      deliver: (message: ConsumeMessage | null) => receive(message),
    };
  }
  async function flush() {
    for (let n = 0; n < 15; n++) await Promise.resolve();
  }
  function start(messages: Partial<CatalogMessageService> = {}) {
    const service = {
      consume: vi.fn(async () => 'APPLIED' as const),
      relayOne: vi.fn(async () => 'EMPTY' as const),
      ...messages,
    };
    active = new CatalogAmqpRuntime(
      service as unknown as CatalogMessageService,
      settings,
      { record } as unknown as CatalogTelemetry,
    );
    active.onModuleInit();
    return service;
  }
  function delivery(): ConsumeMessage {
    const id = randomUUID(),
      correlation = randomUUID();
    return {
      content: Buffer.from(
        JSON.stringify({
          message_id: id,
          correlation_id: correlation,
          operation_id: randomUUID(),
          causation_id: randomUUID(),
          schema_version: 1,
          occurred_at: new Date().toISOString(),
          name: 'inventory.sku.initialization.completed',
          producer: 'inventory-svc',
          kind: 'result',
          data: {
            sku: '0001',
            product_id: 'p',
            variant_id: null,
            status: 'INITIALIZED',
            completed_at: new Date().toISOString(),
          },
        }),
      ),
      properties: {
        contentType: 'application/json',
        messageId: id,
        correlationId: correlation,
        userId: 'inventory',
      },
      fields: {},
    } as ConsumeMessage;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(connect).mockReset();
    record.mockClear();
  });
  afterEach(async () => {
    await active?.onModuleDestroy();
    active = undefined;
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  it.each([false, true])(
    'blocks shared runtime without an approved recovery disposition (test flag: %s)',
    async (isolated) => {
      vi.stubEnv('NODE_ENV', isolated ? 'production' : 'test');
      const messages = { consume: vi.fn(), relayOne: vi.fn() };
      active = new CatalogAmqpRuntime(
        messages as unknown as CatalogMessageService,
        {
          connection: settings.connection,
          ...(isolated ? { isolatedTestRecovery: true as const } : {}),
        },
        { record } as unknown as CatalogTelemetry,
      );
      active.onModuleInit();
      await vi.advanceTimersByTimeAsync(60000);
      expect(connect).not.toHaveBeenCalled();
      expect(messages.consume).not.toHaveBeenCalled();
      expect(messages.relayOne).not.toHaveBeenCalled();
      expect(record).toHaveBeenCalledExactlyOnceWith('AMQP_RECOVERY_BLOCKED');
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('reconnects after a connection failure and after server-side consumer cancellation', async () => {
    const first = fixture(),
      second = fixture();
    vi.mocked(connect)
      .mockRejectedValueOnce(new Error('private connection URL'))
      .mockResolvedValueOnce(first.connection as unknown as ChannelModel)
      .mockResolvedValueOnce(second.connection as unknown as ChannelModel);
    start();
    await flush();
    expect(record).toHaveBeenCalledWith('AMQP_CYCLE_PENDING');
    await vi.advanceTimersByTimeAsync(2000);
    expect(first.consumer.consume).toHaveBeenCalledOnce();
    expect(first.consumer.consume).toHaveBeenCalledWith(
      'po.catalogo.q',
      expect.any(Function),
      { noAck: false },
    );
    first.deliver(null);
    await flush();
    expect(first.connection.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    expect(second.consumer.consume).toHaveBeenCalledOnce();
    expect(JSON.stringify(record.mock.calls)).not.toContain(
      'private connection URL',
    );
  });
  it('does not ACK before commit and does ACK a valid business result after it', async () => {
    const f = fixture();
    vi.mocked(connect).mockResolvedValue(
      f.connection as unknown as ChannelModel,
    );
    let release!: (result: 'APPLIED') => void;
    const committed = new Promise<'APPLIED'>((resolve) => {
      release = resolve;
    });
    start({ consume: vi.fn(() => committed) });
    await flush();
    const message = delivery();
    f.deliver(message);
    await flush();
    expect(f.consumer.ack).not.toHaveBeenCalled();
    release('APPLIED');
    await flush();
    expect(f.consumer.ack).toHaveBeenCalledWith(message);
  });
  it('keeps delivery unacknowledged and closes the connection when retry publication is not confirmed', async () => {
    const f = fixture();
    vi.mocked(connect).mockResolvedValue(
      f.connection as unknown as ChannelModel,
    );
    f.publisher.publish.mockImplementation((_x, _k, _b, _p, confirm) => {
      queueMicrotask(() => confirm(new Error('private broker details')));
      return true;
    });
    start({
      consume: vi.fn(async () => {
        throw new Error('private SQL');
      }),
    });
    await flush();
    f.deliver(delivery());
    await flush();
    expect(f.consumer.ack).not.toHaveBeenCalled();
    expect(f.connection.close).toHaveBeenCalledOnce();
    expect(f.publisher.publish.mock.calls[0]?.[0]).toBe('po.retry.x');
  });
  it.each(['DUPLICATE', 'STALE', 'TERMINAL'] as const)(
    'ACKs a durably committed %s without a technical retry in the isolated fixture',
    async (result) => {
      const f = fixture();
      vi.mocked(connect).mockResolvedValue(
        f.connection as unknown as ChannelModel,
      );
      start({ consume: vi.fn(async () => result) });
      await flush();
      const message = delivery();
      f.deliver(message);
      await flush();
      expect(f.consumer.ack).toHaveBeenCalledExactlyOnceWith(message);
      expect(f.publisher.publish).not.toHaveBeenCalled();
    },
  );
  it('ACKs a committed business rejection, but disposes malformed JSON only in the explicit isolated DLQ fixture', async () => {
    const f = fixture();
    vi.mocked(connect).mockResolvedValue(
      f.connection as unknown as ChannelModel,
    );
    const service = start();
    await flush();
    const message = delivery();
    const body = JSON.parse(message.content.toString());
    body.name = 'inventory.sku.initialization.rejected';
    body.data.status = 'REJECTED';
    body.data.code = 'SKU_INVALIDO';
    message.content = Buffer.from(JSON.stringify(body));
    f.deliver(message);
    await flush();
    expect(service.consume).toHaveBeenCalledOnce();
    expect(f.consumer.ack).toHaveBeenCalledExactlyOnceWith(message);
    expect(f.publisher.publish).not.toHaveBeenCalled();
    const invalid = delivery();
    invalid.content = Buffer.from('{private-invalid');
    f.deliver(invalid);
    await flush();
    expect(service.consume).toHaveBeenCalledOnce();
    expect(f.publisher.publish.mock.calls[0][0]).toBe('po.dlx.x');
    expect(f.publisher.publish.mock.calls[0][1]).toBe('po.catalogo.q');
    expect(f.consumer.ack).toHaveBeenCalledWith(invalid);
    expect(JSON.stringify(record.mock.calls)).not.toContain('private-invalid');
  });
  it('bounds shutdown when a use case has not drained, preserving redelivery by closing the connection', async () => {
    const f = fixture();
    vi.mocked(connect).mockResolvedValue(
      f.connection as unknown as ChannelModel,
    );
    let release!: (result: 'APPLIED') => void;
    start({
      consume: () =>
        new Promise<'APPLIED'>((resolve) => {
          release = resolve;
        }),
    });
    await flush();
    f.deliver(delivery());
    await flush();
    const shutdown = active!.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(5000);
    await shutdown;
    expect(f.connection.close).toHaveBeenCalledOnce();
    expect(f.consumer.ack).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith('AMQP_SHUTDOWN_PENDING');
    release('APPLIED');
    await flush();
  });
  it('also bounds an unresponsive connection-close handshake', async () => {
    const f = fixture();
    vi.mocked(connect).mockResolvedValue(
      f.connection as unknown as ChannelModel,
    );
    start();
    await flush();
    f.connection.close.mockImplementation(() => new Promise(() => {}));
    const shutdown = active!.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(5000);
    await shutdown;
    expect(record).toHaveBeenCalledWith('AMQP_SHUTDOWN_PENDING');
  });
});
