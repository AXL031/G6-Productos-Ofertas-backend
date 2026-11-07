import { jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { products } from './catalog.schema.js';

/** Additive candidate migration 0004; existing migration history stays immutable. */
export const historicalRequests = pgSchema('catalog').table(
  'historical_preparation_requests',
  {
    request_id: uuid('request_id').primaryKey(),
    product_id: uuid('product_id')
      .notNull()
      .references(() => products.id),
    actor_subject: uuid('actor_subject').notNull(),
    correlation_id: uuid('correlation_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    selection: jsonb('selection').$type<Record<string, unknown>>().notNull(),
    response_payload: jsonb('response_payload')
      .$type<HistoricalRecoveryAccepted>()
      .notNull(),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);

/** CONTRATO_CANDIDATO: these HTTP fields are not claimed as published OpenAPI. */
export interface HistoricalRecoveryAccepted {
  operation_id: string;
  status: 'ACCEPTED';
  correlation_id: string;
  preparaciones: Array<{
    dependencia: 'PRICING' | 'INVENTARIO';
    sku: string;
    variant_id: string | null;
    operation_id: string;
  }>;
}
