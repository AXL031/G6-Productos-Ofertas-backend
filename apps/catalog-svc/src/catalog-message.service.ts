import { Injectable, Optional } from '@nestjs/common';
import { CatalogTelemetry } from './catalog-telemetry.js';
import { consumeMasterMessage } from './catalog-master-message.js';
import { and, asc, eq, isNull, lt } from 'drizzle-orm';
import { Database } from './database.js';
import {
  activationChecks,
  inbox,
  outbox,
  products,
  masterBarriers,
} from './catalog.schema.js';
import {
  activeAttempt,
  BlockedCatalogHandler,
  InvalidCatalogMessage,
  UnresolvedCatalogAttempt,
  preparationResults,
  type CatalogEnvelope,
} from './catalog-messages.js';

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
export interface CatalogPublisher {
  publish(message: CatalogEnvelope): Promise<void>;
}
@Injectable()
export class CatalogMessageService {
  private lastBarrierReport = Date.now();
  constructor(
    private readonly database: Database,
    @Optional()
    private readonly telemetry: CatalogTelemetry = new CatalogTelemetry(),
  ) {}

  async consume(
    message: CatalogEnvelope,
  ): Promise<'APPLIED' | 'STALE' | 'TERMINAL' | 'DUPLICATE' | 'BLOCKED'> {
    if (message.name.startsWith('taxonomy.master.'))
      return consumeMasterMessage(this.database, message, this.telemetry);
    if (!(preparationResults as readonly string[]).includes(message.name))
      throw new BlockedCatalogHandler();
    const result = await this.database.transaction(async (tx) => {
      const [hint] = await tx
        .select()
        .from(activationChecks)
        .where(eq(activationChecks.operation_id, message.operation_id!))
        .limit(1);
      if (!hint) throw new InvalidCatalogMessage();
      await tx
        .select({ id: products.id })
        .from(products)
        .where(eq(products.id, hint.product_id))
        .for('update');
      const [check] = await tx
        .select()
        .from(activationChecks)
        .where(eq(activationChecks.id, hint.id))
        .for('update');
      if (!check) throw new InvalidCatalogMessage();
      const dependency = message.name.startsWith('pricing.')
        ? 'PRICING'
        : 'INVENTORY';
      const data = message.data;
      if (
        check.dependency !== dependency ||
        data.product_id !== check.product_id ||
        (dependency === 'PRICING'
          ? data.sku_base !== check.sku
          : data.sku !== check.sku ||
            (data.variant_id ?? null) !== check.variant_id)
      )
        throw new InvalidCatalogMessage();
      const attempts = await tx
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.operation_id, check.operation_id),
            eq(
              outbox.event_name,
              dependency === 'PRICING'
                ? 'pricing.product.initialization.requested'
                : 'inventory.sku.initialization.requested',
            ),
          ),
        );
      const active = activeAttempt(attempts);
      // Historical checks without a reconstructible request cannot accept arbitrary results.
      if (!active) throw new UnresolvedCatalogAttempt();
      if (
        message.causation_id === active.message_id &&
        message.correlation_id !== active.correlation_id
      )
        throw new InvalidCatalogMessage();
      const result =
        message.causation_id !== active.message_id
          ? 'STALE'
          : check.state === 'COMPLETED'
            ? 'TERMINAL'
            : 'APPLIED';
      const handler = 'catalog.preparation-results.v1';
      const inserted = await tx
        .insert(inbox)
        .values({
          message_id: message.message_id,
          handler,
          event_name: message.name,
          correlation_id: message.correlation_id,
          operation_id: message.operation_id,
          payload: message,
          result,
        })
        .onConflictDoNothing({ target: [inbox.message_id, inbox.handler] })
        .returning({ id: inbox.id });
      if (!inserted.length) {
        const [previous] = await tx
          .select({ payload: inbox.payload })
          .from(inbox)
          .where(
            and(
              eq(inbox.message_id, message.message_id),
              eq(inbox.handler, handler),
            ),
          );
        if (canonical(previous?.payload) !== canonical(message))
          throw new InvalidCatalogMessage();
        return 'DUPLICATE';
      }
      if (result === 'APPLIED')
        await tx
          .update(activationChecks)
          .set({
            state: message.name.endsWith('.completed')
              ? 'COMPLETED'
              : 'REJECTED',
            result_payload: data,
            result_message_id: message.message_id,
          })
          .where(eq(activationChecks.id, check.id));
      return result;
    });
    this.telemetry.record(`INBOX_${result}`, {
      correlationId: message.correlation_id,
      operationId: message.operation_id ?? undefined,
      messageId: message.message_id,
    });
    return result;
  }

  /** One row lock per confirmed publish; a crash before commit leaves the immutable message pending. */
  async relayOne(
    publisher: CatalogPublisher,
  ): Promise<'PUBLISHED' | 'PENDING' | 'EMPTY'> {
    // Diagnostic cadence only. Never releases a barrier or resolves an operation.
    if (Date.now() - this.lastBarrierReport >= 60000) {
      const pending = await this.database.read((db) =>
        db
          .select({ operationId: masterBarriers.operation_id })
          .from(masterBarriers)
          .where(
            and(
              eq(masterBarriers.is_blocking, true),
              lt(masterBarriers.created_at, new Date(Date.now() - 60000)),
            ),
          )
          .limit(100),
      );
      this.lastBarrierReport = Date.now();
      for (const row of pending)
        this.telemetry.record('MASTER_BARRIER_FINAL_PENDING', row);
    }
    const result = await this.database.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(outbox)
        .where(isNull(outbox.published_at))
        .orderBy(asc(outbox.occurred_at), asc(outbox.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return 'EMPTY';
      const message: CatalogEnvelope = {
        message_id: row.message_id,
        schema_version: row.schema_version,
        occurred_at: row.occurred_at.toISOString(),
        correlation_id: row.correlation_id,
        causation_id: row.causation_id,
        operation_id: row.operation_id,
        producer: 'catalog-svc',
        kind: row.kind as CatalogEnvelope['kind'],
        name: row.event_name,
        data: row.payload,
      };
      try {
        await publisher.publish(message);
      } catch {
        await tx
          .update(outbox)
          .set({
            attempts: row.attempts + 1,
            last_error: 'BROKER_PUBLISH_UNCONFIRMED',
          })
          .where(eq(outbox.id, row.id));
        return 'PENDING';
      }
      await tx
        .update(outbox)
        .set({
          published_at: new Date(),
          attempts: row.attempts + 1,
          last_error: null,
        })
        .where(eq(outbox.id, row.id));
      return 'PUBLISHED';
    });
    if (result !== 'EMPTY')
      this.telemetry.record(
        result === 'PUBLISHED' ? 'OUTBOX_PUBLISHED' : 'OUTBOX_PENDING',
      );
    return result;
  }
}
