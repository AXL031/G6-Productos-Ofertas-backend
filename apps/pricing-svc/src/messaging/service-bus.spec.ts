import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type {
  ServiceBusMessage,
  ServiceBusMessageBatch,
} from '@azure/service-bus';
import { readPricingServiceBus } from './service-bus-config.js';
import { PricingServiceBusRelay } from './service-bus-relay.js';
import {
  AUDIT_PILOT_QUEUE,
  type PricingDeliveryClaim,
} from './service-bus-deliveries.js';

const env = {
  NODE_ENV: 'test',
  MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
  G6_SERVICE_BUS_PILOT_ENABLED: 'true',
  PRICING_PRICE_CHANGED_PUBLISH_ENABLED: 'true',
  SERVICE_BUS_NAMESPACE_FQDN: 'g6-pilot-test.servicebus.windows.net',
};

function claim(): PricingDeliveryClaim {
  return {
    token: randomUUID(),
    destination: AUDIT_PILOT_QUEUE,
    row: {
      id: randomUUID(),
      messageId: randomUUID(),
      correlationId: randomUUID(),
      operationId: randomUUID(),
      causationId: null,
      eventName: 'pricing.price.changed',
      kind: 'event',
      schemaVersion: 1,
      occurredAt: new Date(),
      createdAt: new Date(),
      publishedAt: null,
      attempts: 0,
      lastError: null,
      payload: {
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
    },
  };
}

describe('Pricing Service Bus pilot safety and send confirmation', () => {
  it('allows production only with explicit activation, G7 and an assigned identity', () => {
    const clientId = randomUUID();
    const production = {
      ...env,
      NODE_ENV: 'production',
      G6_SERVICE_BUS_PRODUCTION_ENABLED: 'true',
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      AZURE_CLIENT_ID: clientId,
    };
    expect(readPricingServiceBus(production)).toEqual({
      namespace: env.SERVICE_BUS_NAMESPACE_FQDN,
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
      expect(() =>
        readPricingServiceBus({ ...production, ...change }),
      ).toThrow();
  });
  it('keeps H4 unchanged unless the pilot is explicitly enabled', () => {
    expect(readPricingServiceBus({})).toBeUndefined();
    expect(
      readPricingServiceBus({ MESSAGING_PROVIDER: 'RABBITMQ' }),
    ).toBeUndefined();
    expect(readPricingServiceBus(env)).toEqual({
      namespace: env.SERVICE_BUS_NAMESPACE_FQDN,
    });
  });
  it.each([
    { NODE_ENV: 'production' },
    { PRICING_AMQP_URL: 'amqps://private' },
    { G6_SERVICE_BUS_PILOT_ENABLED: 'false' },
    { PRICING_PRICE_CHANGED_PUBLISH_ENABLED: 'false' },
    {
      SERVICE_BUS_NAMESPACE_FQDN:
        'https://g6-pilot-test.servicebus.windows.net',
    },
    {
      SERVICE_BUS_NAMESPACE_FQDN:
        'g6-pilot-test.servicebus.windows.net.attacker.invalid',
    },
  ])(
    'rejects production, mixed transport or unapproved configuration: %j',
    (change) => {
      expect(() => readPricingServiceBus({ ...env, ...change })).toThrow();
    },
  );
  function fixture(add = true) {
    const selected = claim();
    const added: ServiceBusMessage[] = [];
    const batch: ServiceBusMessageBatch = {
      count: 1,
      sizeInBytes: 1000,
      maxSizeInBytes: 256 * 1024,
      tryAddMessage: (message) => {
        if (add) added.push(message as ServiceBusMessage);
        return add;
      },
      _generateMessage: () => Buffer.alloc(0),
      _messageSpanContexts: [],
    };
    const store = {
      claim: vi.fn(async () => selected),
      finish: vi.fn(async () => true),
    };
    const sender = {
      createMessageBatch: vi.fn(async () => batch),
      sendMessages: vi.fn(async () => undefined),
    };
    return {
      selected,
      added,
      store,
      sender,
      relay: new PricingServiceBusRelay(store, sender),
    };
  }
  it('preserves contract IDs and confirms only after SDK success', async () => {
    const f = fixture();
    expect(await f.relay.publishOne()).toBe('sent');
    expect(f.sender.createMessageBatch).toHaveBeenCalledWith({
      maxSizeInBytes: 256 * 1024,
    });
    expect(f.added[0]).toMatchObject({
      messageId: f.selected.row.messageId,
      correlationId: f.selected.row.correlationId,
    });
    expect(Buffer.isBuffer(f.added[0].body)).toBe(true);
    expect(JSON.parse(String(f.added[0].body))).toMatchObject({
      name: 'pricing.price.changed',
      producer: 'pricing-svc',
    });
    expect(f.store.finish).toHaveBeenCalledWith(f.selected, true);
    expect(f.store.finish.mock.invocationCallOrder[0]).toBeGreaterThan(
      f.sender.sendMessages.mock.invocationCallOrder[0],
    );
  });
  it('leaves an ambiguous send pending with the original message ID', async () => {
    const f = fixture();
    f.sender.sendMessages.mockRejectedValueOnce(
      new Error('timeout after acceptance'),
    );
    expect(await f.relay.publishOne()).toBe('pending');
    expect(f.store.finish).toHaveBeenCalledWith(f.selected, false);
    expect(await f.relay.publishOne()).toBe('sent');
    expect(f.added.map((message) => message.messageId)).toEqual([
      f.selected.row.messageId,
      f.selected.row.messageId,
    ]);
  });
  it('does not send or confirm a batch that exceeds the encoded limit', async () => {
    const f = fixture(false);
    expect(await f.relay.publishOne()).toBe('pending');
    expect(f.sender.sendMessages).not.toHaveBeenCalled();
    expect(f.store.finish).toHaveBeenCalledWith(f.selected, false);
  });
  it('does not report confirmation after losing its claim', async () => {
    const f = fixture();
    f.store.finish.mockResolvedValueOnce(false);
    expect(await f.relay.publishOne()).toBe('lease-lost');
  });
});
