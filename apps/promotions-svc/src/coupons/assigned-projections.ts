import type { SqlClient } from '../infrastructure/persistence/sql-transaction.js';
import { validInstant } from '../domain/date-time.js';
import { record } from './schema-validator.js';
import { assignedEventContracts } from './event-contract.generated.js';
import type {
  AssignedEvent,
  AssignedEventAdapter,
} from './assigned-event-dispatcher.js';

// INTERNAL normalized projection input, derived from our own physical model.
// These names are NOT a proposed wire payload for GenericData. Each producer's
// decoder must be defined from a normative mapping before runtime registration.
export interface AssignedProjectionInputs {
  'catalog.product.deactivated': {
    productId: string;
    sourceVersion: bigint | null;
  };
  'catalog.sku.deactivated': {
    sku: string;
    productId: string;
    sourceVersion: bigint | null;
  };
  'pricing.price.changed': {
    sku: string;
    channelId: string | null;
    sourceVersion: bigint | null;
  };
  'inventory.stock.changed': {
    sku: string;
    availability: 'DISPONIBLE' | 'STOCK_BAJO' | 'AGOTADO';
    sourceVersion: bigint | null;
  };
}
type Name = keyof AssignedProjectionInputs;
type Input = AssignedProjectionInputs[Name];
const channels = ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'];
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();

function validate(name: Name, value: Input): void {
  if (
    !record(value) ||
    (value.sourceVersion !== null &&
      (typeof value.sourceVersion !== 'bigint' ||
        value.sourceVersion <= 0n ||
        value.sourceVersion > 9223372036854775807n))
  )
    throw new Error('INVALID_NORMALIZED_PROJECTION');
  if (
    name === 'catalog.product.deactivated' &&
    (!('productId' in value) || !text(value.productId))
  )
    throw new Error('INVALID_NORMALIZED_PROJECTION');
  if (
    name !== 'catalog.product.deactivated' &&
    (!('sku' in value) || !text(value.sku))
  )
    throw new Error('INVALID_NORMALIZED_PROJECTION');
  if (
    name === 'catalog.sku.deactivated' &&
    (!('productId' in value) || !text(value.productId))
  )
    throw new Error('INVALID_NORMALIZED_PROJECTION');
  if (
    name === 'pricing.price.changed' &&
    (!('channelId' in value) ||
      (value.channelId !== null && !channels.includes(String(value.channelId))))
  )
    throw new Error('INVALID_NORMALIZED_PROJECTION');
  if (
    name === 'inventory.stock.changed' &&
    (!('availability' in value) ||
      !['DISPONIBLE', 'STOCK_BAJO', 'AGOTADO'].includes(
        String(value.availability),
      ))
  )
    throw new Error('INVALID_NORMALIZED_PROJECTION');
}

/** Real local projection writer; owns no BEGIN/COMMIT, ACK, network or topology.
 * Caller is the existing dispatcher so projection + Inbox share one transaction.
 * No decoder or registration is provided for undefined external GenericData.
 */
export function createAssignedProjectionAdapter<N extends Name>(
  name: N,
  decode: (
    data: Readonly<Record<string, unknown>>,
  ) => AssignedProjectionInputs[N],
): AssignedEventAdapter {
  if (!Object.hasOwn(assignedEventContracts, name))
    throw new Error('UNSUPPORTED_PROJECTION_EVENT');
  const decoded = (data: Record<string, unknown>) => {
    const value = decode(data);
    validate(name, value);
    return value;
  };
  return {
    validate: (data) => {
      try {
        decoded(data);
        return true;
      } catch {
        return false;
      }
    },
    apply: async (client: SqlClient, event: AssignedEvent) => {
      if (
        event.name !== name ||
        event.producer !== assignedEventContracts[name].producer ||
        !validInstant(event.occurred_at) ||
        !text(event.message_id) ||
        !record(event.data)
      )
        throw new Error('INVALID_PROJECTION_SOURCE');
      const value = decoded(event.data);
      const provenance = [
        JSON.stringify(event.data),
        value.sourceVersion?.toString() ?? null,
        event.occurred_at,
        event.message_id,
      ];
      // Trigger fn_guard_projection retains authoritative stale/ambiguous order,
      // immutable identities and message conflicts from the applied migrations.
      if (
        name === 'catalog.product.deactivated' ||
        name === 'catalog.sku.deactivated'
      ) {
        const p = value as AssignedProjectionInputs['catalog.sku.deactivated'];
        const type =
          name === 'catalog.product.deactivated' ? 'PRODUCTO' : 'SKU';
        await client.query(
          `INSERT INTO promotions.catalog_projection
          (reference_type,reference_id,product_id,active,snapshot,source_version,source_occurred_at,source_message_id)
          VALUES ($1,$2,$3,false,$4::jsonb,$5,$6,$7)
          ON CONFLICT(reference_type,reference_id) DO UPDATE SET
          product_id=EXCLUDED.product_id,active=false,snapshot=EXCLUDED.snapshot,
          source_version=EXCLUDED.source_version,source_occurred_at=EXCLUDED.source_occurred_at,source_message_id=EXCLUDED.source_message_id`,
          [
            type,
            type === 'PRODUCTO' ? p.productId : p.sku,
            p.productId,
            ...provenance,
          ],
        );
      } else if (name === 'pricing.price.changed') {
        const p = value as AssignedProjectionInputs['pricing.price.changed'];
        await client.query(
          `INSERT INTO promotions.price_projection
          (sku,channel_id,snapshot,source_version,source_occurred_at,source_message_id)
          VALUES ($1,$2,$3::jsonb,$4,$5,$6)
          ON CONFLICT(sku,channel_id) DO UPDATE SET snapshot=EXCLUDED.snapshot,
          source_version=EXCLUDED.source_version,source_occurred_at=EXCLUDED.source_occurred_at,source_message_id=EXCLUDED.source_message_id`,
          [p.sku, p.channelId, ...provenance],
        );
      } else {
        const p = value as AssignedProjectionInputs['inventory.stock.changed'];
        await client.query(
          `INSERT INTO promotions.stock_projection
          (sku,availability,snapshot,source_version,source_occurred_at,source_message_id)
          VALUES ($1,$2,$3::jsonb,$4,$5,$6)
          ON CONFLICT(sku) DO UPDATE SET availability=EXCLUDED.availability,snapshot=EXCLUDED.snapshot,
          source_version=EXCLUDED.source_version,source_occurred_at=EXCLUDED.source_occurred_at,source_message_id=EXCLUDED.source_message_id`,
          [p.sku, p.availability, ...provenance],
        );
      }
    },
  };
}
