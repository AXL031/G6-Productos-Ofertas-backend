import { createAssignedProjectionAdapter } from './assigned-projections.js';
import { matchesSchema, type ContractSchema } from './schema-validator.js';
import type { AssignedEventAdapter } from './assigned-event-dispatcher.js';

// Docs 5124eea, AsyncAPI rc.4 / DEC-G6-INT-07. Registered behind runtime gates.
// Current pre-rc.4 Catalog publishers need coordinated adaptation before rollout.
const base = {
  type: 'object',
  additionalProperties: false,
  properties: {
    product_id: { type: 'string', minLength: 1 },
    changed_at: { type: 'string', format: 'date-time' },
  },
} satisfies ContractSchema;

function decode(data: Readonly<Record<string, unknown>>, sku: boolean) {
  const version = sku ? 'sku_version' : 'product_version';
  const schema: ContractSchema = {
    ...base,
    properties: {
      ...base.properties,
      [version]: { type: 'integer', minimum: 1 },
      ...(sku ? { sku: { type: 'string', minLength: 1 } } : {}),
    },
    required: ['product_id', 'changed_at', version, ...(sku ? ['sku'] : [])],
  };
  if (!matchesSchema(data, schema) || !Number.isSafeInteger(data[version]))
    throw new Error('INVALID_H4_CATALOG_EVENT');
  return {
    productId: data.product_id as string,
    sourceVersion: BigInt(data[version] as number),
  };
}

function envelopeV1(adapter: AssignedEventAdapter): AssignedEventAdapter {
  return {
    validate: adapter.validate,
    apply: async (client, event) => {
      if (event.schema_version !== 1)
        throw new Error('UNSUPPORTED_CATALOG_EVENT_VERSION');
      await adapter.apply(client, event);
    },
  };
}

export const catalogH4Adapters = Object.freeze({
  'catalog.product.deactivated': envelopeV1(
    createAssignedProjectionAdapter('catalog.product.deactivated', (data) =>
      decode(data, false),
    ),
  ),
  'catalog.sku.deactivated': envelopeV1(
    createAssignedProjectionAdapter('catalog.sku.deactivated', (data) => ({
      ...decode(data, true),
      sku: data.sku as string,
    })),
  ),
});
