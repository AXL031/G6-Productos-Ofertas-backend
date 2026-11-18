import type { ServiceBusReceivedMessage } from '@azure/service-bus';
import {
  PromotionsServiceBusEvents,
  promotionsEventRoutes,
  type EventReceiver,
} from './service-bus-events.js';
import type { PromotionsAssignedEventDispatcher } from './assigned-event-dispatcher.js';
import { readPromotionsServiceBus } from './service-bus-config.js';
import { validatePromotionsConfiguration } from '../infrastructure/config/promotions-config.js';
import { createEnvironmentFixture } from '../../test/support/environment.js';

function message(
  producer = 'catalog-svc',
  name = 'catalog.product.deactivated',
): ServiceBusReceivedMessage {
  return {
    body: Buffer.from(
      JSON.stringify({
        message_id: 'event-1',
        correlation_id: 'trace',
        producer,
        name,
        kind: 'event',
        schema_version: 1,
      }),
    ),
    messageId: 'event-1',
    correlationId: 'trace',
    subject: name,
    contentType: 'application/json',
    applicationProperties: { producer, schema_version: 1, route_version: 1 },
  } as unknown as ServiceBusReceivedMessage;
}

function fixture(eventQueues?: readonly ['g6.promotions.from.inventory']) {
  const handlers: Parameters<EventReceiver['subscribe']>[0][] = [];
  const receivers = promotionsEventRoutes.map(() => ({
    peekMessages: vi.fn(async () => []),
    subscribe: vi.fn((h: Parameters<EventReceiver['subscribe']>[0]) => {
      handlers.push(h);
      return { close: vi.fn(async () => undefined) };
    }),
    completeMessage: vi.fn(async () => undefined),
    abandonMessage: vi.fn(async () => undefined),
    deadLetterMessage: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }));
  const process = vi.fn<PromotionsAssignedEventDispatcher['process']>(
    async () => 'processed',
  );
  const close = vi.fn(async () => undefined);
  const runtime = new PromotionsServiceBusEvents(
    {
      namespace: 'g6-test-events.servicebus.windows.net',
      eventsEnabled: true,
      eventQueues,
    },
    { assertReady: vi.fn(), process },
    () => ({
      receiver: (q) =>
        receivers[promotionsEventRoutes.findIndex((r) => r.queue === q)],
      close,
    }),
  );
  return { runtime, receivers, handlers, process, close };
}

describe('Promotions Service Bus event lifecycle', () => {
  it('opens each producer queue separately and completes only after durable dispatch', async () => {
    const f = fixture();
    await f.runtime.onApplicationBootstrap();
    f.runtime.assertAvailable();
    expect(f.handlers).toHaveLength(3);
    let release: (() => void) | undefined;
    f.process.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve('processed');
        }),
    );
    const task = f.handlers[0].processMessage(message());
    expect(f.receivers[0].completeMessage).not.toHaveBeenCalled();
    release!();
    await task;
    expect(f.process.mock.calls[0][1]).toBe('catalog-svc');
    expect(f.receivers[0].completeMessage).toHaveBeenCalledOnce();
    await f.runtime.onModuleDestroy();
    expect(f.close).toHaveBeenCalledOnce();
    expect(() => f.runtime.assertAvailable()).toThrow(
      'PROMOTIONS_SERVICE_BUS_NOT_READY',
    );
  });

  it('does not accept a Catalog event on the Pricing queue even with self-asserted metadata', async () => {
    const f = fixture();
    await f.runtime.onApplicationBootstrap();
    await f.handlers[1].processMessage(message());
    expect(f.process).not.toHaveBeenCalled();
    expect(f.receivers[1].deadLetterMessage).toHaveBeenCalledOnce();
    await f.runtime.onModuleDestroy();
  });

  it('accepts the canonical Catalog envelope without AMQP mirror properties', async () => {
    const f = fixture();
    await f.runtime.onApplicationBootstrap();
    try {
      const m = message();
      delete m.applicationProperties;
      await f.handlers[0].processMessage(m);
      expect(f.receivers[0].completeMessage).toHaveBeenCalledWith(m);
    } finally {
      await f.runtime.onModuleDestroy();
    }
  });

  it('opens only the selected queue for a partial cutover', async () => {
    const f = fixture(['g6.promotions.from.inventory']);
    await f.runtime.onApplicationBootstrap();
    try {
      expect(f.receivers[0].subscribe).not.toHaveBeenCalled();
      expect(f.receivers[1].subscribe).not.toHaveBeenCalled();
      expect(f.receivers[2].subscribe).toHaveBeenCalledOnce();
    } finally {
      await f.runtime.onModuleDestroy();
    }
  });

  it('abandons a transient SQL failure, without completing or inventing a business rejection', async () => {
    const f = fixture();
    f.process.mockRejectedValueOnce(new Error('SQL_SECRET_NOT_LOGGED'));
    await f.runtime.onApplicationBootstrap();
    await f.handlers[0].processMessage(message());
    expect(f.receivers[0].abandonMessage).toHaveBeenCalledOnce();
    expect(f.receivers[0].completeMessage).not.toHaveBeenCalled();
    expect(f.receivers[0].deadLetterMessage).not.toHaveBeenCalled();
    await f.runtime.onModuleDestroy();
  });

  it('does not abandon or deadletter a committed event when complete fails', async () => {
    const f = fixture();
    f.receivers[0].completeMessage.mockRejectedValueOnce(
      new Error('LOCK_LOST'),
    );
    await f.runtime.onApplicationBootstrap();
    await f.handlers[0].processMessage(message());
    expect(f.receivers[0].abandonMessage).not.toHaveBeenCalled();
    expect(f.receivers[0].deadLetterMessage).not.toHaveBeenCalled();
    await f.runtime.onModuleDestroy();
  });

  it('settles replay and durably rejected payloads distinctly', async () => {
    const f = fixture();
    f.process
      .mockResolvedValueOnce('replayed')
      .mockResolvedValueOnce('rejected');
    await f.runtime.onApplicationBootstrap();
    await f.handlers[0].processMessage(message());
    await f.handlers[0].processMessage(message());
    expect(f.receivers[0].completeMessage).toHaveBeenCalledOnce();
    expect(f.receivers[0].deadLetterMessage).toHaveBeenCalledOnce();
    await f.runtime.onModuleDestroy();
  });

  it('closes partially opened resources if a queue is inaccessible at startup', async () => {
    const f = fixture();
    f.receivers[1].peekMessages.mockRejectedValueOnce(new Error('DENIED'));
    await expect(f.runtime.onApplicationBootstrap()).rejects.toThrow(
      'PROMOTIONS_SERVICE_BUS_START_FAILED',
    );
    expect(f.receivers[0].close).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it.each(['producer', 'schema_version', 'route_version'])(
    'rejects altered %s metadata before SQL',
    async (key) => {
      const f = fixture();
      await f.runtime.onApplicationBootstrap();
      const m = message();
      m.applicationProperties![key] = 'altered';
      await f.handlers[0].processMessage(m);
      expect(f.process).not.toHaveBeenCalled();
      await f.runtime.onModuleDestroy();
    },
  );
});

describe('Promotions H5 configuration', () => {
  const env = createEnvironmentFixture();
  afterAll(() => env.cleanup());
  const h5 = () => ({
    ...env.environment,
    RABBITMQ_URL: undefined,
    MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
    SERVICE_BUS_NAMESPACE_FQDN: 'g6-test-events.servicebus.windows.net',
    PROMOTIONS_SERVICE_BUS_EVENTS_ENABLED: 'true',
  });
  it('selects independent event consumers without enabling coupon mutations', () => {
    const c = validatePromotionsConfiguration(h5());
    expect(c.serviceBus?.eventsEnabled).toBe(true);
    expect(c.rabbitmqUrl).toBeUndefined();
    expect(c.couponRuntimeEnabled).toBe(false);
  });
  it.each([
    { RABBITMQ_URL: 'amqp://localhost' },
    { PROMOTIONS_COUPON_RUNTIME_ENABLED: 'true' },
    { MESSAGING_PROVIDER: 'other' },
    { SERVICE_BUS_NAMESPACE_FQDN: 'https://bad-host' },
    { PROMOTIONS_SERVICE_BUS_EVENTS_ENABLED: 'yes' },
    { NODE_ENV: 'production' },
    { G6_SERVICE_BUS_PRODUCTION_ENABLED: 'true' },
    { AZURE_CLIENT_ID: '00000000-0000-0000-0000-000000000000' },
    { PROMOTIONS_SERVICE_BUS_EVENT_QUEUES: 'unknown' },
    {
      PROMOTIONS_SERVICE_BUS_EVENT_QUEUES:
        'g6.promotions.from.inventory,g6.promotions.from.inventory',
    },
    {
      PROMOTIONS_SERVICE_BUS_EVENT_QUEUES: 'g6.promotions.from.inventory',
      PROMOTIONS_SERVICE_BUS_EVENTS_ENABLED: 'false',
    },
  ])('rejects unsafe/conflicting selection %j', (change) => {
    expect(() => readPromotionsServiceBus({ ...h5(), ...change })).toThrow(
      'PROMOTIONS_SERVICE_BUS_CONFIGURATION_INVALID',
    );
  });
  it('requires real security mode and assigned identity for production selection', () => {
    const c = readPromotionsServiceBus({
      ...h5(),
      NODE_ENV: 'production',
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      G6_SERVICE_BUS_PRODUCTION_ENABLED: 'true',
      AZURE_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
    });
    expect(c?.managedIdentityClientId).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
  });
});
