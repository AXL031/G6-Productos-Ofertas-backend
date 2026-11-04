import { randomUUID } from 'node:crypto';
import { h4EventAdapters } from './h4-event-adapters.js';
import { assignedH4Contracts } from './assigned-h4-contract.generated.js';
import { PromotionsAssignedEventDispatcher } from './assigned-event-dispatcher.js';
import type { BrokerDelivery } from './coupon-consumer.js';

const stock = {
  sku: '0001',
  location_id: '9129b578-631e-1735-8427-b683fb524380',
  on_hand: 12,
  reserved: 2,
  blocked: 1,
  available: 9,
  estado: 'DISPONIBLE',
  stock_version: 3,
  updated_at: '2026-11-01T00:00:00Z',
};
const price = {
  target_type: 'SKU',
  product_id: 'P',
  sku: '0001',
  channel_id: null,
  currency: 'PEN',
  price_type: 'REGULAR',
  previous_price: null,
  new_price: '19.90',
  operation: 'CREACION',
  reason: 'INITIAL',
  price_version: 1,
  valid_from: '2026-11-01T00:00:00Z',
  batch_id: null,
  actor: { user_id: null, email: null, ip: null },
};
function delivery(
  name: string,
  data: Record<string, unknown>,
  version: number,
): BrokerDelivery {
  return {
    content: Buffer.from(
      JSON.stringify({
        message_id: randomUUID(),
        schema_version: version,
        occurred_at: '2026-11-01T00:00:00Z',
        correlation_id: 'test',
        producer: assignedH4Contracts[name].producer,
        kind: 'event',
        name,
        data,
      }),
    ),
    fields: { exchange: 'po.eventos.x', routingKey: name },
    properties: { contentType: 'application/json' },
  };
}
describe('H4 typed invalidations #75', () => {
  it('validates the full price schema including target and operation rules', () => {
    const adapter = h4EventAdapters['pricing.price.changed'];
    expect(adapter.validate(price)).toBe(true);
    expect(
      adapter.validate({ ...price, target_type: 'PRODUCTO', sku: null }),
    ).toBe(true);
    for (const change of [
      { target_type: 'PRODUCTO' },
      { operation: 'MODIFICACION' },
      { new_price: '0' },
      { price_version: 0 },
      { sku: null },
      { actor: {} },
    ])
      expect(adapter.validate({ ...price, ...change })).toBe(false);
  });
  it('does not interpret stock quantities/status as commercial availability or global version', async () => {
    const adapter = h4EventAdapters['inventory.stock.changed'];
    expect(adapter.validate(stock)).toBe(true);
    const sql = {
      release: () => undefined,
      query: vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] })),
    };
    const result = await adapter.apply(sql, {
      message_id: 'M',
      correlation_id: 'C',
      schema_version: 2,
      occurred_at: stock.updated_at,
      producer: 'inventory-svc',
      kind: 'event',
      name: 'inventory.stock.changed',
      data: stock,
    });
    expect(result).toEqual({
      domain: 'stock',
      targetType: 'SKU',
      targetId: '0001',
      locationId: stock.location_id,
      sourceVersion: '3',
    });
    expect(result).not.toHaveProperty('availability');
    expect(sql.query).not.toHaveBeenCalled();
  });
  it('commits an invalidation disposition inside Inbox before reporting success', async () => {
    const calls: Array<[string, unknown[] | undefined]> = [];
    const query = vi.fn(async (sql: string, args?: unknown[]) => {
      calls.push([sql, args]);
      return { rows: sql.includes('fn_begin_inbox') ? [{ fresh: true }] : [] };
    });
    const dispatcher = new PromotionsAssignedEventDispatcher(
      { connect: async () => ({ query, release: () => undefined }) },
      h4EventAdapters,
      assignedH4Contracts,
    );
    expect(() => dispatcher.assertReady()).not.toThrow();
    expect(
      await dispatcher.process(
        delivery('pricing.price.changed', price, 1),
        'pricing-svc',
      ),
    ).toBe('processed');
    const completed = calls.find(([sql]) =>
      sql.startsWith('UPDATE promotions.inbox'),
    )!;
    expect(JSON.parse(completed[1]![2] as string)).toEqual({
      handled: true,
      invalidation: {
        domain: 'price',
        targetType: 'SKU',
        targetId: '0001',
        channelId: null,
        sourceVersion: '1',
      },
    });
    expect(calls.at(-1)![0]).toBe('COMMIT');
  });
  it('rejects legacy or incorrect stock versions before opening a transaction', async () => {
    const connect = vi.fn();
    const dispatcher = new PromotionsAssignedEventDispatcher(
      { connect },
      h4EventAdapters,
      assignedH4Contracts,
    );
    for (const [data, version] of [
      [stock, 1],
      [{ ...stock, stock_version: 0 }, 2],
      [{ sku: '0001', fixture_availability: 'DISPONIBLE' }, 2],
    ] as const)
      await expect(
        dispatcher.process(
          delivery('inventory.stock.changed', data, version),
          'inventory-svc',
        ),
      ).rejects.toThrow('INVALID_ASSIGNED_EVENT');
    expect(connect).not.toHaveBeenCalled();
  });
  it('records a permanent data rejection before completion and rolls back when persistence fails', async () => {
    const calls: string[] = [];
    let fail = false;
    const query = vi.fn(async (sql: string, args?: unknown[]) => {
      calls.push(sql);
      if (sql.startsWith('UPDATE')) {
        if (fail) throw new Error('synthetic persistence failure');
        expect(JSON.parse(args![2] as string)).toEqual({
          handled: false,
          rejected: true,
          reason: 'INVALID_ASSIGNED_EVENT_DATA',
        });
      }
      return { rows: sql.includes('fn_begin_inbox') ? [{ fresh: true }] : [] };
    });
    const dispatcher = new PromotionsAssignedEventDispatcher(
      { connect: async () => ({ query, release: () => undefined }) },
      h4EventAdapters,
      assignedH4Contracts,
      true,
    );
    const invalid = delivery(
      'inventory.stock.changed',
      { ...stock, stock_version: 0 },
      2,
    );
    expect(await dispatcher.process(invalid, 'inventory-svc')).toBe('rejected');
    expect(calls.at(-1)).toBe('COMMIT');
    fail = true;
    await expect(dispatcher.process(invalid, 'inventory-svc')).rejects.toThrow(
      'PROMOTIONS_ASSIGNED_EVENT_FAILED',
    );
    expect(calls.at(-1)).toBe('ROLLBACK');
    const before = calls.length;
    await expect(dispatcher.process(invalid, 'untrusted')).rejects.toThrow(
      'INVALID_ASSIGNED_EVENT',
    );
    expect(calls.length).toBe(before);
  });
});
