import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
  boolean,
  primaryKey,
  foreignKey,
} from 'drizzle-orm/pg-core';

const audit = pgSchema('price_audit');
const instant = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });
export const exportStatus = audit.enum('export_job_status', [
  'QUEUED',
  'PROCESSING',
  'COMPLETED',
  'FAILED_GENERAL',
]);
export const inbox = audit.table(
  'inbox',
  {
    id: uuid('id').notNull().defaultRandom(),
    messageId: uuid('message_id').notNull(),
    handler: text('handler').notNull(),
    eventName: text('event_name').notNull(),
    correlationId: uuid('correlation_id'),
    payload: jsonb('payload').notNull(),
    result: text('result').notNull(),
    processedAt: instant('processed_at').notNull().defaultNow(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_inbox', columns: [t.id] }),
    unique('uq_inbox_message_handler').on(t.messageId, t.handler),
  ],
);

export const auditLog = audit.table(
  'price_audit_log',
  {
    id: uuid('id_auditoria').notNull().defaultRandom(),
    inboxId: uuid('inbox_id').notNull(),
    targetType: text('target_type').notNull().default('SKU'),
    sku: text('sku'),
    productId: text('product_id').notNull(),
    priceType: text('tipo_precio').notNull(),
    previous: numeric('precio_anterior'),
    next: numeric('precio_nuevo'),
    variation: numeric('variacion_porcentual'),
    operation: text('tipo_operacion').notNull(),
    channel: text('canal_origen'),
    reason: text('motivo_cambio').notNull(),
    batchId: uuid('batch_id'),
    userId: text('usuario_id'),
    email: text('usuario_email'),
    ip: text('ip_origen'),
    at: instant('timestamp').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_price_audit_log', columns: [t.id] }),
    foreignKey({
      name: 'fk_price_audit_log_inbox_id',
      columns: [t.inboxId],
      foreignColumns: [inbox.id],
    }).onDelete('restrict'),
    index('ix_price_audit_log_inbox_id').on(t.inboxId),
    index('ix_price_audit_log_timestamp').on(t.at.desc(), t.id.desc()),
    index('ix_price_audit_log_sku_timestamp').on(
      t.sku,
      t.at.desc(),
      t.id.desc(),
    ),
    index('ix_price_audit_log_user_timestamp').on(t.userId, t.at.desc()),
    index('ix_price_audit_log_canal_timestamp').on(t.channel, t.at.desc()),
    index('ix_price_audit_log_batch_timestamp').on(t.batchId, t.at.desc()),
    check(
      'ck_price_audit_log_target',
      sql`(${t.targetType} = 'PRODUCTO' AND ${t.sku} IS NULL) OR (${t.targetType} = 'SKU' AND ${t.sku} IS NOT NULL AND length(${t.sku}) > 0)`,
    ),
    check(
      'ck_price_audit_log_type',
      sql`${t.priceType} IN ('REGULAR','OFERTA')`,
    ),
    check(
      'ck_price_audit_log_operation',
      sql`${t.operation} IN ('CREACION','MODIFICACION','RETIRO_OFERTA')`,
    ),
    check('ck_price_audit_log_motivo', sql`length(btrim(${t.reason})) > 0`),
    check(
      'ck_price_audit_log_amounts',
      sql`(${t.previous} IS NULL OR (${t.previous} >= 0 AND ${t.previous} <> 'NaN'::numeric)) AND (${t.next} IS NULL OR (${t.next} >= 0 AND ${t.next} <> 'NaN'::numeric)) AND (${t.variation} IS NULL OR ${t.variation} NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric))`,
    ),
    check(
      'ck_price_audit_log_null_semantics',
      sql`(${t.operation} = 'CREACION' AND ${t.previous} IS NULL AND ${t.next} IS NOT NULL AND ${t.variation} IS NULL) OR (${t.operation} = 'MODIFICACION' AND ${t.previous} IS NOT NULL AND ${t.next} IS NOT NULL AND (${t.previous} = 0 OR ${t.variation} IS NOT NULL)) OR (${t.operation} = 'RETIRO_OFERTA' AND ${t.priceType} = 'OFERTA' AND ${t.previous} IS NOT NULL AND ${t.next} IS NULL AND ${t.variation} IS NULL)`,
    ),
  ],
);
export const exportJobs = audit.table(
  'export_jobs',
  {
    id: uuid('id').notNull().defaultRandom(),
    status: exportStatus('status').notNull().default('QUEUED'),
    format: text('formato').notNull(),
    filters: jsonb('filters').notNull(),
    recordCount: integer('record_count').notNull(),
    userId: text('usuario_id'),
    downloadUrl: text('download_url'),
    completedAt: instant('completed_at'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_export_jobs', columns: [t.id] }),
    index('ix_export_jobs_worker')
      .on(t.createdAt)
      .where(sql`${t.status} IN ('QUEUED','PROCESSING')`),
    check('ck_export_jobs_format', sql`${t.format} IN ('CSV','PDF')`),
    check('ck_export_jobs_filters', sql`jsonb_typeof(${t.filters}) = 'object'`),
    check(
      'ck_export_jobs_limit',
      sql`${t.recordCount} >= 0 AND ((${t.format} = 'CSV' AND ${t.recordCount} <= 100000) OR (${t.format} = 'PDF' AND ${t.recordCount} <= 500))`,
    ),
  ],
);
export const archiveManifests = audit.table(
  'archive_manifests',
  {
    id: uuid('id').notNull().defaultRandom(),
    start: instant('range_start').notNull(),
    end: instant('range_end').notNull(),
    objectUri: text('object_uri').notNull(),
    recordCount: integer('record_count').notNull(),
    checksum: text('checksum').notNull(),
    verifiedCount: integer('verified_count'),
    verifiedChecksum: text('verified_checksum'),
    verifiedAt: instant('verified_at'),
    recoverable: boolean('recoverable').notNull().default(false),
    purgedAt: instant('purged_at'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_archive_manifests', columns: [t.id] }),
    index('ix_archive_manifests_range').on(t.start, t.end),
    check('ck_archive_manifests_range', sql`${t.end} > ${t.start}`),
    check(
      'ck_archive_manifests_count',
      sql`${t.recordCount} > 0 AND (${t.verifiedCount} IS NULL OR ${t.verifiedCount} >= 0)`,
    ),
    check(
      'ck_archive_manifests_verified',
      sql`${t.verifiedAt} IS NULL OR (${t.verifiedCount} IS NOT NULL AND ${t.verifiedCount} = ${t.recordCount} AND ${t.verifiedChecksum} IS NOT NULL AND ${t.verifiedChecksum} = ${t.checksum} AND ${t.recoverable})`,
    ),
    check(
      'ck_archive_manifests_purged',
      sql`${t.purgedAt} IS NULL OR ${t.verifiedAt} IS NOT NULL`,
    ),
  ],
);
export const auditSchema = { inbox, auditLog, exportJobs, archiveManifests };
