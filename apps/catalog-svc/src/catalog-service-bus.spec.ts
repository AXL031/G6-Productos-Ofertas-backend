import type { ServiceBusClient, ServiceBusMessage } from '@azure/service-bus';
import { randomUUID } from 'node:crypto';
import type { CatalogEnvelope } from './catalog-messages.js';
import {
  CatalogServiceBus,
  createCatalogServiceBus,
  normalizeCatalogServiceBusBody,
  readCatalogH5Destinations,
} from './catalog-service-bus.js';

function outgoing(): CatalogEnvelope {
  const timestamp = new Date().toISOString();
  return {
    message_id: randomUUID(),
    schema_version: 1,
    occurred_at: timestamp,
    correlation_id: randomUUID(),
    causation_id: null,
    operation_id: null,
    producer: 'catalog-svc',
    kind: 'event',
    name: 'catalog.product.deactivated',
    data: {
      product_id: randomUUID(),
      product_version: 1,
      changed_at: timestamp,
    },
  };
}

describe('Catalog Service Bus candidate', () => {
  it('normalizes supported SDK body representations without changing JSON values', () => {
    const value = { message_id: 'stable', data: { sku: 'SKU-1' } };
    const bytes = Buffer.from(JSON.stringify(value));
    expect(normalizeCatalogServiceBusBody(bytes)).toEqual(value);
    expect(normalizeCatalogServiceBusBody(bytes.toString('utf8'))).toEqual(
      value,
    );
    expect(normalizeCatalogServiceBusBody(value)).toBe(value);
    expect(() => normalizeCatalogServiceBusBody('{invalid')).toThrow();
    expect(() =>
      normalizeCatalogServiceBusBody(new Uint8Array([0xff])),
    ).toThrow();
    expect(() => normalizeCatalogServiceBusBody([])).toThrow();
    expect(() =>
      normalizeCatalogServiceBusBody('x'.repeat(256 * 1024 + 1)),
    ).toThrow();
  });
  it('defaults to the existing provider and refuses simultaneous activation', () => {
    expect(createCatalogServiceBus({})).toBeUndefined();
    expect(() =>
      createCatalogServiceBus({
        MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
        CATALOG_AMQP_ENABLED: 'true',
      }),
    ).toThrow('RabbitMQ habilitado');
  });

  it('leaves H5 destinations disabled by default and validates explicit queue gates', () => {
    expect(readCatalogH5Destinations({})).toEqual([]);
    expect(
      readCatalogH5Destinations({
        CATALOG_H5_DESTINATIONS:
          'g6.pricing.from.catalog, g6.bulk.from.catalog',
      }),
    ).toEqual(['g6.pricing.from.catalog', 'g6.bulk.from.catalog']);
    expect(() =>
      readCatalogH5Destinations({ CATALOG_H5_DESTINATIONS: 'g6.invalid' }),
    ).toThrow('CATALOG_H5_DESTINATIONS inválido');
    expect(() =>
      readCatalogH5Destinations({
        CATALOG_H5_DESTINATIONS: 'g6.bulk.from.catalog,g6.bulk.from.catalog',
      }),
    ).toThrow('CATALOG_H5_DESTINATIONS inválido');
  });

  it('requires an assigned managed identity and explicit production enablement', async () => {
    const production = {
      NODE_ENV: 'production',
      MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
      SERVICE_BUS_NAMESPACE_FQDN: 'test-h5.servicebus.windows.net',
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      G6_SERVICE_BUS_PRODUCTION_ENABLED: 'true',
      AZURE_CLIENT_ID: randomUUID(),
    };
    expect(() =>
      createCatalogServiceBus({ ...production, AZURE_CLIENT_ID: undefined }),
    ).toThrow('identidad administrada');
    expect(() =>
      createCatalogServiceBus({
        ...production,
        G6_SERVICE_BUS_PRODUCTION_ENABLED: undefined,
      }),
    ).toThrow('habilitación');
    expect(() =>
      createCatalogServiceBus({
        ...production,
        RABBITMQ_URL: 'amqps://example.invalid',
      }),
    ).toThrow('RabbitMQ');
    const bus = createCatalogServiceBus(production);
    expect(bus).toBeDefined();
    await bus?.close();
  });

  it('keeps identity across ambiguous sends and reuses the queue sender', async () => {
    const tryAddMessage = vi
      .fn<(message: ServiceBusMessage) => boolean>()
      .mockReturnValue(true);
    const sendMessages = vi.fn().mockRejectedValueOnce(new Error('timeout'));
    const createSender = vi.fn().mockReturnValue({
      createMessageBatch: vi.fn().mockResolvedValue({ tryAddMessage }),
      sendMessages,
    });
    const client = { createSender } as unknown as ServiceBusClient;
    const bridge = new CatalogServiceBus(client);
    const event = outgoing();
    const queue = 'g6.promotions.from.catalog';
    await expect(bridge.publish(queue, event)).rejects.toThrow('timeout');
    await bridge.publish(queue, event);
    expect(createSender).toHaveBeenCalledTimes(1);
    expect(
      tryAddMessage.mock.calls.map(([sent]) => [
        sent.messageId,
        sent.correlationId,
      ]),
    ).toEqual(Array(2).fill([event.message_id, event.correlation_id]));
    await expect(
      bridge.publish('g6.inventory.from.catalog', event),
    ).rejects.toThrow('INVALID_CATALOG_MESSAGE');
    tryAddMessage.mockReturnValue(false);
    await expect(bridge.publish(queue, event)).rejects.toThrow(
      'SERVICE_BUS_MESSAGE_TOO_LARGE',
    );
    expect(sendMessages).toHaveBeenCalledTimes(2);
  });

  it('settles after consumption, retries SQL failures and rejects an invalid producer', async () => {
    type Handlers = Parameters<
      ReturnType<ServiceBusClient['createReceiver']>['subscribe']
    >[0];
    type Delivery = Parameters<Handlers['processMessage']>[0];
    let handlers!: Handlers;
    const completeMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('lock lost'));
    const abandonMessage = vi.fn();
    const deadLetterMessage = vi.fn();
    const createReceiver = vi.fn().mockReturnValue({
      subscribe: (value: Handlers) => {
        handlers = value;
        return { close: vi.fn() };
      },
      completeMessage,
      abandonMessage,
      deadLetterMessage,
    });
    const bridge = new CatalogServiceBus({
      createReceiver,
    } as unknown as ServiceBusClient);
    const consume = vi.fn().mockResolvedValue('APPLIED');
    bridge.subscribe('g6.catalog.from.inventory', { consume }, vi.fn());
    const event: CatalogEnvelope = {
      ...outgoing(),
      producer: 'inventory-svc',
      kind: 'result',
      name: 'inventory.sku.initialization.completed',
      operation_id: randomUUID(),
      causation_id: randomUUID(),
      data: {
        product_id: randomUUID(),
        sku: 'SKU-1',
        variant_id: null,
        status: 'INITIALIZED',
        completed_at: new Date().toISOString(),
      },
    };
    const delivery = (envelope: CatalogEnvelope) =>
      ({
        body: Buffer.from(JSON.stringify(envelope)),
        messageId: envelope.message_id,
        correlationId: envelope.correlation_id,
        subject: envelope.name,
        contentType: 'application/json',
      }) as Delivery;
    await expect(handlers.processMessage(delivery(event))).rejects.toThrow(
      'lock lost',
    );
    expect(consume.mock.invocationCallOrder[0]).toBeLessThan(
      completeMessage.mock.invocationCallOrder[0]!,
    );
    expect(abandonMessage).not.toHaveBeenCalled();
    consume.mockResolvedValueOnce('DUPLICATE');
    await handlers.processMessage(delivery(event));
    expect(completeMessage).toHaveBeenCalledTimes(2);
    await handlers.processMessage({
      ...delivery(event),
      body: JSON.stringify(event),
    } as Delivery);
    await handlers.processMessage({
      ...delivery(event),
      body: event,
    } as Delivery);
    expect(completeMessage).toHaveBeenCalledTimes(4);
    expect(consume).toHaveBeenCalledTimes(4);
    consume.mockRejectedValueOnce(new Error('SQL unavailable'));
    await handlers.processMessage(delivery(event));
    expect(abandonMessage).toHaveBeenCalledTimes(1);
    await handlers.processMessage(
      delivery({ ...event, producer: 'pricing-svc' }),
    );
    expect(deadLetterMessage).toHaveBeenCalledTimes(1);
    await handlers.processMessage({
      ...delivery(event),
      contentType: 'text/plain',
    } as Delivery);
    expect(deadLetterMessage).toHaveBeenCalledTimes(2);
  });
});
