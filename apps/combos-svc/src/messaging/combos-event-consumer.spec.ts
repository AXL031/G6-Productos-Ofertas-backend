import type { ConsumeMessage } from 'amqplib';
import type { ServiceBusReceivedMessage } from '@azure/service-bus';
import {
  CombosEventConsumer,
  validateCombosEvent,
} from './combos-event-consumer.js';
import {
  InboxMessageConflictError,
  type CombosRepository,
} from '../persistence/combos.repository.js';
import { readCombosServiceBus } from './combos-service-bus.js';

const base = {
  message_id: 'catalog-message-1',
  schema_version: 1,
  occurred_at: '2026-11-02T12:00:00.000Z',
  correlation_id: 'correlation-1',
  causation_id: null,
  operation_id: null,
  producer: 'catalog-svc',
  kind: 'event',
  name: 'catalog.sku.deactivated',
  data: {
    sku: 'SKU-1',
    product_id: 'PRODUCT-1',
    sku_version: 2,
    changed_at: '2026-11-02T12:00:00.000Z',
  },
};

function message(value: Record<string, unknown> = base) {
  const name = String(value.name);
  return {
    content: Buffer.from(JSON.stringify(value)),
    fields: { routingKey: name },
    properties: {
      messageId: value.message_id,
      correlationId: value.correlation_id,
      type: name,
      contentType: 'application/json',
    },
  } as unknown as ConsumeMessage;
}

describe('validateCombosEvent', () => {
  it('accepts the strict catalog SKU deactivation envelope', () => {
    expect(validateCombosEvent(base, message())).toMatchObject({
      name: 'catalog.sku.deactivated',
      data: { sku: 'SKU-1', sku_version: 2 },
    });
  });

  it.each([
    [
      'wrong routing key',
      { fields: { routingKey: 'catalog.product.deactivated' } },
    ],
    ['wrong message identifier', { properties: { messageId: 'other' } }],
    ['unknown envelope property', { extra: true }],
    ['unknown payload property', { data: { extra: true } }],
    ['unsupported version', { schema_version: 2 }],
    ['malformed timestamp', { occurred_at: 'yesterday' }],
  ])('rejects %s', (_label, change) => {
    const value = {
      ...base,
      ...('data' in change
        ? { data: { ...base.data, ...change.data } }
        : change),
    };
    const transport = message(value);
    if ('fields' in change) Object.assign(transport.fields, change.fields);
    if ('properties' in change)
      Object.assign(transport.properties, change.properties);
    expect(() => validateCombosEvent(value, transport)).toThrow();
  });

  it('validates the stock v2 shape without treating its location snapshot as commercial availability', () => {
    const value = {
      ...base,
      schema_version: 2,
      producer: 'inventory-svc',
      name: 'inventory.stock.changed',
      data: {
        sku: 'SKU-1',
        location_id: '00000000-0000-4000-8000-000000000001',
        on_hand: 8,
        reserved: 1,
        blocked: 1,
        available: 6,
        estado: 'DISPONIBLE',
        stock_version: 4,
        updated_at: '2026-11-02T12:00:00.000Z',
      },
    };
    expect(validateCombosEvent(value, message(value)).data.available).toBe(6);
  });

  it('rejects ISO-looking timestamps with impossible calendar or clock values', () => {
    for (const occurredAt of [
      '2026-02-30T12:00:00.000Z',
      '2026-13-01T12:00:00Z',
      '2026-11-02T25:00:00Z',
      '2026-11-02T12:00:60Z',
      '2026-11-02T12:00:00+15:00',
    ]) {
      const value = { ...base, occurred_at: occurredAt };
      expect(() => validateCombosEvent(value, message(value))).toThrow();
    }
  });

  it('accepts explicitly namespaced envelope extensions', () => {
    const value = { ...base, 'x-source-region': 'local-test' };
    expect(validateCombosEvent(value, message(value)).name).toBe(
      'catalog.sku.deactivated',
    );
  });
});

describe('Combos H5 deliveries', () => {
  const fixture = () => {
    const processEvent = vi
      .fn<CombosRepository['processEvent']>()
      .mockResolvedValue('PROCESSED');
    const consumer = new CombosEventConsumer({
      processEvent,
    } as CombosRepository);
    const receiver = {
      completeMessage: vi.fn(async () => undefined),
      deadLetterMessage: vi.fn(async () => undefined),
      abandonMessage: vi.fn(async () => undefined),
    };
    const wire = {
      body: Buffer.from(JSON.stringify(base)),
      messageId: base.message_id,
      correlationId: base.correlation_id,
      subject: base.name,
      contentType: 'application/json',
    } as ServiceBusReceivedMessage;
    return { processEvent, consumer, receiver, wire };
  };

  it('keeps the same Inbox identity as H4 and completes after repository commit or duplicate', async () => {
    const f = fixture();
    let commit: (value: 'PROCESSED') => void = () => undefined;
    f.processEvent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          commit = resolve;
        }),
    );
    const delivery = f.consumer.processServiceBusDelivery(
      'g6.combos.from.catalog',
      f.receiver,
      f.wire,
    );
    expect(f.receiver.completeMessage).not.toHaveBeenCalled();
    expect(f.processEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        handler: 'combos.catalog.sku.deactivated',
        messageId: base.message_id,
        sku: 'SKU-1',
      }),
    );
    commit('PROCESSED');
    await delivery;
    f.processEvent.mockResolvedValueOnce('DUPLICATE');
    await f.consumer.processServiceBusDelivery(
      'g6.combos.from.catalog',
      f.receiver,
      f.wire,
    );
    expect(f.receiver.completeMessage).toHaveBeenCalledTimes(2);
  });

  it('dead-letters a Catalog message on the Inventory queue without writing a projection', async () => {
    const f = fixture();
    await f.consumer.processServiceBusDelivery(
      'g6.combos.from.inventory',
      f.receiver,
      f.wire,
    );
    expect(f.receiver.deadLetterMessage).toHaveBeenCalledOnce();
    expect(f.processEvent).not.toHaveBeenCalled();
  });

  it('abandons transient failure and dead-letters a reused ID with different content', async () => {
    const f = fixture();
    f.processEvent.mockRejectedValueOnce(new Error('database unavailable'));
    await f.consumer.processServiceBusDelivery(
      'g6.combos.from.catalog',
      f.receiver,
      f.wire,
    );
    expect(f.receiver.abandonMessage).toHaveBeenCalledOnce();
    f.processEvent.mockRejectedValueOnce(new InboxMessageConflictError());
    await f.consumer.processServiceBusDelivery(
      'g6.combos.from.catalog',
      f.receiver,
      f.wire,
    );
    expect(f.receiver.deadLetterMessage).toHaveBeenCalledWith(f.wire, {
      deadLetterReason: 'COMBOS_MESSAGE_ID_CONFLICT',
      deadLetterErrorDescription:
        'Message ID already recorded with different contents',
    });
    expect(f.receiver.completeMessage).not.toHaveBeenCalled();
  });

  it('fails closed when an Azure selection includes legacy transport or lacks production identity', () => {
    const env = {
      MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
      COMBOS_SERVICE_BUS_EVENTS_ENABLED: 'true',
      SERVICE_BUS_NAMESPACE_FQDN: 'g6-h5-lab.servicebus.windows.net',
    };
    expect(readCombosServiceBus(env)?.enabled).toBe(true);
    expect(() =>
      readCombosServiceBus({ ...env, COMBOS_AMQP_ENABLED: 'true' }),
    ).toThrow();
    expect(() =>
      readCombosServiceBus({ ...env, NODE_ENV: 'production' }),
    ).toThrow();
  });
});
