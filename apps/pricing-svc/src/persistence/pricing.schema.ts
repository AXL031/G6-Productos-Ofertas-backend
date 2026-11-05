import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

const pricing = pgSchema('pricing');
const instant = (name: string) => timestamp(name, { withTimezone: true });
const timestamps = () => ({
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});

// Validar antes del cast PostgreSQL: numeric(12,2) redondea silenciosamente.
export const money = customType<{ data: string; driverData: string }>({
  dataType: () => 'numeric(12,2)',
  toDriver(value) {
    if (typeof value !== 'string' || !/^-?\d{1,10}(\.\d{1,2})?$/.test(value)) {
      throw new Error('Importe fuera de la precisión numeric(12,2).');
    }
    return value;
  },
});

export const scheduledPriceStatus = pricing.enum('scheduled_price_status', [
  'SCHEDULED',
  'ACTIVE',
  'HISTORICAL',
  'CANCELLED',
]);
export const bulkPriceJobStatus = pricing.enum('bulk_price_job_status', [
  'QUEUED',
  'PROCESSING',
  'COMPLETED',
  'PARTIAL',
  'FAILED',
]);
export const bulkPriceRowStatus = pricing.enum('bulk_price_row_status', [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
]);

export const prices = pricing.table(
  'prices',
  {
    id: uuid('id').notNull().defaultRandom(),
    productId: text('product_id'),
    sku: text('sku'),
    channelId: text('channel_id'),
    priceVersion: bigint('price_version', { mode: 'bigint' })
      .notNull()
      .default(1n),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ name: 'pk_prices', columns: [t.id] }),
    unique('uq_prices_target_channel')
      .on(t.productId, t.sku, t.channelId)
      .nullsNotDistinct(),
    check(
      'ck_prices_target',
      sql`(${t.productId} IS NOT NULL) <> (${t.sku} IS NOT NULL)`,
    ),
    check('ck_prices_version', sql`${t.priceVersion} >= 1`),
  ],
);

export const priceValidities = pricing.table(
  'price_validities',
  {
    id: uuid('id').notNull().defaultRandom(),
    priceId: uuid('price_id').notNull(),
    precioRegular: money('precio_regular').notNull(),
    precioOferta: money('precio_oferta'),
    currency: char('currency', { length: 3 }).notNull(),
    validFrom: instant('valid_from').notNull(),
    validUntil: instant('valid_until'),
    priceVersion: bigint('price_version', { mode: 'bigint' }).notNull(),
    motivoCambio: text('motivo_cambio').notNull(),
    usuarioId: text('usuario_id'),
    isCancelled: boolean('is_cancelled').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ name: 'pk_price_validities', columns: [t.id] }),
    unique('uq_price_validities_id_price').on(t.id, t.priceId),
    unique('uq_price_validities_price_version').on(t.priceId, t.priceVersion),
    foreignKey({
      name: 'fk_price_validities_price_id',
      columns: [t.priceId],
      foreignColumns: [prices.id],
    }).onDelete('restrict'),
    check(
      'ck_price_validities_regular',
      sql`${t.precioRegular} > 0 AND ${t.precioRegular} <> 'NaN'::numeric`,
    ),
    check(
      'ck_price_validities_oferta',
      sql`${t.precioOferta} IS NULL OR (${t.precioOferta} > 0 AND ${t.precioOferta} < ${t.precioRegular})`,
    ),
    check(
      'ck_price_validities_currency',
      sql`length(btrim(${t.currency})) = 3`,
    ),
    check(
      'ck_price_validities_order',
      sql`${t.validUntil} IS NULL OR ${t.validUntil} > ${t.validFrom}`,
    ),
    check('ck_price_validities_version', sql`${t.priceVersion} >= 1`),
    check(
      'ck_price_validities_motivo',
      sql`length(btrim(${t.motivoCambio})) > 0`,
    ),
    index('ix_price_validities_price_id').on(t.priceId, t.validFrom.desc()),
  ],
);
// La exclusion GiST y los triggers diferidos pertenecen al SQL normativo;
// este mapping no genera ni aplica DDL/migraciones.

export const scheduledPrices = pricing.table(
  'scheduled_prices',
  {
    id: uuid('id').notNull().defaultRandom(),
    priceId: uuid('price_id').notNull(),
    validityId: uuid('validity_id').notNull(),
    productId: text('product_id'),
    correlationId: uuid('correlation_id'),
    tipoPrecio: text('tipo_precio').notNull(),
    importe: money('importe').notNull(),
    status: scheduledPriceStatus('status').notNull().default('SCHEDULED'),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ name: 'pk_scheduled_prices', columns: [t.id] }),
    unique('uq_scheduled_prices_validity').on(t.validityId, t.priceId),
    foreignKey({
      name: 'fk_scheduled_prices_validity_price',
      columns: [t.validityId, t.priceId],
      foreignColumns: [priceValidities.id, priceValidities.priceId],
    }).onDelete('restrict'),
    check(
      'ck_scheduled_prices_type',
      sql`${t.tipoPrecio} IN ('REGULAR','OFERTA')`,
    ),
    check(
      'ck_scheduled_prices_importe',
      sql`${t.importe} > 0 AND ${t.importe} <> 'NaN'::numeric`,
    ),
    index('ix_scheduled_prices_price_id').on(t.priceId),
    index('ix_scheduled_prices_worker')
      .on(t.status, t.createdAt)
      .where(sql`${t.status} IN ('SCHEDULED','ACTIVE')`),
  ],
);

export const bulkPriceJobs = pricing.table(
  'bulk_price_jobs',
  {
    id: uuid('id').notNull().defaultRandom(),
    status: bulkPriceJobStatus('status').notNull().default('QUEUED'),
    allowPartial: boolean('allow_partial').notNull(),
    totalRows: integer('total_rows').notNull(),
    completedRows: integer('completed_rows').notNull().default(0),
    failedRows: integer('failed_rows').notNull().default(0),
    correlationId: uuid('correlation_id').notNull(),
    usuarioId: text('usuario_id'),
    reportUri: text('report_uri'),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ name: 'pk_bulk_price_jobs', columns: [t.id] }),
    check(
      'ck_bulk_price_jobs_counts',
      sql`${t.totalRows} >= 0 AND ${t.completedRows} >= 0 AND ${t.failedRows} >= 0 AND ${t.completedRows} + ${t.failedRows} <= ${t.totalRows}`,
    ),
    check(
      'ck_bulk_price_jobs_completed',
      sql`${t.status} <> 'COMPLETED' OR (${t.completedRows} = ${t.totalRows} AND ${t.failedRows} = 0)`,
    ),
    check(
      'ck_bulk_price_jobs_partial',
      sql`${t.status} <> 'PARTIAL' OR (${t.allowPartial} AND ${t.completedRows} > 0 AND ${t.failedRows} > 0 AND ${t.completedRows} + ${t.failedRows} = ${t.totalRows})`,
    ),
    index('ix_bulk_price_jobs_worker')
      .on(t.createdAt)
      .where(sql`${t.status} IN ('QUEUED','PROCESSING')`),
  ],
);

export const bulkPriceRows = pricing.table(
  'bulk_price_rows',
  {
    id: uuid('id').notNull().defaultRandom(),
    batchId: uuid('batch_id').notNull(),
    rowId: text('row_id').notNull(),
    sku: text('sku'),
    status: bulkPriceRowStatus('status').notNull().default('PENDING'),
    code: text('code'),
    detail: text('detail'),
    rowInput: jsonb('row_input').$type<Record<string, unknown>>().notNull(),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ name: 'pk_bulk_price_rows', columns: [t.id] }),
    unique('uq_bulk_price_rows_batch_row').on(t.batchId, t.rowId),
    foreignKey({
      name: 'fk_bulk_price_rows_batch_id',
      columns: [t.batchId],
      foreignColumns: [bulkPriceJobs.id],
    }).onDelete('restrict'),
    check(
      'ck_bulk_price_rows_input',
      sql`jsonb_typeof(${t.rowInput}) = 'object'`,
    ),
  ],
);

export const outbox = pricing.table(
  'outbox',
  {
    id: uuid('id').notNull().defaultRandom(),
    messageId: uuid('message_id').notNull(),
    eventName: text('event_name').notNull(),
    kind: text('kind').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    correlationId: uuid('correlation_id').notNull(),
    causationId: uuid('causation_id'),
    operationId: uuid('operation_id'),
    occurredAt: instant('occurred_at').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    publishedAt: instant('published_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_outbox', columns: [t.id] }),
    unique('uq_outbox_message_id').on(t.messageId),
    check('ck_outbox_kind', sql`${t.kind} IN ('command','event','result')`),
    check('ck_outbox_attempts', sql`${t.attempts} >= 0`),
    check('ck_outbox_schema_version', sql`${t.schemaVersion} >= 1`),
    index('ix_outbox_pending')
      .on(t.occurredAt)
      .where(sql`${t.publishedAt} IS NULL`),
  ],
);

export const inbox = pricing.table(
  'inbox',
  {
    id: uuid('id').notNull().defaultRandom(),
    messageId: uuid('message_id').notNull(),
    handler: text('handler').notNull(),
    eventName: text('event_name').notNull(),
    correlationId: uuid('correlation_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    processedAt: instant('processed_at').notNull().defaultNow(),
    result: text('result').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_inbox', columns: [t.id] }),
    unique('uq_inbox_message_handler').on(t.messageId, t.handler),
  ],
);

export const pricingSchema = {
  prices,
  priceValidities,
  scheduledPrices,
  bulkPriceJobs,
  bulkPriceRows,
  outbox,
  inbox,
};
