import { and, eq, sql } from 'drizzle-orm';
import type { Database } from './database.js';
import { inbox } from './catalog.schema.js';
import {
  InvalidCatalogMessage,
  parseCatalogMessage,
  type CatalogEnvelope,
} from './catalog-messages.js';
import {
  taxonomyUpdate,
  taxonomyUpdateHandler,
} from './catalog-taxonomy-update.js';

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

export async function consumeTaxonomyUpdate(
  database: Database,
  input: CatalogEnvelope,
) {
  const message = parseCatalogMessage(input);
  const update = taxonomyUpdate(message.name, message.data);
  if (!update) throw new InvalidCatalogMessage();
  return database.transaction(async (tx) => {
    // Serialize deliveries of a master, including the first delivery when no row exists.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${'catalog-taxonomy-update:' + update.key}, 0))`,
    );
    const [seen] = await tx
      .select()
      .from(inbox)
      .where(
        and(
          eq(inbox.message_id, message.message_id),
          eq(inbox.handler, taxonomyUpdateHandler),
        ),
      );
    if (seen) {
      if (canonical(seen.payload) !== canonical(message))
        throw new InvalidCatalogMessage();
      return 'DUPLICATE' as const;
    }
    const coordinate =
      message.name === 'taxonomy.category.updated'
        ? sql`${inbox.payload} #>> '{data,categoria_id}' = ${message.data.categoria_id}`
        : message.name === 'taxonomy.product-type-schema.changed'
          ? sql`${inbox.payload} #>> '{data,tipo_producto_id}' = ${message.data.tipo_producto_id}`
          : sql`${inbox.payload} #>> '{data,caracteristica_id}' = ${message.data.caracteristica_id}
          AND ${inbox.payload} #>> '{data,valor_id}' = ${message.data.valor_id}`;
    const revision =
      message.name === 'taxonomy.category.updated'
        ? sql`(${inbox.payload} #>> '{data,version}')::bigint`
        : message.name === 'taxonomy.product-type-schema.changed'
          ? sql`(${inbox.payload} #>> '{data,schema_version}')::bigint`
          : sql`(${inbox.payload} #>> '{data,updated_at}')::timestamptz`;
    const [latest] = await tx
      .select({ payload: inbox.payload })
      .from(inbox)
      .where(
        and(
          eq(inbox.handler, taxonomyUpdateHandler),
          eq(inbox.event_name, message.name),
          eq(inbox.result, 'APPLIED'),
          coordinate,
        ),
      )
      .orderBy(sql`${revision} DESC`)
      .limit(1);
    let result: 'APPLIED' | 'STALE' = 'APPLIED';
    if (latest) {
      const previous = parseCatalogMessage(latest.payload);
      const previousUpdate = taxonomyUpdate(previous.name, previous.data)!;
      if (
        update.revision === previousUpdate.revision &&
        canonical(message.data) !== canonical(previous.data)
      )
        throw new InvalidCatalogMessage();
      if (update.revision <= previousUpdate.revision) result = 'STALE';
    }
    const inserted = await tx
      .insert(inbox)
      .values({
        message_id: message.message_id,
        handler: taxonomyUpdateHandler,
        event_name: message.name,
        correlation_id: message.correlation_id,
        operation_id: message.operation_id,
        payload: message,
        result,
      })
      .onConflictDoNothing({ target: [inbox.message_id, inbox.handler] })
      .returning({ id: inbox.id });
    if (!inserted.length) {
      // Covers a reused message_id on a different entity (a different advisory lock).
      const [concurrent] = await tx
        .select()
        .from(inbox)
        .where(
          and(
            eq(inbox.message_id, message.message_id),
            eq(inbox.handler, taxonomyUpdateHandler),
          ),
        );
      if (canonical(concurrent?.payload) !== canonical(message))
        throw new InvalidCatalogMessage();
      return 'DUPLICATE' as const;
    }
    // Category/schema data are resolved by live Taxonomy HTTP reads. No local cache,
    // product state, preparation, historical snapshot or master barrier is rewritten.
    // LISTA labels are projected from the committed Inbox by currentTaxonomyValue.
    return result;
  });
}
