import {
  pgSchema,
  uuid,
  text,
  numeric,
  char,
  bigint,
  timestamp,
  integer,
  boolean,
  jsonb,
  primaryKey,
  foreignKey,
  unique,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const combosSchema = pgSchema('combos');
export const combos = combosSchema.table(
  'combos',
  {
    id: uuid('id').defaultRandom().notNull(),
    name: text('name').notNull(),
    description: text('description'),
    comboPrice: numeric('combo_price', { precision: 12, scale: 2 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    status: combosSchema
      .enum('combo_status', ['ACTIVO', 'INACTIVO'])('status')
      .notNull()
      .default('ACTIVO'),
    version: bigint('version', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_combos', columns: [t.id] }),
    index('ix_combos_status').on(t.status),
    check('ck_combos_name_not_blank', sql`btrim(${t.name}) <> ''`),
    check(
      'ck_combos_combo_price_positive',
      sql`${t.comboPrice} > 0 AND ${t.comboPrice} <> 'NaN'::numeric`,
    ),
    check(
      'ck_combos_currency_not_blank',
      sql`btrim(${t.currency}::text) <> ''`,
    ),
    check('ck_combos_version_non_negative', sql`${t.version} >= 0`),
  ],
);

export const comboItems = combosSchema.table(
  'combo_items',
  {
    id: uuid('id').defaultRandom().notNull(),
    comboId: uuid('combo_id').notNull(),
    sku: text('sku').notNull(),
    quantity: integer('quantity').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_combo_items', columns: [t.id] }),
    foreignKey({
      name: 'fk_combo_items_combo_id',
      columns: [t.comboId],
      foreignColumns: [combos.id],
    }).onDelete('cascade'),
    unique('uq_combo_items_combo_sku').on(t.comboId, t.sku),
    index('ix_combo_items_sku').on(t.sku),
    check('ck_combo_items_sku_not_blank', sql`btrim(${t.sku}) <> ''`),
    check('ck_combo_items_quantity_positive', sql`${t.quantity} > 0`),
  ],
);

export const componentProjection = combosSchema.table(
  'component_projection',
  {
    id: uuid('id').defaultRandom().notNull(),
    comboItemId: uuid('combo_item_id').notNull(),
    catalogDeactivated: boolean('catalog_deactivated').notNull(),
    catalogObservedAt: timestamp('catalog_observed_at', { withTimezone: true }),
    projectedAvailable: integer('projected_available'),
    inventoryObservedAt: timestamp('inventory_observed_at', {
      withTimezone: true,
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_component_projection', columns: [t.id] }),
    foreignKey({
      name: 'fk_component_projection_combo_item_id',
      columns: [t.comboItemId],
      foreignColumns: [comboItems.id],
    }).onDelete('cascade'),
    unique('uq_component_projection_combo_item_id').on(t.comboItemId),
    check(
      'ck_component_projection_available_non_negative',
      sql`${t.projectedAvailable} IS NULL OR ${t.projectedAvailable} >= 0`,
    ),
  ],
);

export const outbox = combosSchema.table(
  'outbox',
  {
    id: uuid('id').defaultRandom().notNull(),
    messageId: text('message_id').notNull().unique('uq_outbox_message_id'),
    eventName: text('event_name').notNull(),
    kind: text('kind').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    correlationId: text('correlation_id').notNull(),
    causationId: text('causation_id'),
    operationId: uuid('operation_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    payload: jsonb('payload').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_outbox', columns: [t.id] }),
    index('ix_outbox_pending').on(t.publishedAt, t.occurredAt),
    check('ck_outbox_message_id_not_blank', sql`btrim(${t.messageId}) <> ''`),
    check('ck_outbox_event_name_not_blank', sql`btrim(${t.eventName}) <> ''`),
    check('ck_outbox_kind', sql`${t.kind} IN ('command', 'event', 'result')`),
    check('ck_outbox_schema_version', sql`${t.schemaVersion} >= 1`),
    check(
      'ck_outbox_correlation_id_not_blank',
      sql`btrim(${t.correlationId}) <> ''`,
    ),
    check(
      'ck_outbox_payload_object',
      sql`jsonb_typeof(${t.payload}) = 'object'`,
    ),
    check('ck_outbox_attempts', sql`${t.attempts} >= 0`),
  ],
);

export const inbox = combosSchema.table(
  'inbox',
  {
    id: uuid('id').defaultRandom().notNull(),
    messageId: text('message_id').notNull(),
    handler: text('handler').notNull(),
    eventName: text('event_name').notNull(),
    correlationId: text('correlation_id').notNull(),
    operationId: uuid('operation_id'),
    payload: jsonb('payload').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    result: text('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_inbox', columns: [t.id] }),
    unique('uq_inbox_message_handler').on(t.messageId, t.handler),
    check('ck_inbox_message_id_not_blank', sql`btrim(${t.messageId}) <> ''`),
    check('ck_inbox_handler_not_blank', sql`btrim(${t.handler}) <> ''`),
    check('ck_inbox_event_name_not_blank', sql`btrim(${t.eventName}) <> ''`),
    check(
      'ck_inbox_correlation_id_not_blank',
      sql`btrim(${t.correlationId}) <> ''`,
    ),
    check(
      'ck_inbox_payload_object',
      sql`jsonb_typeof(${t.payload}) = 'object'`,
    ),
    check('ck_inbox_result_not_blank', sql`btrim(${t.result}) <> ''`),
  ],
);

export const combosTables = {
  combos,
  comboItems,
  componentProjection,
  inbox,
  outbox,
};
