import { createAssignedProjectionAdapter } from './assigned-projections.js';
import type { AssignedEvent } from './assigned-event-dispatcher.js';
import type { SqlClient } from '../infrastructure/persistence/sql-transaction.js';

const base = { sourceVersion: 1n };
function event(name = 'catalog.product.deactivated'): AssignedEvent {
  return {
    message_id: 'message',
    schema_version: 1,
    occurred_at: '2026-10-23T12:00:00Z',
    correlation_id: 'trace',
    kind: 'event',
    name,
    producer: name.startsWith('catalog.')
      ? 'catalog-svc'
      : name.startsWith('pricing.')
        ? 'pricing-svc'
        : 'inventory-svc',
    data: { synthetic: true },
  };
}
describe('Internal normalized assigned projection adapters #75', () => {
  it('keeps product and SKU projections separate and binds canonical identities as parameters', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({
      rows: [],
    }));
    const client: SqlClient = { query, release: () => {} };
    await createAssignedProjectionAdapter(
      'catalog.product.deactivated',
      () => ({ ...base, productId: 'P' }),
    ).apply(client, event());
    expect(query.mock.calls[0]?.[1]).toEqual([
      'PRODUCTO',
      'P',
      'P',
      '{"synthetic":true}',
      '1',
      '2026-10-23T12:00:00Z',
      'message',
    ]);
    query.mockClear();
    await createAssignedProjectionAdapter('catalog.sku.deactivated', () => ({
      ...base,
      productId: 'P',
      sku: 'SKU',
    })).apply(client, event('catalog.sku.deactivated'));
    expect(query.mock.calls[0]?.[1]).toEqual([
      'SKU',
      'SKU',
      'P',
      '{"synthetic":true}',
      '1',
      '2026-10-23T12:00:00Z',
      'message',
    ]);
  });
  it('preserves global price channel null and stock status rather than deriving aggregate stock', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({
      rows: [],
    }));
    const client: SqlClient = { query, release: () => {} };
    await createAssignedProjectionAdapter('pricing.price.changed', () => ({
      ...base,
      sku: 'S',
      channelId: null,
    })).apply(client, event('pricing.price.changed'));
    expect(query.mock.calls[0][1]?.slice(0, 2)).toEqual(['S', null]);
    await createAssignedProjectionAdapter('inventory.stock.changed', () => ({
      ...base,
      sku: 'S',
      availability: 'STOCK_BAJO',
    })).apply(client, event('inventory.stock.changed'));
    expect(query.mock.calls[1][1]?.slice(0, 2)).toEqual(['S', 'STOCK_BAJO']);
    expect(
      query.mock.calls.every(([sql]) =>
        sql.startsWith('INSERT INTO promotions.'),
      ),
    ).toBe(true);
  });
  it('does not infer a business version from envelope schema_version or fabricate a default decoder', async () => {
    const adapter = createAssignedProjectionAdapter(
      'catalog.product.deactivated',
      () => ({ productId: 'P', sourceVersion: null }),
    );
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({
      rows: [],
    }));
    await adapter.apply({ query, release: () => {} }, event());
    expect(query.mock.calls[0][1]?.[4]).toBeNull();
    expect(adapter.validate({})).toBe(true); // Only the EXPLICIT synthetic decoder supplies facts here.
    const missing = createAssignedProjectionAdapter(
      'catalog.product.deactivated',
      () => {
        throw new Error('mapping unavailable');
      },
    );
    expect(missing.validate({})).toBe(false);
  });
  it.each([-1n, 0n, 9223372036854775808n])(
    'rejects invalid local bigint version %s before SQL',
    (sourceVersion) => {
      expect(
        createAssignedProjectionAdapter('catalog.product.deactivated', () => ({
          productId: 'P',
          sourceVersion,
        })).validate({}),
      ).toBe(false);
    },
  );
  it('refuses wrong producer/name or an invalid event timestamp before touching SQL', async () => {
    const adapter = createAssignedProjectionAdapter(
      'catalog.product.deactivated',
      () => ({ ...base, productId: 'P' }),
    );
    const query = vi.fn(async () => ({ rows: [] }));
    for (const changes of [
      { producer: 'pricing-svc' },
      { name: 'catalog.sku.deactivated' },
      { occurred_at: '2026-02-30T12:00:00Z' },
    ])
      await expect(
        adapter.apply({ query, release: () => {} }, { ...event(), ...changes }),
      ).rejects.toThrow('INVALID_PROJECTION_SOURCE');
    expect(query).not.toHaveBeenCalled();
  });
});
