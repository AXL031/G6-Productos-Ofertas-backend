import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import {
  pgSchema,
  text,
  uuid,
  integer,
  timestamp,
  primaryKey,
  foreignKey,
  check,
  index,
} from 'drizzle-orm/pg-core';
import { outbox } from '../persistence/pricing.schema.js';
import type { PricingTransaction } from '../persistence/pricing.database.js';
import { PricingRepository } from '../persistence/pricing.repository.js';

export const AUDIT_PILOT_QUEUE = 'g6.price-audit.from.pricing';
const schema = pgSchema('pricing');
export const outboxDeliveries = schema.table(
  'outbox_delivery',
  {
    messageId: uuid('message_id').notNull(),
    destination: text('destination').notNull(),
    routeVersion: integer('route_version').notNull(),
    transport: text('transport').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    leaseToken: uuid('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    lastError: text('last_error'),
  },
  (t) => [
    primaryKey({
      name: 'pk_outbox_delivery',
      columns: [t.messageId, t.destination],
    }),
    foreignKey({
      name: 'fk_delivery_outbox',
      columns: [t.messageId],
      foreignColumns: [outbox.messageId],
    }),
    check(
      'ck_delivery_route',
      sql`${t.routeVersion} = 1 AND ${t.destination} = 'g6.price-audit.from.pricing' AND ${t.transport} = 'AZURE_SERVICE_BUS'`,
    ),
    check('ck_delivery_attempts', sql`${t.attempts} >= 0`),
    check(
      'ck_delivery_lease',
      sql`(${t.leaseToken} IS NULL) = (${t.leaseUntil} IS NULL)`,
    ),
    index('ix_delivery_pending')
      .on(t.nextAttemptAt, t.createdAt)
      .where(sql`${t.sentAt} IS NULL`),
  ],
);

// Must be called with the same transaction that inserts the business fact.
export async function insertPricingFacts(
  tx: PricingTransaction,
  facts: (typeof outbox.$inferInsert)[],
  pilot = false,
): Promise<void> {
  if (!facts.length) return;
  if (!pilot) {
    await tx.insert(outbox).values(facts);
    return;
  }
  if (
    facts.some(
      (fact) =>
        fact.eventName !== 'pricing.price.changed' || fact.kind !== 'event',
    )
  )
    throw new Error('SERVICE_BUS_PILOT_ROUTE_NOT_APPROVED');
  const stored = await tx.insert(outbox).values(facts).returning();
  await tx.insert(outboxDeliveries).values(
    stored.map((fact) => ({
      messageId: fact.messageId,
      destination: AUDIT_PILOT_QUEUE,
      routeVersion: 1,
      transport: 'AZURE_SERVICE_BUS',
    })),
  );
}

export type PricingDeliveryClaim = {
  token: string;
  destination: string;
  row: typeof outbox.$inferSelect;
};

export class PricingDeliveryStore {
  constructor(private readonly repository: PricingRepository) {}

  claim(): Promise<PricingDeliveryClaim | undefined> {
    return this.repository.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(outboxDeliveries)
        .where(
          and(
            isNull(outboxDeliveries.sentAt),
            lte(outboxDeliveries.nextAttemptAt, sql`clock_timestamp()`),
            or(
              isNull(outboxDeliveries.leaseUntil),
              lte(outboxDeliveries.leaseUntil, sql`clock_timestamp()`),
            ),
          ),
        )
        .orderBy(
          asc(outboxDeliveries.nextAttemptAt),
          asc(outboxDeliveries.createdAt),
          asc(outboxDeliveries.messageId),
        )
        .limit(1)
        .for('update', { skipLocked: true });
      if (!candidate) return undefined;
      if (
        candidate.destination !== AUDIT_PILOT_QUEUE ||
        candidate.routeVersion !== 1 ||
        candidate.transport !== 'AZURE_SERVICE_BUS'
      )
        throw new Error('SERVICE_BUS_PILOT_ROUTE_NOT_APPROVED');
      const [row] = await tx
        .select()
        .from(outbox)
        .where(eq(outbox.messageId, candidate.messageId));
      if (
        !row ||
        row.eventName !== 'pricing.price.changed' ||
        row.kind !== 'event'
      )
        throw new Error('SERVICE_BUS_PILOT_FACT_INVALID');
      const token = randomUUID();
      await tx
        .update(outboxDeliveries)
        .set({
          leaseToken: token,
          leaseUntil: sql`clock_timestamp() + interval '30 seconds'`,
          attempts: sql`${outboxDeliveries.attempts} + 1`,
        })
        .where(
          and(
            eq(outboxDeliveries.messageId, row.messageId),
            eq(outboxDeliveries.destination, candidate.destination),
          ),
        );
      return { row, token, destination: candidate.destination };
    });
  }

  finish(claim: PricingDeliveryClaim, confirmed: boolean): Promise<boolean> {
    return this.repository.transaction(async (tx) => {
      const updated = await tx
        .update(outboxDeliveries)
        .set({
          leaseToken: null,
          leaseUntil: null,
          sentAt: confirmed ? sql`clock_timestamp()` : null,
          lastError: confirmed ? null : 'SEND_NOT_CONFIRMED',
          nextAttemptAt: confirmed
            ? sql`clock_timestamp()`
            : sql`clock_timestamp() + make_interval(secs => least(60, power(2, least(${outboxDeliveries.attempts}, 6)))::int)`,
        })
        .where(
          and(
            eq(outboxDeliveries.messageId, claim.row.messageId),
            eq(outboxDeliveries.destination, claim.destination),
            eq(outboxDeliveries.leaseToken, claim.token),
            sql`${outboxDeliveries.leaseUntil} > clock_timestamp()`,
            isNull(outboxDeliveries.sentAt),
          ),
        )
        .returning({ id: outboxDeliveries.messageId });
      return updated.length === 1;
    });
  }
}
