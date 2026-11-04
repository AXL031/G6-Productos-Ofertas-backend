import {
  boolean,
  check,
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
import { sql } from 'drizzle-orm';

export const bulk = pgSchema('bulk');

export const jobStatus = bulk.enum('job_status', [
  'QUEUED',
  'PROCESSING',
  'COMPLETED',
  'FAILED_GENERAL',
]);
export const rowStatus = bulk.enum('row_status', [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
]);
export const stepStatus = bulk.enum('step_status', [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
]);

const tz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });

export const fileManifests = bulk.table(
  'file_manifests',
  {
    id: uuid('id').defaultRandom().notNull(),
    role: text('role').notNull(),
    format: text('format').notNull(),
    contentRef: text('content_ref').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_file_manifests', columns: [t.id] }),
    check(
      'ck_file_manifests_role',
      sql`${t.role} IN ('ENTRADA_IMPORTACION','REPORTE_IMPORTACION','RESULTADO_EXPORTACION')`,
    ),
    check('ck_file_manifests_format', sql`${t.format} IN ('CSV','XLSX')`),
    check(
      'ck_file_manifests_report_csv',
      sql`${t.role} <> 'REPORTE_IMPORTACION' OR ${t.format} = 'CSV'`,
    ),
  ],
);

export const batchJobs = bulk.table(
  'batch_jobs',
  {
    id: uuid('id').defaultRandom().notNull(),
    batchId: uuid('batch_id').notNull(),
    inputFileId: uuid('input_file_id').notNull(),
    reportFileId: uuid('report_file_id'),
    status: jobStatus('status').notNull().default('QUEUED'),
    templateVersion: integer('template_version').notNull(),
    correlationId: uuid('correlation_id').notNull(),
    totalRows: integer('total_rows').notNull().default(0),
    completedRows: integer('completed_rows').notNull().default(0),
    failedRows: integer('failed_rows').notNull().default(0),
    needsReconciliation: boolean('needs_reconciliation')
      .notNull()
      .default(false),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_batch_jobs', columns: [t.id] }),
    foreignKey({
      name: 'fk_batch_jobs_input_file_id',
      columns: [t.inputFileId],
      foreignColumns: [fileManifests.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_batch_jobs_report_file_id',
      columns: [t.reportFileId],
      foreignColumns: [fileManifests.id],
    }).onDelete('restrict'),
    unique('uq_batch_jobs_batch_id').on(t.batchId),
    unique('uq_batch_jobs_report_file_id').on(t.reportFileId),
    check('ck_batch_jobs_template_version', sql`${t.templateVersion} > 0`),
    check('ck_batch_jobs_total_rows', sql`${t.totalRows} >= 0`),
    check('ck_batch_jobs_completed_rows', sql`${t.completedRows} >= 0`),
    check('ck_batch_jobs_failed_rows', sql`${t.failedRows} >= 0`),
    check(
      'ck_batch_jobs_completed_lte_total',
      sql`${t.completedRows} <= ${t.totalRows}`,
    ),
    check(
      'ck_batch_jobs_failed_lte_total',
      sql`${t.failedRows} <= ${t.totalRows}`,
    ),
    check(
      'ck_batch_jobs_terminal_lte_total',
      sql`${t.completedRows} + ${t.failedRows} <= ${t.totalRows}`,
    ),
    check(
      'ck_batch_jobs_completed_terminal',
      sql`${t.status} <> 'COMPLETED' OR ${t.completedRows} + ${t.failedRows} = ${t.totalRows}`,
    ),
    check(
      'ck_batch_jobs_completed_reconciliation',
      sql`${t.status} <> 'COMPLETED' OR ${t.needsReconciliation} = (${t.failedRows} > 0)`,
    ),
    index('ix_batch_jobs_input_file_id').on(t.inputFileId),
    index('ix_batch_jobs_status_created_at').on(t.status, t.createdAt),
    index('ix_batch_jobs_reconciliation')
      .on(t.updatedAt)
      .where(sql`${t.needsReconciliation} = true`),
  ],
);

export const batchRows = bulk.table(
  'batch_rows',
  {
    id: uuid('id').defaultRandom().notNull(),
    batchJobId: uuid('batch_job_id').notNull(),
    rowId: uuid('row_id').notNull(),
    status: rowStatus('status').notNull().default('PENDING'),
    requiredDomains: text('required_domains').array().notNull(),
    appliedDomains: text('applied_domains')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    failedDomain: text('failed_domain'),
    needsReconciliation: boolean('needs_reconciliation')
      .notNull()
      .default(false),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_batch_rows', columns: [t.id] }),
    foreignKey({
      name: 'fk_batch_rows_batch_job_id',
      columns: [t.batchJobId],
      foreignColumns: [batchJobs.id],
    }).onDelete('cascade'),
    unique('uq_batch_rows_batch_row').on(t.batchJobId, t.rowId),
    check(
      'ck_batch_rows_required_cardinality',
      sql`cardinality(${t.requiredDomains}) BETWEEN 1 AND 3`,
    ),
    check(
      'ck_batch_rows_required_values',
      sql`${t.requiredDomains} <@ ARRAY['CATALOGO','PRICING','INVENTARIO']::text[]`,
    ),
    check(
      'ck_batch_rows_applied_values',
      sql`${t.appliedDomains} <@ ARRAY['CATALOGO','PRICING','INVENTARIO']::text[]`,
    ),
    check(
      'ck_batch_rows_required_no_null',
      sql`array_position(${t.requiredDomains}, NULL) IS NULL`,
    ),
    check(
      'ck_batch_rows_applied_no_null',
      sql`array_position(${t.appliedDomains}, NULL) IS NULL`,
    ),
    check(
      'ck_batch_rows_required_unique',
      sql`cardinality(${t.requiredDomains}) = CASE WHEN 'CATALOGO' = ANY(${t.requiredDomains}) THEN 1 ELSE 0 END + CASE WHEN 'PRICING' = ANY(${t.requiredDomains}) THEN 1 ELSE 0 END + CASE WHEN 'INVENTARIO' = ANY(${t.requiredDomains}) THEN 1 ELSE 0 END`,
    ),
    check(
      'ck_batch_rows_applied_unique',
      sql`cardinality(${t.appliedDomains}) = CASE WHEN 'CATALOGO' = ANY(${t.appliedDomains}) THEN 1 ELSE 0 END + CASE WHEN 'PRICING' = ANY(${t.appliedDomains}) THEN 1 ELSE 0 END + CASE WHEN 'INVENTARIO' = ANY(${t.appliedDomains}) THEN 1 ELSE 0 END`,
    ),
    check(
      'ck_batch_rows_applied_subset',
      sql`${t.appliedDomains} <@ ${t.requiredDomains}`,
    ),
    check(
      'ck_batch_rows_failed_domain_value',
      sql`${t.failedDomain} IS NULL OR ${t.failedDomain} IN ('CATALOGO','PRICING','INVENTARIO')`,
    ),
    check(
      'ck_batch_rows_failed_domain_required',
      sql`${t.failedDomain} IS NULL OR ${t.failedDomain} = ANY(${t.requiredDomains})`,
    ),
    check(
      'ck_batch_rows_failed_domain_not_applied',
      sql`${t.failedDomain} IS NULL OR NOT (${t.failedDomain} = ANY(${t.appliedDomains}))`,
    ),
    check(
      'ck_batch_rows_completed_consistency',
      sql`${t.status} <> 'COMPLETED' OR (${t.failedDomain} IS NULL AND ${t.needsReconciliation} = false AND ${t.requiredDomains} <@ ${t.appliedDomains} AND ${t.appliedDomains} <@ ${t.requiredDomains})`,
    ),
    check(
      'ck_batch_rows_failed_has_domain',
      sql`${t.status} <> 'FAILED' OR ${t.failedDomain} IS NOT NULL`,
    ),
    check(
      'ck_batch_rows_failed_domain_requires_failed',
      sql`${t.failedDomain} IS NULL OR ${t.status} = 'FAILED'`,
    ),
    check(
      'ck_batch_rows_reconciliation',
      sql`${t.needsReconciliation} = false OR (${t.status} = 'FAILED' AND cardinality(${t.appliedDomains}) > 0)`,
    ),
    index('ix_batch_rows_batch_status').on(t.batchJobId, t.status),
    index('ix_batch_rows_reconciliation')
      .on(t.batchJobId)
      .where(sql`${t.needsReconciliation} = true`),
    index('ix_batch_rows_failed_domain')
      .on(t.batchJobId, t.failedDomain)
      .where(sql`${t.failedDomain} IS NOT NULL`),
  ],
);

export const rowDomainSteps = bulk.table(
  'row_domain_steps',
  {
    id: uuid('id').defaultRandom().notNull(),
    batchRowId: uuid('batch_row_id').notNull(),
    domain: text('domain').notNull(),
    status: stepStatus('status').notNull().default('PENDING'),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_row_domain_steps', columns: [t.id] }),
    foreignKey({
      name: 'fk_row_domain_steps_batch_row_id',
      columns: [t.batchRowId],
      foreignColumns: [batchRows.id],
    }).onDelete('cascade'),
    unique('uq_row_domain_steps_row_domain').on(t.batchRowId, t.domain),
    check(
      'ck_row_domain_steps_domain',
      sql`${t.domain} IN ('CATALOGO','PRICING','INVENTARIO')`,
    ),
    index('ix_row_domain_steps_status_updated_at').on(t.status, t.updatedAt),
  ],
);

export const exportJobs = bulk.table(
  'export_jobs',
  {
    id: uuid('id').defaultRandom().notNull(),
    exportId: uuid('export_id').notNull(),
    status: jobStatus('status').notNull().default('QUEUED'),
    format: text('format').notNull(),
    outputFileId: uuid('output_file_id'),
    createdAt: tz('created_at').notNull().defaultNow(),
    completedAt: tz('completed_at'),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_export_jobs', columns: [t.id] }),
    foreignKey({
      name: 'fk_export_jobs_output_file_id',
      columns: [t.outputFileId],
      foreignColumns: [fileManifests.id],
    }).onDelete('restrict'),
    unique('uq_export_jobs_export_id').on(t.exportId),
    unique('uq_export_jobs_output_file_id').on(t.outputFileId),
    check('ck_export_jobs_format', sql`${t.format} IN ('CSV','XLSX')`),
    check(
      'ck_export_jobs_completed_file',
      sql`${t.status} <> 'COMPLETED' OR (${t.outputFileId} IS NOT NULL AND ${t.completedAt} IS NOT NULL)`,
    ),
    index('ix_export_jobs_status_created_at').on(t.status, t.createdAt),
  ],
);

export const outbox = bulk.table(
  'outbox',
  {
    id: uuid('id').defaultRandom().notNull(),
    messageId: text('message_id').notNull(),
    eventName: text('event_name').notNull(),
    kind: text('kind').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    correlationId: text('correlation_id').notNull(),
    causationId: text('causation_id'),
    operationId: uuid('operation_id'),
    occurredAt: tz('occurred_at').notNull(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
    publishedAt: tz('published_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_outbox', columns: [t.id] }),
    unique('uq_outbox_message_id').on(t.messageId),
    unique('uq_outbox_operation_event').on(t.operationId, t.eventName),
    check('ck_outbox_kind', sql`${t.kind} IN ('command','event','result')`),
    check('ck_outbox_schema_version', sql`${t.schemaVersion} > 0`),
    check('ck_outbox_attempts', sql`${t.attempts} >= 0`),
    index('ix_outbox_pending').on(t.publishedAt, t.occurredAt),
  ],
);

export const inbox = bulk.table(
  'inbox',
  {
    id: uuid('id').defaultRandom().notNull(),
    messageId: text('message_id').notNull(),
    handler: text('handler').notNull(),
    eventName: text('event_name').notNull(),
    correlationId: text('correlation_id'),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
    result: text('result').notNull(),
    processedAt: tz('processed_at').notNull().defaultNow(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_inbox', columns: [t.id] }),
    unique('uq_inbox_message_handler').on(t.messageId, t.handler),
  ],
);

export const bulkSchema = {
  fileManifests,
  batchJobs,
  batchRows,
  rowDomainSteps,
  exportJobs,
  outbox,
  inbox,
};
