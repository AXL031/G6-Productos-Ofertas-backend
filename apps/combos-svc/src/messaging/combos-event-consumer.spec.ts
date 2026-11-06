import type { ConsumeMessage } from 'amqplib';
import { validateCombosEvent } from './combos-event-consumer.js';

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
