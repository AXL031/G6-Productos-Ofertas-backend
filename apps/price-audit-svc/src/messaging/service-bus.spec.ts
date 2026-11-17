import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ServiceBusReceivedMessage } from '@azure/service-bus';
import { AuditServiceBusHandler } from './service-bus-consumer.js';
import { readAuditServiceBus } from './service-bus-config.js';
import { AuditPersistenceError } from '../http/audit-http.error.js';
import { ServiceBusClient } from '@azure/service-bus';
import { AuditServiceBusRuntime } from './service-bus-consumer.js';
import { AuditDatabase } from '../persistence/audit.database.js';
import { AuditRepository } from '../persistence/audit.repository.js';
import type { AuditConfig } from '../config/environment.js';

function delivery(): ServiceBusReceivedMessage {
  const messageId = randomUUID(),
    correlationId = randomUUID();
  return {
    state: 'active',
    _rawAmqpMessage: {},
    messageId,
    correlationId,
    contentType: 'application/json',
    subject: 'pricing.price.changed',
    applicationProperties: {
      producer: 'pricing-svc',
      schema_version: 1,
      route_version: 1,
    },
    body: JSON.stringify({
      message_id: messageId,
      correlation_id: correlationId,
      operation_id: randomUUID(),
      causation_id: null,
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'pricing-svc',
      name: 'pricing.price.changed',
      kind: 'event',
      data: {
        target_type: 'PRODUCTO',
        product_id: 'product-opaque',
        sku: null,
        channel_id: null,
        currency: 'PEN',
        price_type: 'REGULAR',
        previous_price: null,
        new_price: '123.45',
        operation: 'CREACION',
        reason: 'ALTA_PRODUCTO',
        price_version: 1,
        valid_from: new Date().toISOString(),
        batch_id: null,
        actor: { user_id: null, email: null, ip: null },
      },
    }),
  };
}

describe('Audit Service Bus durable settlement', () => {
  it('allows production only with explicit activation, G7 and an assigned identity', () => {
    const clientId = randomUUID();
    const production = {
      NODE_ENV: 'production',
      MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
      G6_SERVICE_BUS_PILOT_ENABLED: 'true',
      G6_SERVICE_BUS_PRODUCTION_ENABLED: 'true',
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      AZURE_CLIENT_ID: clientId,
      SERVICE_BUS_NAMESPACE_FQDN: 'g6-pilot-test.servicebus.windows.net',
    };
    expect(readAuditServiceBus(production)).toEqual({
      namespace: production.SERVICE_BUS_NAMESPACE_FQDN,
      managedIdentityClientId: clientId,
    });
    for (const change of [
      { G6_SERVICE_BUS_PRODUCTION_ENABLED: undefined },
      { G6_SECURITY_MODE: 'SIMULATED_AUTH' },
      { G6_SECURITY_MODE: 'PUBLIC_READ_ONLY' },
      { AZURE_CLIENT_ID: undefined },
      { AZURE_CLIENT_ID: '00000000-0000-0000-0000-000000000000' },
      { AZURE_CLIENT_ID: 'invalid' },
      { NODE_ENV: 'development' },
    ])
      expect(() => readAuditServiceBus({ ...production, ...change })).toThrow();
  });
  function fixture() {
    const repository = { append: vi.fn(async () => ({ duplicate: false })) };
    const receiver = {
      completeMessage: vi.fn(async () => undefined),
      abandonMessage: vi.fn(async () => undefined),
      deadLetterMessage: vi.fn(async () => undefined),
    };
    return {
      repository,
      receiver,
      handler: new AuditServiceBusHandler(repository, receiver),
    };
  }
  it('completes only after durable append resolves', async () => {
    const f = fixture(),
      message = delivery();
    expect(await f.handler.handle(message)).toBe('completed');
    expect(
      f.receiver.completeMessage.mock.invocationCallOrder[0],
    ).toBeGreaterThan(f.repository.append.mock.invocationCallOrder[0]);
    expect(f.repository.append).toHaveBeenCalledWith(
      expect.objectContaining({ id: message.messageId }),
      expect.arrayContaining([
        expect.objectContaining({ next: '123.45', previous: null }),
      ]),
    );
  });
  it('accepts raw UTF-8 data sections returned by the SDK with JSON parsing disabled', async () => {
    const f = fixture(),
      message = delivery();
    message.body = new Uint8Array(Buffer.from(String(message.body), 'utf8'));
    expect(await f.handler.handle(message)).toBe('completed');
    expect(f.repository.append).toHaveBeenCalledOnce();
  });
  it.each([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(JSON.stringify(delivery().body)),
    Buffer.alloc(256 * 1024 + 1),
  ])('rejects invalid, nested or oversized raw data sections', async (body) => {
    const f = fixture(),
      message = delivery();
    message.body = body;
    expect(await f.handler.handle(message)).toBe('dead-lettered');
    expect(f.repository.append).not.toHaveBeenCalled();
  });
  it('does not misclassify post-commit settlement failure as invalid or roll back the effect', async () => {
    const f = fixture(),
      message = delivery();
    f.receiver.completeMessage.mockRejectedValueOnce(new Error('lock lost'));
    await expect(f.handler.handle(message)).rejects.toThrow('lock lost');
    expect(f.receiver.abandonMessage).not.toHaveBeenCalled();
    expect(f.receiver.deadLetterMessage).not.toHaveBeenCalled();
    f.repository.append.mockResolvedValueOnce({ duplicate: true });
    expect(await f.handler.handle(message)).toBe('completed');
  });
  it('abandons when SQL fails without completing the message', async () => {
    const f = fixture();
    f.repository.append.mockRejectedValueOnce(new AuditPersistenceError());
    expect(await f.handler.handle(delivery())).toBe('abandoned');
    expect(f.receiver.completeMessage).not.toHaveBeenCalled();
    expect(f.receiver.deadLetterMessage).not.toHaveBeenCalled();
  });
  it.each(['id', 'subject', 'version', 'payload'])(
    'durably rejects a contract mismatch: %s',
    async (kind) => {
      const f = fixture(),
        message = delivery();
      if (kind === 'id') message.messageId = randomUUID();
      if (kind === 'subject') message.subject = 'unknown';
      if (kind === 'version')
        message.applicationProperties!.schema_version = 99;
      if (kind === 'payload') message.body = '{}';
      expect(await f.handler.handle(message)).toBe('dead-lettered');
      expect(f.repository.append).not.toHaveBeenCalled();
      expect(f.receiver.completeMessage).not.toHaveBeenCalled();
    },
  );
  it('does not acknowledge failed DLQ disposition', async () => {
    const f = fixture(),
      message = delivery();
    message.body = '{}';
    f.receiver.deadLetterMessage.mockRejectedValueOnce(
      new Error('broker unavailable'),
    );
    await expect(f.handler.handle(message)).rejects.toThrow();
    expect(f.receiver.completeMessage).not.toHaveBeenCalled();
  });
  it('requires isolated non-production configuration and rejects mixed brokers', () => {
    const env = {
      NODE_ENV: 'test',
      MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
      G6_SERVICE_BUS_PILOT_ENABLED: 'true',
      SERVICE_BUS_NAMESPACE_FQDN: 'g6-pilot-test.servicebus.windows.net',
    };
    expect(readAuditServiceBus({})).toBeUndefined();
    expect(readAuditServiceBus(env)).toEqual({
      namespace: env.SERVICE_BUS_NAMESPACE_FQDN,
    });
    expect(() =>
      readAuditServiceBus({ ...env, NODE_ENV: 'production' }),
    ).toThrow();
    expect(() =>
      readAuditServiceBus({ ...env, PRICE_AUDIT_AMQP_URL: 'amqps://private' }),
    ).toThrow();
  });
});

describe('Audit SDK lifecycle without network or fake production credentials', () => {
  it('recovers readiness after an idle connection error without duplicating subscriptions and drains before closing', async () => {
    vi.useFakeTimers();
    const namespace = 'g6-pilot-test.servicebus.windows.net';
    const config: AuditConfig = {
      nodeEnv: 'test',
      securityMode: 'G7_AUTHENTICATED',
      port: 3003,
      databaseUrl: 'postgresql://test:test@127.0.0.1:1/test',
      databaseSsl: false,
      hotRetentionMonths: 24,
      archiveRetentionYears: 5,
      serviceBus: { namespace },
    };
    const database = new AuditDatabase(config);
    const repository = new AuditRepository(database);
    const client = new ServiceBusClient(namespace, {
      getToken: async () => {
        throw new Error('TEST_MUST_NOT_AUTHENTICATE');
      },
    });
    const receiver = client.createReceiver('g6.price-audit.from.pricing', {
      receiveMode: 'peekLock',
    });
    const peek = vi.spyOn(receiver, 'peekMessages').mockResolvedValue([]);
    const subscription = { close: vi.fn(async () => undefined) };
    const subscribe = vi
      .spyOn(receiver, 'subscribe')
      .mockReturnValue(subscription);
    const complete = vi.spyOn(receiver, 'completeMessage').mockResolvedValue();
    const close = vi.spyOn(receiver, 'close');
    const factory = vi
      .spyOn(ServiceBusClient.prototype, 'createReceiver')
      .mockReturnValue(receiver);
    const runtime = new AuditServiceBusRuntime(config, repository);
    let finishAppend: (() => void) | undefined;
    try {
      runtime.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.available).toBe(true);
      expect(subscribe).toHaveBeenCalledWith(expect.any(Object), {
        autoCompleteMessages: false,
        maxConcurrentCalls: 1,
      });
      const handlers = subscribe.mock.calls[0][0];
      await handlers.processError({
        error: new Error('fixture disconnect'),
        errorSource: 'receive',
        fullyQualifiedNamespace: namespace,
        entityPath: 'g6.price-audit.from.pricing',
        identifier: 'test',
      });
      expect(runtime.available).toBe(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(peek).toHaveBeenCalledTimes(2);
      expect(runtime.available).toBe(true);
      expect(subscribe).toHaveBeenCalledTimes(1);
      vi.spyOn(repository, 'append').mockImplementation(
        () =>
          new Promise((resolve) => {
            finishAppend = () => resolve({ duplicate: false });
          }),
      );
      const processing = handlers.processMessage(delivery());
      const stopping = runtime.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(0);
      expect(close).not.toHaveBeenCalled();
      finishAppend!();
      await processing;
      await stopping;
      expect(close.mock.invocationCallOrder[0]).toBeGreaterThan(
        complete.mock.invocationCallOrder[0],
      );
      expect(runtime.available).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finishAppend?.();
      factory.mockRestore();
      await runtime.onModuleDestroy();
      await client.close();
      await database.onApplicationShutdown();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});
