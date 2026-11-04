import { catalogH4Adapters } from './catalog-h4-adapters.js';
import type { AssignedEvent } from './assigned-event-dispatcher.js';
import type { SqlClient } from '../infrastructure/persistence/sql-transaction.js';

describe('Typed Catalog rc.4 candidate decoders #75', () => {
  const at = '2026-11-01T20:00:00Z';
  const product = { product_id: 'P', product_version: 7, changed_at: at };
  const sku = { product_id: 'P', sku: '0001', sku_version: 3, changed_at: at };
  it('uses domain version and preserves opaque SKU separately from product', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({
      rows: [],
    }));
    const client = { query } as unknown as SqlClient;
    for (const [name, data, version] of [
      ['catalog.product.deactivated', product, '7'],
      ['catalog.sku.deactivated', sku, '3'],
    ] as const) {
      const adapter = catalogH4Adapters[name];
      expect(adapter.validate(data)).toBe(true);
      await expect(
        adapter.apply(client, {
          name,
          data,
          producer: 'catalog-svc',
          schema_version: 2,
          occurred_at: at,
          message_id: 'wrong-version',
          correlation_id: 'C',
          kind: 'event',
        }),
      ).rejects.toThrow('UNSUPPORTED_CATALOG_EVENT_VERSION');
      await adapter.apply(client, {
        name,
        data,
        producer: 'catalog-svc',
        schema_version: 1,
        occurred_at: at,
        message_id: 'M',
        correlation_id: 'C',
        kind: 'event',
      } satisfies AssignedEvent);
      expect(query.mock.lastCall?.[1]).toEqual([
        name.includes('.sku.') ? 'SKU' : 'PRODUCTO',
        name.includes('.sku.') ? '0001' : 'P',
        'P',
        JSON.stringify(data),
        version,
        at,
        'M',
      ]);
    }
    expect(query).toHaveBeenCalledTimes(2);
  });
  it.each([
    { product_id: 'P' },
    { ...product, product_version: 0 },
    { ...product, product_version: Number.MAX_SAFE_INTEGER + 1 },
    { ...product, changed_at: '2026-02-30T00:00:00Z' },
    { ...product, motivo: 'legacy field' },
  ])('rejects undefined/legacy/invalid payload %j', (data) => {
    expect(
      catalogH4Adapters['catalog.product.deactivated'].validate(data),
    ).toBe(false);
  });
  it('rejects the old variant payload without sku_version/changed_at', () => {
    expect(
      catalogH4Adapters['catalog.sku.deactivated'].validate({
        product_id: 'P',
        variant_id: 'V',
        sku: '0001',
      }),
    ).toBe(false);
  });
});
