import { assignedH4Contracts } from './assigned-h4-contract.generated.js';
import { catalogH4Adapters } from './catalog-h4-adapters.js';
import { matchesSchema } from './schema-validator.js';
import type {
  AssignedEventAdapter,
  AssignedEvent,
  AssignedInvalidation,
} from './assigned-event-dispatcher.js';

function invalidationAdapter(
  name: 'pricing.price.changed' | 'inventory.stock.changed',
  version: number,
): AssignedEventAdapter {
  const contract = assignedH4Contracts[name];
  const validate = (data: Record<string, unknown>) => {
    // Validate against the complete normative schema, including price conditionals.
    const sample = {
      message_id: 'validation',
      schema_version: version,
      occurred_at: '2026-11-01T00:00:00Z',
      correlation_id: 'validation',
      producer: contract.producer,
      kind: 'event',
      name,
      data,
    };
    return matchesSchema(sample, contract.schema);
  };
  return {
    validate,
    apply: async (
      _client,
      event: AssignedEvent,
    ): Promise<AssignedInvalidation> => {
      if (
        event.name !== name ||
        event.producer !== contract.producer ||
        event.schema_version !== version ||
        !validate(event.data)
      )
        throw new Error('INVALID_INVALIDATION_SOURCE');
      const d = event.data;
      // Persisted atomically by dispatcher in Inbox.result, never a no-op receipt.
      // No inventory quantity is interpreted as commercial availability.
      return name === 'pricing.price.changed'
        ? {
            domain: 'price',
            targetType: d.target_type as 'PRODUCTO' | 'SKU',
            targetId: (d.target_type === 'SKU'
              ? d.sku
              : d.product_id) as string,
            channelId: d.channel_id as string | null,
            sourceVersion: String(d.price_version),
          }
        : {
            domain: 'stock',
            targetType: 'SKU',
            targetId: d.sku as string,
            locationId: d.location_id as string,
            sourceVersion: String(d.stock_version),
          };
    },
  };
}
export const h4EventAdapters = Object.freeze({
  ...catalogH4Adapters,
  'pricing.price.changed': invalidationAdapter('pricing.price.changed', 1),
  'inventory.stock.changed': invalidationAdapter('inventory.stock.changed', 2),
});
