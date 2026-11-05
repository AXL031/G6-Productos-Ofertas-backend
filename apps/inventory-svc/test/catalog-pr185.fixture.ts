import { randomUUID } from 'node:crypto';

/**
 * Wire fixture derived from Catalog PR #185 at
 * 263bd2655184c3cd559ab1f682a75f3730f5f85f:
 * catalog-mutation.service.ts emits { product_id, sku, sku_version,
 * changed_at } and calls catalog-messages.ts envelope(name, data,
 * correlationId, randomUUID()). The envelope builder supplies the remaining
 * fields below (including causation_id=null). This intentionally avoids
 * importing code across service boundaries.
 */
export function catalogPr185SkuDeactivatedEvent(input: {
  sku: string;
  productId: string;
  skuVersion: number;
  changedAt: string;
}) {
  return {
    message_id: randomUUID(),
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    operation_id: randomUUID(),
    causation_id: null,
    producer: 'catalog-svc',
    kind: 'event',
    name: 'catalog.sku.deactivated',
    data: {
      product_id: input.productId,
      sku: input.sku,
      sku_version: input.skuVersion,
      changed_at: input.changedAt,
    },
  } as const;
}
