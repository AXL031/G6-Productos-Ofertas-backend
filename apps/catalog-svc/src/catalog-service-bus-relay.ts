import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { CatalogEnvelope } from './catalog-messages.js';
import type { CatalogServiceBus } from './catalog-service-bus.js';
import type { Database } from './database.js';

export async function relayCatalogDelivery(
  database: Pick<Database, 'transaction'>,
  bus: Pick<CatalogServiceBus, 'publish'>,
): Promise<'EMPTY' | 'CONFIRMED' | 'RETRY' | 'LEASE_LOST'> {
  const lease = randomUUID();
  const {
    rows: [delivery],
  } = await database.transaction((tx) =>
    tx.execute<{
      destination: string;
      envelope: CatalogEnvelope;
    }>(sql`
    WITH candidate AS (
      SELECT message_id, destination
      FROM catalog.outbox_delivery
      WHERE published_at IS NULL AND available_at <= now()
      ORDER BY available_at, created_at, message_id, destination
      LIMIT 1 FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE catalog.outbox_delivery d
      SET attempts = d.attempts + 1, lease_token = ${lease},
          available_at = now() + interval '60 seconds'
      FROM candidate c
      WHERE d.message_id = c.message_id AND d.destination = c.destination
      RETURNING d.message_id, d.destination
    )
    SELECT c.destination, jsonb_build_object(
      'message_id', o.message_id, 'schema_version', o.schema_version,
      'occurred_at', o.occurred_at, 'correlation_id', o.correlation_id,
      'causation_id', o.causation_id, 'operation_id', o.operation_id,
      'producer', 'catalog-svc', 'kind', o.kind, 'name', o.event_name,
      'data', o.payload
    ) AS envelope
    FROM claimed c JOIN catalog.outbox o USING (message_id)
  `),
  );
  if (!delivery) return 'EMPTY';

  let confirmed = false;
  try {
    // Use the same canonical UTC timestamp as RabbitMQ and every subsequent attempt.
    delivery.envelope.occurred_at = new Date(
      delivery.envelope.occurred_at,
    ).toISOString();
    await bus.publish(
      delivery.destination,
      delivery.envelope,
      AbortSignal.timeout(15_000),
    );
    confirmed = true;
  } catch {
    // A timeout is ambiguous. Keep the same message identifier for redelivery.
  }

  const result = await database.transaction((tx) =>
    tx.execute(sql`
    UPDATE catalog.outbox_delivery
    SET lease_token = NULL,
        published_at = ${confirmed ? sql`now()` : sql`NULL`},
        last_error = ${confirmed ? null : 'SERVICE_BUS_PUBLISH_UNCONFIRMED'}
    WHERE message_id = ${delivery.envelope.message_id}
      AND destination = ${delivery.destination}
      AND lease_token = ${lease}
  `),
  );
  if (result.rowCount !== 1) return 'LEASE_LOST';
  return confirmed ? 'CONFIRMED' : 'RETRY';
}
