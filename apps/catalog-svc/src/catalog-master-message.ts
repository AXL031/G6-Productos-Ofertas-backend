import { and, eq, sql } from 'drizzle-orm';
import type { Database } from './database.js';
import { inbox, masterBarriers, outbox } from './catalog.schema.js';
import {
  assertMasterData,
  envelope,
  InvalidCatalogMessage,
  type CatalogEnvelope,
  parseCatalogMessage,
} from './catalog-messages.js';
import {
  hasActiveMasterUse,
  lockMasterReferences,
  associationCoordinates,
  persistedAssociation,
} from './catalog-master-barriers.js';
import type { CatalogTelemetry } from './catalog-telemetry.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export async function consumeMasterMessage(
  database: Database,
  message: CatalogEnvelope,
  telemetry: CatalogTelemetry,
) {
  message = parseCatalogMessage(message);
  assertMasterData(message.data, message.operation_id);
  if (
    ![
      'taxonomy.master.deactivation.check.requested',
      'taxonomy.master.deactivated',
      'taxonomy.master.deactivation.rejected',
    ].includes(message.name)
  )
    throw new InvalidCatalogMessage();
  const data = message.data;
  const operationId = message.operation_id!;
  const handler = 'catalog.master-barriers.v1';
  return database.transaction(async (tx) => {
    await lockMasterReferences(tx, [
      { type: data.entity_type, id: data.entity_id },
    ]);
    // The operation lock also serializes conflicting intents using different master IDs.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${'catalog-master-operation:' + operationId},0))`,
    );
    const [seen] = await tx
      .select()
      .from(inbox)
      .where(
        and(
          eq(inbox.message_id, message.message_id),
          eq(inbox.handler, handler),
        ),
      );
    if (seen) {
      if (canonical(seen.payload) !== canonical(message))
        throw new InvalidCatalogMessage();
      return 'DUPLICATE' as const;
    }
    const [barrier] = await tx
      .select()
      .from(masterBarriers)
      .where(eq(masterBarriers.operation_id, operationId));
    const check = message.name.endsWith('.check.requested');
    const coordinates = associationCoordinates(data);
    const storedCoordinates = barrier
      ? persistedAssociation(barrier.payload)
      : undefined;
    const associationMatches =
      data.entity_type !== 'PRODUCT_TYPE_CHARACTERISTIC' ||
      (storedCoordinates &&
        (coordinates
          ? coordinates.productTypeId === storedCoordinates.productTypeId &&
            coordinates.characteristicId === storedCoordinates.characteristicId
          : !check));
    const matches =
      associationMatches &&
      barrier &&
      barrier.master_type === data.entity_type &&
      barrier.master_id === data.entity_id &&
      barrier.source_version === BigInt(data.version);
    let result: 'APPLIED' | 'STALE' | 'TERMINAL' | 'BLOCKED' = 'STALE';
    if (barrier && !matches) {
      telemetry.record(
        data.entity_type === 'PRODUCT_TYPE_CHARACTERISTIC' && !storedCoordinates
          ? 'MASTER_BARRIER_BLOCKED_ASSOCIATION'
          : 'MASTER_BARRIER_UNPROVEN_FINAL',
        {
          operationId,
          messageId: message.message_id,
        },
      );
    } else if (barrier && !barrier.is_blocking) {
      result = 'TERMINAL';
    } else if (check) {
      const [competing] = await tx
        .select()
        .from(masterBarriers)
        .where(
          and(
            eq(masterBarriers.master_type, data.entity_type),
            eq(masterBarriers.master_id, data.entity_id),
            eq(masterBarriers.is_blocking, true),
          ),
        );
      if (competing && competing.operation_id !== operationId) {
        telemetry.record('MASTER_BARRIER_OPERATION_CONFLICT', {
          operationId,
          messageId: message.message_id,
        });
      } else {
        if (!barrier) {
          const use = await hasActiveMasterUse(
            tx,
            data.entity_type,
            data.entity_id,
            coordinates,
          );
          const response = envelope(
            'catalog.master.deactivation.checked',
            {
              ...data,
              result: use ? 'IN_USE' : 'CLEAR',
            },
            message.correlation_id,
            operationId,
            message.message_id,
          );
          await tx.insert(masterBarriers).values({
            master_type: data.entity_type,
            master_id: data.entity_id,
            operation_id: operationId,
            source_version: BigInt(data.version),
            payload: { request: message, result: response.data.result },
          });
          await tx.insert(outbox).values({
            message_id: response.message_id,
            event_name: response.name,
            kind: response.kind,
            schema_version: response.schema_version,
            correlation_id: response.correlation_id,
            causation_id: response.causation_id,
            operation_id: operationId,
            occurred_at: new Date(response.occurred_at),
            payload: response.data,
          });
        }
        result = 'APPLIED';
      }
    } else if (matches) {
      await tx
        .update(masterBarriers)
        .set({
          is_blocking: false,
          payload: { ...barrier.payload, final: message },
        })
        .where(eq(masterBarriers.id, barrier.id));
      result = 'APPLIED';
    } else {
      telemetry.record('MASTER_BARRIER_UNPROVEN_FINAL', {
        operationId,
        messageId: message.message_id,
      });
    }
    await tx.insert(inbox).values({
      message_id: message.message_id,
      handler,
      event_name: message.name,
      correlation_id: message.correlation_id,
      operation_id: operationId,
      payload: message,
      result,
    });
    return result;
  });
}
