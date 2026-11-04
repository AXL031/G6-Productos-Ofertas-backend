import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  batchJobs,
  batchRows,
  exportJobs,
  fileManifests,
  inbox,
  outbox,
  rowDomainSteps,
} from './bulk.schema.js';
import { BULK_DATABASE, type BulkDatabase } from './bulk.database.js';
import {
  BulkPersistenceError,
  persistenceError,
} from './bulk.persistence.errors.js';
import { BulkDomainError } from '../domain/bulk.domain-error.js';
import { matchesBulkStorageReference } from '../storage/bulk-storage-reference.js';

export type BulkDomain = 'CATALOGO' | 'PRICING' | 'INVENTARIO';
export type BulkFileFormat = 'CSV' | 'XLSX';
export type BulkFileRole =
  'ENTRADA_IMPORTACION' | 'REPORTE_IMPORTACION' | 'RESULTADO_EXPORTACION';
export type BulkJobStatus =
  'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED_GENERAL';
export type BulkRowStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
export type BulkStepStatus = BulkRowStatus;

export interface FileManifestInput {
  role: BulkFileRole;
  format: BulkFileFormat;
  contentRef: string;
}
export interface ImportRowInput {
  rowId: string;
  requiredDomains: BulkDomain[];
}
export interface CreateImportBatchInput {
  batchId: string;
  templateVersion: number;
  correlationId: string;
  inputFile: Omit<FileManifestInput, 'role'>;
  rows: ImportRowInput[];
  admissionIntent?: Record<string, unknown>;
  catalogCommands?: OutboxInput[];
}
export interface CreateImportBatchResult {
  manifest: typeof fileManifests.$inferSelect;
  batch: typeof batchJobs.$inferSelect;
  rows: Array<{
    row: typeof batchRows.$inferSelect;
    steps: Array<typeof rowDomainSteps.$inferSelect>;
  }>;
}
export interface WorkflowStepChange {
  domain: BulkDomain;
  status: BulkStepStatus;
  errorCode?: string | null;
  errorDetail?: string | null;
}
export interface UpdateWorkflowStateInput {
  batchId: string;
  rowId: string;
  steps: WorkflowStepChange[];
  status: BulkRowStatus;
  failedDomain?: BulkDomain | null;
  needsReconciliation?: boolean;
  errorCode?: string | null;
  errorDetail?: string | null;
}
export interface CreateExportJobInput {
  exportId: string;
  format: BulkFileFormat;
}
export interface OutboxInput {
  messageId: string;
  eventName: string;
  kind: 'command' | 'event' | 'result';
  schemaVersion?: number;
  correlationId: string;
  causationId?: string | null;
  operationId?: string | null;
  occurredAt: Date;
  payload: Record<string, unknown>;
}
export interface InboxInput {
  messageId: string;
  handler: string;
  eventName: string;
  correlationId?: string | null;
  payload: Record<string, unknown>;
}
export interface InboxMutationContext {
  updateWorkflowState(input: UpdateWorkflowStateInput): Promise<void>;
}

export interface DomainResultInput {
  batchId: string;
  rowId: string;
  domain: BulkDomain;
  operationId: string;
  messageId: string;
  correlationId: string;
  causationId?: string | null;
  eventName: string;
  action:
    | 'UPSERT'
    | 'PRICE_INITIALIZATION'
    | 'SKU_INITIALIZATION'
    | 'STOCK_ADJUSTMENT';
  skuId?: string;
  status: 'COMPLETED' | 'FAILED';
  errorCode?: string | null;
  errorDetail?: string | null;
}

export interface CatalogBulkResultInput {
  messageId: string;
  operationId: string;
  causationId: string;
  eventName: 'catalog.bulk.upsert.completed' | 'catalog.bulk.upsert.rejected';
  correlationId: string;
  payload: Record<string, unknown>;
}

type BulkTx = Parameters<Parameters<BulkDatabase['transaction']>[0]>[0];

const inconsistent = (message: string): never => {
  throw new BulkPersistenceError('CHECK_VIOLATION', new Error(message));
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function admissionIntentWithoutCommandTimes(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const commands = Array.isArray(value.catalogCommands)
    ? value.catalogCommands.map((item) => {
        if (typeof item !== 'object' || item === null) return item;
        const command = structuredClone(item) as Record<string, unknown>;
        if (typeof command.occurred_at === 'string')
          command.occurred_at = '<persisted-at-first-admission>';
        return command;
      })
    : value.catalogCommands;
  return { ...value, catalogCommands: commands };
}

const domainFailure = (
  code:
    | 'INVALID_INPUT'
    | 'IDEMPOTENCY_CONFLICT'
    | 'INVALID_TRANSITION'
    | 'DEPENDENCY_PENDING'
    | 'PERSISTENCE_FAILURE',
  message: string,
): never => {
  throw new BulkDomainError(code, message);
};

@Injectable()
export class BulkPersistenceRepository {
  constructor(
    @Inject(BULK_DATABASE) private readonly database: BulkDatabase | null,
  ) {}

  private get db(): BulkDatabase {
    if (!this.database) throw new BulkPersistenceError('NOT_CONFIGURED');
    return this.database;
  }

  async createImportBatch(
    input: CreateImportBatchInput,
  ): Promise<CreateImportBatchResult> {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.batchId}, 0))`,
        );
        const [existingBatch] = await tx
          .select()
          .from(batchJobs)
          .where(eq(batchJobs.batchId, input.batchId))
          .for('update')
          .limit(1);
        if (existingBatch) {
          const [intentReceipt] = await tx
            .select()
            .from(inbox)
            .where(
              and(
                eq(inbox.messageId, input.batchId),
                eq(inbox.handler, 'bulk.import.admission'),
              ),
            )
            .limit(1);
          const sameIntent =
            intentReceipt && input.admissionIntent
              ? canonicalJson(
                  admissionIntentWithoutCommandTimes(
                    intentReceipt.payload as Record<string, unknown>,
                  ),
                ) ===
                canonicalJson(
                  admissionIntentWithoutCommandTimes(input.admissionIntent),
                )
              : false;
          if (!sameIntent) {
            throw new BulkPersistenceError('UNIQUE_CONFLICT');
          }
          const [manifest] = await tx
            .select()
            .from(fileManifests)
            .where(eq(fileManifests.id, existingBatch.inputFileId))
            .limit(1);
          if (!manifest)
            throw new BulkPersistenceError('FOREIGN_KEY_VIOLATION');
          const rows = await tx
            .select()
            .from(batchRows)
            .where(eq(batchRows.batchJobId, existingBatch.id))
            .orderBy(asc(batchRows.createdAt), asc(batchRows.id));
          const resultRows: CreateImportBatchResult['rows'] = [];
          for (const row of rows) {
            const steps = await tx
              .select()
              .from(rowDomainSteps)
              .where(eq(rowDomainSteps.batchRowId, row.id))
              .orderBy(asc(rowDomainSteps.domain));
            resultRows.push({ row, steps });
          }
          return { manifest, batch: existingBatch, rows: resultRows };
        }
        const [manifest] = await tx
          .insert(fileManifests)
          .values({
            role: 'ENTRADA_IMPORTACION',
            format: input.inputFile.format,
            contentRef: input.inputFile.contentRef,
          })
          .returning();
        if (!manifest) throw new Error('Manifest insert returned no row');
        const [batch] = await tx
          .insert(batchJobs)
          .values({
            batchId: input.batchId,
            inputFileId: manifest.id,
            status: 'QUEUED',
            templateVersion: input.templateVersion,
            correlationId: input.correlationId,
            totalRows: input.rows.length,
          })
          .returning();
        if (!batch) throw new Error('Batch insert returned no row');
        const createdRows: CreateImportBatchResult['rows'] = [];
        for (const rowInput of input.rows) {
          const [row] = await tx
            .insert(batchRows)
            .values({
              batchJobId: batch.id,
              rowId: rowInput.rowId,
              requiredDomains: rowInput.requiredDomains,
            })
            .returning();
          if (!row) throw new Error('Batch row insert returned no row');
          const steps = await tx
            .insert(rowDomainSteps)
            .values(
              rowInput.requiredDomains.map((domain) => ({
                batchRowId: row.id,
                domain,
              })),
            )
            .returning();
          if (steps.length !== rowInput.requiredDomains.length)
            throw new Error('Incomplete step insert');
          createdRows.push({ row, steps });
        }
        if (input.admissionIntent) {
          await tx.insert(inbox).values({
            messageId: input.batchId,
            handler: 'bulk.import.admission',
            eventName: 'bulk.import.admission',
            correlationId: input.correlationId,
            payload: input.admissionIntent,
            result: 'ADMITTED',
          });
        }
        for (const command of input.catalogCommands ?? []) {
          await tx.insert(outbox).values({
            messageId: command.messageId,
            eventName: command.eventName,
            kind: command.kind,
            schemaVersion: command.schemaVersion ?? 1,
            correlationId: command.correlationId,
            causationId: command.causationId ?? null,
            operationId: command.operationId ?? null,
            occurredAt: command.occurredAt,
            payload: command.payload,
          });
        }
        return { manifest, batch, rows: createdRows };
      });
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async recordDomainResult(
    input: DomainResultInput,
  ): Promise<{ processed: boolean; result: string }> {
    try {
      return await this.db.transaction(async (tx) => {
        const [batch] = await tx
          .select()
          .from(batchJobs)
          .where(eq(batchJobs.batchId, input.batchId))
          .for('update')
          .limit(1);
        if (!batch) throw new BulkPersistenceError('FOREIGN_KEY_VIOLATION');
        if (input.correlationId !== batch.correlationId)
          domainFailure(
            'INVALID_INPUT',
            'Result correlation_id does not match its batch',
          );
        const [row] = await tx
          .select()
          .from(batchRows)
          .where(
            and(
              eq(batchRows.batchJobId, batch.id),
              eq(batchRows.rowId, input.rowId),
            ),
          )
          .for('update')
          .limit(1);
        if (!row) throw new BulkPersistenceError('FOREIGN_KEY_VIOLATION');
        const expectedEvent =
          input.status === 'COMPLETED' ? 'completed' : 'rejected';
        const payload = {
          batchId: input.batchId,
          rowId: input.rowId,
          domain: input.domain,
          operationId: input.operationId,
          causationId: input.causationId ?? null,
          action: input.action,
          skuId: input.skuId ?? null,
          status: input.status,
          errorCode: input.errorCode ?? null,
          errorDetail: input.errorDetail ?? null,
        };
        const handler = 'bulk.domain-result';
        const [byMessage] = await tx
          .select()
          .from(inbox)
          .where(
            and(
              eq(inbox.messageId, input.messageId),
              eq(inbox.handler, handler),
            ),
          )
          .limit(1);
        if (byMessage) {
          const [sameMessage] = await tx
            .select({ id: inbox.id })
            .from(inbox)
            .where(
              and(
                eq(inbox.id, byMessage.id),
                eq(inbox.eventName, input.eventName),
                eq(inbox.correlationId, input.correlationId),
                sql`${inbox.payload} = ${JSON.stringify(payload)}::jsonb`,
              ),
            )
            .limit(1);
          if (!sameMessage) {
            domainFailure(
              'IDEMPOTENCY_CONFLICT',
              'message_id was reused with a different result intent',
            );
          }
          return { processed: false, result: byMessage.result };
        }
        const [byOperation] = await tx
          .select()
          .from(inbox)
          .where(
            and(
              eq(inbox.handler, handler),
              sql`${inbox.payload}->>'operationId' = ${input.operationId}`,
              sql`${inbox.payload}->>'batchId' = ${input.batchId}`,
              sql`${inbox.payload}->>'rowId' = ${input.rowId}`,
              sql`${inbox.payload}->>'domain' = ${input.domain}`,
              sql`${inbox.payload}->>'action' = ${input.action}`,
            ),
          )
          .orderBy(desc(inbox.createdAt))
          .limit(1);
        if (byOperation) {
          const [sameOperation] = await tx
            .select({ id: inbox.id })
            .from(inbox)
            .where(
              and(
                eq(inbox.id, byOperation.id),
                eq(inbox.eventName, input.eventName),
                eq(inbox.correlationId, input.correlationId),
                sql`${inbox.payload} = ${JSON.stringify(payload)}::jsonb`,
              ),
            )
            .limit(1);
          if (sameOperation) {
            return { processed: false, result: byOperation.result };
          } else {
            const [authorizedRequeue] = await tx
              .select({ id: inbox.id })
              .from(inbox)
              .where(
                and(
                  eq(inbox.handler, 'bulk.batch.requeue'),
                  sql`${inbox.payload}->>'batchId' = ${input.batchId}`,
                  sql`${inbox.createdAt} > ${byOperation.createdAt}`,
                ),
              )
              .limit(1);
            const priorAttemptFailed = byOperation.result === 'FAILED';
            const newAttempt =
              input.causationId !== null &&
              input.causationId !== undefined &&
              input.causationId !== byOperation.payload.causationId;
            if (!authorizedRequeue || !priorAttemptFailed || !newAttempt) {
              domainFailure(
                'IDEMPOTENCY_CONFLICT',
                'operation_id was reused with a different result intent',
              );
            }
          }
        }
        if (
          batch.status === 'COMPLETED' ||
          batch.status === 'FAILED_GENERAL' ||
          row.status === 'COMPLETED' ||
          row.status === 'FAILED'
        ) {
          domainFailure(
            'INVALID_TRANSITION',
            'A terminal result cannot reopen a row or batch without an explicit requeue',
          );
        }
        const [catalogStep] = await tx
          .select()
          .from(rowDomainSteps)
          .where(
            and(
              eq(rowDomainSteps.batchRowId, row.id),
              eq(rowDomainSteps.domain, 'CATALOGO'),
            ),
          )
          .limit(1);
        if (
          input.domain !== 'CATALOGO' &&
          catalogStep?.status !== 'COMPLETED'
        ) {
          domainFailure(
            'DEPENDENCY_PENDING',
            'Dependent domain result arrived before Catalog confirmation',
          );
        }
        if (!row.requiredDomains.includes(input.domain))
          domainFailure(
            'INVALID_INPUT',
            'Result domain is not required by this row',
          );
        const [admission] = await tx
          .select()
          .from(inbox)
          .where(
            and(
              eq(inbox.messageId, input.batchId),
              eq(inbox.handler, 'bulk.import.admission'),
            ),
          )
          .limit(1);
        if (!admission)
          domainFailure(
            'PERSISTENCE_FAILURE',
            'Normalized row intent is not durably available',
          );
        const intentRowsValue = admission.payload.rows;
        if (!Array.isArray(intentRowsValue))
          domainFailure(
            'PERSISTENCE_FAILURE',
            'Persisted normalized intent is incomplete',
          );
        const intentRows = intentRowsValue as unknown[];
        const normalized = intentRows.find(
          (candidate) =>
            typeof candidate === 'object' &&
            candidate !== null &&
            Reflect.get(candidate, 'rowId') === input.rowId,
        ) as Record<string, unknown> | undefined;
        if (!normalized)
          domainFailure(
            'INVALID_INPUT',
            'Result row does not exist in persisted normalized intent',
          );
        const normalizedRow = normalized as Record<string, unknown>;
        const skuIds = Array.isArray(normalizedRow.vendibleSkus)
          ? normalizedRow.vendibleSkus
          : [];
        if (
          input.domain === 'CATALOGO' &&
          (input.action !== 'UPSERT' ||
            input.eventName !== 'catalog.bulk.upsert.completed')
        )
          domainFailure(
            'INVALID_INPUT',
            'Bulk row results must be adapted from catalog.bulk.upsert.completed; catalog.bulk.upsert.rejected rejects the command as a whole.',
          );
        if (
          input.domain === 'PRICING' &&
          (input.action !== 'PRICE_INITIALIZATION' ||
            input.causationId == null ||
            (input.status === 'COMPLETED'
              ? input.eventName !== 'pricing.product.initialization.completed'
              : input.eventName !== 'pricing.product.initialization.rejected'))
        )
          inconsistent(
            'Pricing ALTA results must preserve initialization event, operation_id and causation_id identities.',
          );
        if (input.domain === 'INVENTARIO') {
          if (
            input.action === 'SKU_INITIALIZATION' &&
            (input.eventName !==
              `inventory.sku.initialization.${expectedEvent}` ||
              typeof input.skuId !== 'string' ||
              !skuIds.includes(input.skuId))
          )
            domainFailure(
              'INVALID_INPUT',
              'Inventory SKU result is not part of the normalized row intent',
            );
          if (
            input.action === 'STOCK_ADJUSTMENT' &&
            (input.eventName !==
              `inventory.bulk.stock.adjust.${expectedEvent}` ||
              Number(normalizedRow.stockInicial ?? 0) <= 0 ||
              !normalizedRow.defaultLocationId)
          )
            domainFailure(
              'INVALID_INPUT',
              'Inventory stock adjustment is not required by the normalized row intent',
            );
          if (
            input.action !== 'SKU_INITIALIZATION' &&
            input.action !== 'STOCK_ADJUSTMENT'
          )
            domainFailure(
              'INVALID_INPUT',
              'Inventory result action is invalid',
            );
        }
        const [step] = await tx
          .select()
          .from(rowDomainSteps)
          .where(
            and(
              eq(rowDomainSteps.batchRowId, row.id),
              eq(rowDomainSteps.domain, input.domain),
            ),
          )
          .for('update')
          .limit(1);
        if (!step)
          domainFailure(
            'PERSISTENCE_FAILURE',
            'Required workflow step is missing',
          );
        if (step.status === 'COMPLETED')
          domainFailure(
            'INVALID_TRANSITION',
            'A confirmed domain cannot accept a new operation result',
          );
        if (step.status === 'FAILED')
          domainFailure(
            'INVALID_TRANSITION',
            'A failed domain step cannot be retried before batch requeue',
          );
        if (
          input.domain === 'INVENTARIO' &&
          input.action === 'STOCK_ADJUSTMENT'
        ) {
          const activeSince = await findActiveRunStart(tx, batch);
          const earlierSkuReceipts = await tx
            .select()
            .from(inbox)
            .where(
              and(
                eq(inbox.handler, handler),
                sql`${inbox.payload}->>'batchId' = ${input.batchId}`,
                sql`${inbox.payload}->>'rowId' = ${input.rowId}`,
                sql`${inbox.payload}->>'action' = 'SKU_INITIALIZATION'`,
                sql`${inbox.createdAt} >= ${activeSince}`,
              ),
            );
          const completedSkuIds = earlierSkuReceipts
            .filter((receipt) => receipt.payload.status === 'COMPLETED')
            .map((receipt) => receipt.payload.skuId);
          if (skuIds.some((sku) => !completedSkuIds.includes(sku)))
            domainFailure(
              'DEPENDENCY_PENDING',
              'Stock adjustment result cannot precede all SKU initialization confirmations',
            );
        }
        await tx.insert(inbox).values({
          messageId: input.messageId,
          handler,
          eventName: input.eventName,
          correlationId: input.correlationId,
          payload,
          result: input.status,
        });
        let stepStatus: BulkStepStatus = input.status;
        if (input.domain === 'INVENTARIO' && input.status === 'COMPLETED') {
          const activeSince = await findActiveRunStart(tx, batch);
          const results = await tx
            .select()
            .from(inbox)
            .where(
              and(
                eq(inbox.handler, handler),
                sql`${inbox.payload}->>'batchId' = ${input.batchId}`,
                sql`${inbox.payload}->>'rowId' = ${input.rowId}`,
                sql`${inbox.payload}->>'domain' = 'INVENTARIO'`,
                sql`${inbox.createdAt} >= ${activeSince}`,
              ),
            );
          const completedSkuIds = results
            .filter(
              (receipt) =>
                receipt.payload.action === 'SKU_INITIALIZATION' &&
                receipt.payload.status === 'COMPLETED',
            )
            .map((receipt) => receipt.payload.skuId);
          const adjustmentRequired =
            Number(normalizedRow.stockInicial ?? 0) > 0 &&
            Boolean(normalizedRow.defaultLocationId);
          const adjustmentComplete = results.some(
            (receipt) =>
              receipt.payload.action === 'STOCK_ADJUSTMENT' &&
              receipt.payload.status === 'COMPLETED',
          );
          const inventoryFailed = results.some(
            (receipt) => receipt.payload.status === 'FAILED',
          );
          if (inventoryFailed) stepStatus = 'FAILED';
          else if (
            Number(normalizedRow.stockInicial ?? 0) > 0 &&
            !normalizedRow.defaultLocationId &&
            skuIds.every((sku) => completedSkuIds.includes(sku))
          )
            stepStatus = 'FAILED';
          else
            stepStatus =
              skuIds.every((sku) => completedSkuIds.includes(sku)) &&
              (!adjustmentRequired || adjustmentComplete)
                ? 'COMPLETED'
                : 'PROCESSING';
        }
        const currentSteps = await tx
          .select()
          .from(rowDomainSteps)
          .where(eq(rowDomainSteps.batchRowId, row.id));
        const stepChanges: WorkflowStepChange[] = [
          {
            domain: input.domain,
            status: stepStatus,
            errorCode:
              stepStatus === 'FAILED'
                ? (input.errorCode ??
                  (input.domain === 'INVENTARIO' &&
                  Number(normalizedRow.stockInicial ?? 0) > 0 &&
                  !normalizedRow.defaultLocationId
                    ? 'DEFAULT_LOCATION_REQUIRED'
                    : 'DOMAIN_REJECTED'))
                : null,
            errorDetail:
              stepStatus === 'FAILED'
                ? (input.errorDetail ??
                  (input.domain === 'INVENTARIO' &&
                  Number(normalizedRow.stockInicial ?? 0) > 0 &&
                  !normalizedRow.defaultLocationId
                    ? 'No existe ubicación predeterminada para aplicar el stock inicial.'
                    : null))
                : null,
          },
        ];
        if (input.domain === 'CATALOGO' && stepStatus === 'FAILED') {
          for (const candidate of currentSteps) {
            if (
              candidate.domain !== 'CATALOGO' &&
              candidate.status === 'PENDING'
            ) {
              stepChanges.push({
                domain: candidate.domain as BulkDomain,
                status: 'FAILED',
                errorCode: 'DEPENDENCY_REJECTED',
                errorDetail:
                  'Catálogo rechazó la fila; el paso dependiente no se ejecutó.',
              });
            }
          }
        }
        const changedByDomain = new Map<BulkDomain, WorkflowStepChange>(
          stepChanges.map((change) => [change.domain, change]),
        );
        const requiredDomains = row.requiredDomains as BulkDomain[];
        const statusFor = (domain: BulkDomain) =>
          changedByDomain.get(domain)?.status ??
          currentSteps.find((candidate) => candidate.domain === domain)
            ?.status ??
          'PENDING';
        const allTerminal = requiredDomains.every((domain) =>
          ['COMPLETED', 'FAILED'].includes(statusFor(domain)),
        );
        const allCompleted = requiredDomains.every(
          (domain) => statusFor(domain) === 'COMPLETED',
        );
        const rowStatus: BulkRowStatus = !allTerminal
          ? 'PROCESSING'
          : allCompleted
            ? 'COMPLETED'
            : 'FAILED';
        const failedDomain =
          rowStatus === 'FAILED'
            ? (requiredDomains.find(
                (domain) => statusFor(domain) === 'FAILED',
              ) ?? null)
            : null;
        const failedChange = failedDomain
          ? changedByDomain.get(failedDomain)
          : undefined;
        const previousFailure = failedDomain
          ? currentSteps.find((candidate) => candidate.domain === failedDomain)
          : undefined;
        const failedCode =
          failedChange?.errorCode ?? previousFailure?.errorCode ?? null;
        const failedDetail =
          failedChange?.errorDetail ?? previousFailure?.errorDetail ?? null;
        await updateWorkflowStateIn(tx, {
          batchId: input.batchId,
          rowId: input.rowId,
          steps: stepChanges,
          status: rowStatus,
          failedDomain,
          errorCode: failedCode,
          errorDetail: failedDetail,
        });
        const response = failedDomain
          ? 'FAILED'
          : stepStatus === 'COMPLETED'
            ? 'DOMAIN_COMPLETED'
            : 'PROCESSING';
        await tx
          .update(inbox)
          .set({ result: response })
          .where(
            and(
              eq(inbox.messageId, input.messageId),
              eq(inbox.handler, handler),
            ),
          );
        return { processed: true, result: response };
      });
    } catch (error) {
      if (error instanceof BulkDomainError) throw error;
      throw persistenceError(error);
    }
  }

  async recordCatalogBulkResult(
    input: CatalogBulkResultInput,
  ): Promise<{ processed: boolean; result: string }> {
    const messageHandler = 'bulk.catalog.bulk-upsert.result';
    try {
      return await this.db.transaction(async (tx) => {
        const envelope = input.payload;
        const data = envelope.data as Record<string, unknown> | undefined;
        if (
          !data ||
          envelope.message_id !== input.messageId ||
          envelope.operation_id !== input.operationId ||
          envelope.causation_id !== input.causationId ||
          envelope.correlation_id !== input.correlationId ||
          envelope.name !== input.eventName ||
          envelope.producer !== 'catalog-svc' ||
          envelope.kind !== 'result' ||
          envelope.schema_version !== 1
        )
          domainFailure(
            'INVALID_INPUT',
            'Catalog result envelope identity is inconsistent.',
          );
        const batchIdValue = data?.batch_id;
        if (typeof batchIdValue !== 'string')
          domainFailure('INVALID_INPUT', 'Catalog result has no batch_id.');
        const batchId = batchIdValue as string;
        const resultData = data as Record<string, unknown>;
        const [batch] = await tx
          .select()
          .from(batchJobs)
          .where(eq(batchJobs.batchId, batchId))
          .for('update')
          .limit(1);
        if (!batch)
          domainFailure('INVALID_INPUT', 'Catalog result batch is unknown.');
        if (input.correlationId !== batch.correlationId)
          domainFailure(
            'INVALID_INPUT',
            'Catalog result correlation_id does not match its batch.',
          );
        const [admission] = await tx
          .select()
          .from(inbox)
          .where(
            and(
              eq(inbox.messageId, batchId),
              eq(inbox.handler, 'bulk.import.admission'),
            ),
          )
          .limit(1);
        const admissionPayload = admission?.payload;
        if (!admissionPayload)
          domainFailure(
            'PERSISTENCE_FAILURE',
            'The admitted batch command relationship is missing.',
          );
        const catalogCommands = Array.isArray(admissionPayload.catalogCommands)
          ? admissionPayload.catalogCommands
          : [];
        const matchingCommand = catalogCommands.find((candidate) => {
          if (typeof candidate !== 'object' || candidate === null) return false;
          const command = candidate as Record<string, unknown>;
          return (
            command.message_id === input.causationId &&
            command.operation_id === input.operationId
          );
        }) as Record<string, unknown> | undefined;
        if (!matchingCommand)
          domainFailure(
            'INVALID_INPUT',
            'Catalog result causation/operation identity does not match an admitted command.',
          );
        const commandData = (matchingCommand as Record<string, unknown>)
          .data as Record<string, unknown> | undefined;
        const batchOperationId =
          typeof commandData?.batch_operation_id === 'string'
            ? commandData.batch_operation_id
            : domainFailure(
                'INVALID_INPUT',
                'Admitted Catalog chunk has no batch_operation_id.',
              );
        if (resultData.batch_operation_id !== batchOperationId)
          domainFailure(
            'INVALID_INPUT',
            'Catalog result batch_operation_id does not match its admitted chunk.',
          );
        const commandRows = Array.isArray(commandData?.rows)
          ? commandData.rows
          : [];
        const admittedRows = Array.isArray(admissionPayload.rows)
          ? admissionPayload.rows
          : [];
        const commandRowOperations = new Set(
          commandRows.map((value) =>
            typeof value === 'object' && value !== null
              ? Reflect.get(value, 'row_operation_id')
              : null,
          ),
        );
        const normalizedRows = admittedRows.filter(
          (value) =>
            typeof value === 'object' &&
            value !== null &&
            commandRowOperations.has(Reflect.get(value, 'rowOperationId')),
        );
        const [existingMessage] = await tx
          .select()
          .from(inbox)
          .where(
            and(
              eq(inbox.messageId, input.messageId),
              eq(inbox.handler, messageHandler),
            ),
          )
          .limit(1);
        if (existingMessage) {
          const same =
            existingMessage.eventName === input.eventName &&
            existingMessage.correlationId === input.correlationId &&
            canonicalJson(existingMessage.payload) ===
              canonicalJson(input.payload);
          if (!same)
            domainFailure(
              'IDEMPOTENCY_CONFLICT',
              'message_id was reused with a different Catalog result.',
            );
          return { processed: false, result: existingMessage.result };
        }

        const rawResults =
          input.eventName === 'catalog.bulk.upsert.completed'
            ? resultData.results
            : null;
        if (
          input.eventName === 'catalog.bulk.upsert.completed' &&
          (!Array.isArray(rawResults) || rawResults.length === 0)
        )
          domainFailure(
            'INVALID_INPUT',
            'Catalog completed result must include row results.',
          );
        const results: Array<{
          row_number: number;
          row_operation_id: string;
          product_id: string | null;
          sku_base: string;
          status: 'COMPLETED' | 'REJECTED';
          code: string | null;
        }> =
          input.eventName === 'catalog.bulk.upsert.completed'
            ? (rawResults as Array<{
                row_number: number;
                row_operation_id: string;
                product_id: string | null;
                sku_base: string;
                status: 'COMPLETED' | 'REJECTED';
                code: string | null;
              }>)
            : normalizedRows.map((value) => {
                const row = value as Record<string, unknown>;
                return {
                  row_number: Number(row.rowNumber),
                  row_operation_id: String(row.rowOperationId),
                  product_id: null,
                  sku_base: String(row.skuBase),
                  status: 'REJECTED',
                  code: String(resultData.code),
                };
              });
        if (
          input.eventName === 'catalog.bulk.upsert.rejected' &&
          (!resultData.code || typeof resultData.detail !== 'string')
        )
          domainFailure(
            'INVALID_INPUT',
            'Catalog rejected result is missing its command-level reason.',
          );
        const seen = new Set<string>();
        for (const result of results) {
          const normalized = normalizedRows.find((candidate) => {
            if (typeof candidate !== 'object' || candidate === null)
              return false;
            const row = candidate as Record<string, unknown>;
            return row.rowOperationId === result.row_operation_id;
          }) as Record<string, unknown> | undefined;
          if (
            !normalized ||
            seen.has(result.row_operation_id) ||
            Number(normalized.rowNumber) !== result.row_number ||
            normalized.skuBase !== result.sku_base
          )
            domainFailure(
              'INVALID_INPUT',
              'Catalog result row identity does not belong to the admitted batch.',
            );
          seen.add(result.row_operation_id);
          if (
            input.eventName === 'catalog.bulk.upsert.completed' &&
            (result.status === 'COMPLETED'
              ? result.code !== null
              : typeof result.code !== 'string')
          )
            domainFailure(
              'INVALID_INPUT',
              'Catalog row status and code are inconsistent.',
            );

          const rowId = String((normalized as Record<string, unknown>).rowId);
          const rowHandler = `bulk.catalog-result-row:${result.row_operation_id}`;
          const rowIntent = {
            batchId,
            batchOperationId,
            eventName: input.eventName,
            result,
          };
          const [priorOperation] = await tx
            .select()
            .from(inbox)
            .where(and(eq(inbox.handler, rowHandler)))
            .orderBy(desc(inbox.createdAt))
            .limit(1);
          if (priorOperation) {
            if (
              canonicalJson(priorOperation.payload) !== canonicalJson(rowIntent)
            )
              domainFailure(
                'IDEMPOTENCY_CONFLICT',
                'row_operation_id was replayed with a different Catalog result.',
              );
            continue;
          }
          const [row] = await tx
            .select()
            .from(batchRows)
            .where(
              and(
                eq(batchRows.batchJobId, batch.id),
                eq(batchRows.rowId, rowId),
              ),
            )
            .for('update')
            .limit(1);
          if (!row)
            domainFailure(
              'INVALID_INPUT',
              'Catalog result row is not persisted.',
            );
          const [step] = await tx
            .select()
            .from(rowDomainSteps)
            .where(
              and(
                eq(rowDomainSteps.batchRowId, row.id),
                eq(rowDomainSteps.domain, 'CATALOGO'),
              ),
            )
            .for('update')
            .limit(1);
          if (!step || !row.requiredDomains.includes('CATALOGO'))
            domainFailure(
              'INVALID_INPUT',
              'Catalog result does not match a required workflow step.',
            );
          if (step.status === 'COMPLETED' || step.status === 'FAILED') {
            domainFailure(
              'INVALID_TRANSITION',
              'Catalog step is already terminal.',
            );
          }
          const status = result.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED';
          const pendingSteps = await tx
            .select()
            .from(rowDomainSteps)
            .where(eq(rowDomainSteps.batchRowId, row.id));
          const changes: WorkflowStepChange[] = [
            {
              domain: 'CATALOGO',
              status,
              errorCode:
                status === 'FAILED'
                  ? (result.code ?? 'CATALOG_REJECTED')
                  : null,
              errorDetail:
                status === 'FAILED'
                  ? input.eventName === 'catalog.bulk.upsert.rejected'
                    ? String(resultData.detail)
                    : null
                  : null,
            },
          ];
          if (status === 'FAILED') {
            for (const dependency of pendingSteps) {
              if (
                dependency.domain !== 'CATALOGO' &&
                dependency.status === 'PENDING'
              )
                changes.push({
                  domain: dependency.domain as BulkDomain,
                  status: 'FAILED',
                  errorCode: 'DEPENDENCY_REJECTED',
                  errorDetail:
                    'Catalog rechazó la fila; el paso dependiente no se ejecutó.',
                });
            }
          }
          const statusByDomain = new Map(
            changes.map((change) => [change.domain, change.status]),
          );
          const allTerminal = row.requiredDomains.every((domain) => {
            const current =
              statusByDomain.get(domain as BulkDomain) ??
              pendingSteps.find((candidate) => candidate.domain === domain)
                ?.status;
            return current === 'COMPLETED' || current === 'FAILED';
          });
          const allCompleted = row.requiredDomains.every(
            (domain) =>
              (statusByDomain.get(domain as BulkDomain) ??
                pendingSteps.find((candidate) => candidate.domain === domain)
                  ?.status) === 'COMPLETED',
          );
          const rowStatus: BulkRowStatus = !allTerminal
            ? 'PROCESSING'
            : allCompleted
              ? 'COMPLETED'
              : 'FAILED';
          await updateWorkflowStateIn(tx, {
            batchId,
            rowId,
            steps: changes,
            status: rowStatus,
            failedDomain:
              rowStatus === 'FAILED'
                ? (changes.find((change) => change.status === 'FAILED')
                    ?.domain ?? 'CATALOGO')
                : null,
            errorCode:
              status === 'FAILED' ? (result.code ?? 'CATALOG_REJECTED') : null,
            errorDetail:
              status === 'FAILED' &&
              input.eventName === 'catalog.bulk.upsert.rejected'
                ? String(resultData.detail)
                : null,
          });
          await tx.insert(inbox).values({
            messageId: input.messageId,
            handler: rowHandler,
            eventName: input.eventName,
            correlationId: input.correlationId,
            payload: rowIntent,
            result: status,
          });
        }
        if (
          input.eventName === 'catalog.bulk.upsert.completed' &&
          seen.size !== normalizedRows.length
        )
          domainFailure(
            'INVALID_INPUT',
            'Catalog result omitted one or more admitted rows.',
          );
        const outcome =
          input.eventName === 'catalog.bulk.upsert.rejected'
            ? 'COMMAND_REJECTED'
            : 'RESULTS_APPLIED';
        await tx.insert(inbox).values({
          messageId: input.messageId,
          handler: messageHandler,
          eventName: input.eventName,
          correlationId: input.correlationId,
          payload: input.payload,
          result: outcome,
        });
        return { processed: true, result: outcome };
      });
    } catch (error) {
      if (error instanceof BulkDomainError) throw error;
      throw persistenceError(error);
    }
  }

  async findBatchByBatchId(
    batchId: string,
  ): Promise<typeof batchJobs.$inferSelect | null> {
    try {
      const [batch] = await this.db
        .select()
        .from(batchJobs)
        .where(eq(batchJobs.batchId, batchId))
        .limit(1);
      return batch ?? null;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async findImportAdmissionIntent(
    batchId: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const [receipt] = await this.db
        .select({ payload: inbox.payload })
        .from(inbox)
        .where(
          and(
            eq(inbox.messageId, batchId),
            eq(inbox.handler, 'bulk.import.admission'),
          ),
        )
        .limit(1);
      return (receipt?.payload as Record<string, unknown> | undefined) ?? null;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async listBatchRows(
    batchId: string,
  ): Promise<Array<typeof batchRows.$inferSelect>> {
    try {
      return await this.db
        .select({ row: batchRows })
        .from(batchRows)
        .innerJoin(batchJobs, eq(batchRows.batchJobId, batchJobs.id))
        .where(eq(batchJobs.batchId, batchId))
        .orderBy(asc(batchRows.createdAt), asc(batchRows.id))
        .then((rows) => rows.map(({ row }) => row));
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async listRowSteps(
    batchId: string,
    rowId: string,
  ): Promise<Array<typeof rowDomainSteps.$inferSelect>> {
    try {
      const found = await this.db
        .select({ id: batchRows.id })
        .from(batchRows)
        .innerJoin(batchJobs, eq(batchRows.batchJobId, batchJobs.id))
        .where(and(eq(batchJobs.batchId, batchId), eq(batchRows.rowId, rowId)))
        .limit(1);
      if (!found[0]) return [];
      return await this.db
        .select()
        .from(rowDomainSteps)
        .where(eq(rowDomainSteps.batchRowId, found[0].id))
        .orderBy(asc(rowDomainSteps.domain));
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async updateWorkflowState(input: UpdateWorkflowStateInput): Promise<void> {
    try {
      await this.db.transaction((tx) => updateWorkflowStateIn(tx, input));
    } catch (error) {
      throw persistenceError(error);
    }
  }

  /** Requeues only terminal batches that contain rows marked for reconciliation. */
  async requeueBatch(batchId: string): Promise<typeof batchJobs.$inferSelect> {
    try {
      return await this.db.transaction(async (tx) => {
        const [batch] = await tx
          .select()
          .from(batchJobs)
          .where(eq(batchJobs.batchId, batchId))
          .for('update')
          .limit(1);
        if (!batch) throw new BulkPersistenceError('FOREIGN_KEY_VIOLATION');
        if (batch.status !== 'COMPLETED' || !batch.needsReconciliation) {
          inconsistent(
            'Only completed batches requiring reconciliation can be requeued',
          );
        }
        const eligible = await tx
          .select({ id: batchRows.id })
          .from(batchRows)
          .where(
            and(
              eq(batchRows.batchJobId, batch.id),
              eq(batchRows.needsReconciliation, true),
            ),
          )
          .for('update');
        if (eligible.length === 0)
          inconsistent('Batch has no rows eligible for reconciliation');
        for (const { id } of eligible) {
          await tx
            .update(rowDomainSteps)
            .set({ status: 'PENDING', errorCode: null, errorDetail: null })
            .where(
              and(
                eq(rowDomainSteps.batchRowId, id),
                eq(rowDomainSteps.status, 'FAILED'),
              ),
            );
          await tx
            .update(batchRows)
            .set({
              status: 'PENDING',
              failedDomain: null,
              needsReconciliation: false,
              errorCode: null,
              errorDetail: null,
            })
            .where(eq(batchRows.id, id));
        }
        const [completed] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(batchRows)
          .where(
            and(
              eq(batchRows.batchJobId, batch.id),
              eq(batchRows.status, 'COMPLETED'),
            ),
          );
        const [updated] = await tx
          .update(batchJobs)
          .set({
            status: 'QUEUED',
            completedRows: completed?.count ?? 0,
            failedRows: 0,
            needsReconciliation: false,
          })
          .where(eq(batchJobs.id, batch.id))
          .returning();
        if (!updated) throw new Error('Batch requeue returned no row');
        const runId = randomUUID();
        await tx.insert(inbox).values({
          messageId: runId,
          handler: 'bulk.batch.requeue',
          eventName: 'bulk.batch.requeued',
          correlationId: batch.correlationId,
          payload: { batchId, runId },
          result: 'REQUEUED',
        });
        return updated;
      });
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async createExportJob(
    input: CreateExportJobInput,
  ): Promise<typeof exportJobs.$inferSelect> {
    try {
      const [job] = await this.db
        .insert(exportJobs)
        .values({ exportId: input.exportId, format: input.format })
        .returning();
      if (!job) throw new Error('Export insert returned no row');
      return job;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async findExportJobByExportId(
    exportId: string,
  ): Promise<typeof exportJobs.$inferSelect | null> {
    try {
      const [job] = await this.db
        .select()
        .from(exportJobs)
        .where(eq(exportJobs.exportId, exportId))
        .limit(1);
      return job ?? null;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async listQueuedExportJobs(): Promise<Array<typeof exportJobs.$inferSelect>> {
    try {
      return await this.db
        .select()
        .from(exportJobs)
        .where(eq(exportJobs.status, 'QUEUED'))
        .orderBy(asc(exportJobs.createdAt));
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async requeueStaleProcessingExports(
    staleBefore: Date,
  ): Promise<Array<typeof exportJobs.$inferSelect>> {
    try {
      return await this.db
        .update(exportJobs)
        .set({ status: 'QUEUED' })
        .where(
          and(
            eq(exportJobs.status, 'PROCESSING'),
            sql`${exportJobs.updatedAt} <= ${staleBefore}`,
          ),
        )
        .returning();
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async claimQueuedExportJob(
    exportId: string,
  ): Promise<{ job: typeof exportJobs.$inferSelect; fence: string } | null> {
    try {
      const [claimed] = await this.db
        .update(exportJobs)
        .set({ status: 'PROCESSING' })
        .where(
          and(
            eq(exportJobs.exportId, exportId),
            eq(exportJobs.status, 'QUEUED'),
          ),
        )
        .returning({
          job: exportJobs,
          fence: sql<string>`xmin::text`,
        });
      return claimed ?? null;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async failProcessingExportJob(
    exportId: string,
    fence: string,
  ): Promise<typeof exportJobs.$inferSelect | null> {
    try {
      const [failed] = await this.db
        .update(exportJobs)
        .set({ status: 'FAILED_GENERAL' })
        .where(
          and(
            eq(exportJobs.exportId, exportId),
            eq(exportJobs.status, 'PROCESSING'),
            sql`xmin::text = ${fence}`,
          ),
        )
        .returning();
      return failed ?? null;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async findFileManifest(
    id: string,
  ): Promise<typeof fileManifests.$inferSelect | null> {
    try {
      const [manifest] = await this.db
        .select()
        .from(fileManifests)
        .where(eq(fileManifests.id, id))
        .limit(1);
      return manifest ?? null;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async transitionExportJob(
    exportId: string,
    from: BulkJobStatus[],
    to: BulkJobStatus,
  ): Promise<typeof exportJobs.$inferSelect | null> {
    try {
      const allowed =
        (to === 'PROCESSING' && from.length === 1 && from[0] === 'QUEUED') ||
        (to === 'FAILED_GENERAL' &&
          from.length === 1 &&
          from[0] === 'PROCESSING');
      if (!allowed) inconsistent('Invalid export job state transition');
      const [job] = await this.db
        .update(exportJobs)
        .set({ status: to })
        .where(
          and(
            eq(exportJobs.exportId, exportId),
            inArray(exportJobs.status, from),
          ),
        )
        .returning();
      return job ?? null;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async completeExportJob(
    exportId: string,
    resultFile: Omit<FileManifestInput, 'role'>,
  ): Promise<typeof exportJobs.$inferSelect> {
    try {
      return await this.db.transaction(async (tx) => {
        const [job] = await tx
          .select()
          .from(exportJobs)
          .where(eq(exportJobs.exportId, exportId))
          .for('update')
          .limit(1);
        if (!job) throw new BulkPersistenceError('FOREIGN_KEY_VIOLATION');
        if (job.status !== 'PROCESSING')
          inconsistent('Only a processing export can be completed');
        if (resultFile.format !== job.format)
          inconsistent('Export output format must match the requested format');
        if (
          !matchesBulkStorageReference(
            resultFile.contentRef,
            process.env.BULK_STORAGE_BUCKET,
          )
        )
          inconsistent(
            'Export output must reference a configured Bulk Storage object',
          );
        // This checks adapter compatibility only. The caller must upload via
        // BulkStorageService.put(), which verifies the configured bucket ACL.
        const [manifest] = await tx
          .insert(fileManifests)
          .values({
            role: 'RESULTADO_EXPORTACION',
            format: resultFile.format,
            contentRef: resultFile.contentRef,
          })
          .returning();
        if (!manifest)
          throw new Error('Output manifest insert returned no row');
        const [updated] = await tx
          .update(exportJobs)
          .set({
            status: 'COMPLETED',
            outputFileId: manifest.id,
            completedAt: new Date(),
          })
          .where(
            and(eq(exportJobs.id, job.id), eq(exportJobs.status, 'PROCESSING')),
          )
          .returning();
        if (!updated) throw new Error('Export update returned no row');
        return updated;
      });
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async enqueueOutbox(
    input: OutboxInput,
    workflow?: UpdateWorkflowStateInput,
  ): Promise<typeof outbox.$inferSelect> {
    try {
      return await this.db.transaction(async (tx) => {
        if (workflow) await updateWorkflowStateIn(tx, workflow);
        const [message] = await tx
          .insert(outbox)
          .values({
            messageId: input.messageId,
            eventName: input.eventName,
            kind: input.kind,
            schemaVersion: input.schemaVersion ?? 1,
            correlationId: input.correlationId,
            causationId: input.causationId ?? null,
            operationId: input.operationId ?? null,
            occurredAt: input.occurredAt,
            payload: input.payload,
          })
          .returning();
        if (!message) throw new Error('Outbox insert returned no row');
        return message;
      });
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async findPendingOutbox(
    limit = 100,
  ): Promise<Array<typeof outbox.$inferSelect>> {
    try {
      return await this.db
        .select()
        .from(outbox)
        .where(sql`${outbox.publishedAt} IS NULL`)
        .orderBy(asc(outbox.occurredAt), asc(outbox.id))
        .limit(Math.max(1, Math.min(limit, 1000)));
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async markOutboxPublished(
    messageId: string,
    result: {
      publishedAt?: Date | null;
      attempts: number;
      lastError?: string | null;
    },
  ): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        const [message] = await tx
          .select()
          .from(outbox)
          .where(eq(outbox.messageId, messageId))
          .for('update')
          .limit(1);
        if (!message) throw new BulkPersistenceError('FOREIGN_KEY_VIOLATION');
        const alreadyPublished = message.publishedAt !== null;
        await tx
          .update(outbox)
          .set({
            publishedAt: message.publishedAt ?? result.publishedAt ?? null,
            attempts: Math.max(message.attempts, result.attempts),
            lastError: alreadyPublished
              ? null
              : result.publishedAt
                ? null
                : (result.lastError ?? null),
          })
          .where(eq(outbox.id, message.id));
      });
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async processInboxOnce(
    input: InboxInput,
    mutate: (context: InboxMutationContext) => Promise<string>,
  ): Promise<{ processed: boolean; result: string }> {
    try {
      return await this.db.transaction(async (tx) => {
        const [receipt] = await tx
          .insert(inbox)
          .values({
            messageId: input.messageId,
            handler: input.handler,
            eventName: input.eventName,
            correlationId: input.correlationId ?? null,
            payload: input.payload,
            result: 'PROCESSING',
          })
          .onConflictDoNothing({ target: [inbox.messageId, inbox.handler] })
          .returning();
        if (!receipt) {
          const [existing] = await tx
            .select({ result: inbox.result })
            .from(inbox)
            .where(
              and(
                eq(inbox.messageId, input.messageId),
                eq(inbox.handler, input.handler),
              ),
            )
            .limit(1);
          if (!existing) throw new BulkPersistenceError('PERSISTENCE_FAILURE');
          const [matching] = await tx
            .select({ result: inbox.result })
            .from(inbox)
            .where(
              and(
                eq(inbox.messageId, input.messageId),
                eq(inbox.handler, input.handler),
                eq(inbox.eventName, input.eventName),
                sql`${inbox.correlationId} IS NOT DISTINCT FROM ${input.correlationId ?? null}`,
                sql`${inbox.payload} = ${JSON.stringify(input.payload)}::jsonb`,
              ),
            )
            .limit(1);
          if (!matching)
            throw new BulkPersistenceError(
              'CHECK_VIOLATION',
              new Error(
                'Inbox replay identity does not match persisted message',
              ),
            );
          return {
            processed: false,
            result: existing.result,
          };
        }
        const result = await mutate({
          updateWorkflowState: (state) => updateWorkflowStateIn(tx, state),
        });
        await tx.update(inbox).set({ result }).where(eq(inbox.id, receipt.id));
        return { processed: true, result };
      });
    } catch (error) {
      throw persistenceError(error);
    }
  }
}

async function findActiveRunStart(
  tx: BulkTx,
  batch: typeof batchJobs.$inferSelect,
): Promise<Date> {
  const [latestRequeue] = await tx
    .select({ createdAt: inbox.createdAt })
    .from(inbox)
    .where(
      and(
        eq(inbox.handler, 'bulk.batch.requeue'),
        sql`${inbox.payload}->>'batchId' = ${batch.batchId}`,
      ),
    )
    .orderBy(desc(inbox.createdAt))
    .limit(1);
  return latestRequeue?.createdAt ?? batch.createdAt;
}

async function updateWorkflowStateIn(
  tx: BulkTx,
  input: UpdateWorkflowStateInput,
): Promise<void> {
  const [batch] = await tx
    .select()
    .from(batchJobs)
    .where(eq(batchJobs.batchId, input.batchId))
    .for('update')
    .limit(1);
  if (!batch) throw new BulkPersistenceError('FOREIGN_KEY_VIOLATION');
  if (batch.status === 'COMPLETED' || batch.status === 'FAILED_GENERAL')
    inconsistent(
      'A terminal batch requires explicit eligible requeue before workflow updates',
    );
  const [row] = await tx
    .select()
    .from(batchRows)
    .where(
      and(eq(batchRows.batchJobId, batch.id), eq(batchRows.rowId, input.rowId)),
    )
    .for('update')
    .limit(1);
  if (!row) throw new BulkPersistenceError('FOREIGN_KEY_VIOLATION');

  const steps = await tx
    .select()
    .from(rowDomainSteps)
    .where(eq(rowDomainSteps.batchRowId, row.id))
    .for('update');
  const required = new Set(row.requiredDomains);
  if (
    steps.length !== required.size ||
    steps.some((step) => !required.has(step.domain))
  ) {
    inconsistent(
      'Persisted required domains do not match persisted workflow steps',
    );
  }
  const changes = new Map<BulkDomain, WorkflowStepChange>();
  for (const change of input.steps) {
    if (!required.has(change.domain) || changes.has(change.domain))
      inconsistent('Invalid or duplicate workflow domain');
    changes.set(change.domain, change);
  }
  for (const change of changes.values()) {
    const previous = steps.find((step) => step.domain === change.domain);
    if (previous?.status === 'COMPLETED' && change.status !== 'COMPLETED')
      inconsistent('A completed domain step cannot be reverted');
    await tx
      .update(rowDomainSteps)
      .set({
        status: change.status,
        errorCode: change.errorCode ?? null,
        errorDetail: change.errorDetail ?? null,
      })
      .where(
        and(
          eq(rowDomainSteps.batchRowId, row.id),
          eq(rowDomainSteps.domain, change.domain),
        ),
      );
  }
  const statusByDomain = new Map(
    steps.map((step) => [
      step.domain as BulkDomain,
      changes.get(step.domain as BulkDomain)?.status ?? step.status,
    ]),
  );
  const appliedDomains = row.requiredDomains.filter(
    (domain) =>
      row.appliedDomains.includes(domain) ||
      statusByDomain.get(domain as BulkDomain) === 'COMPLETED',
  );
  if (row.status === 'COMPLETED' && input.status !== 'COMPLETED')
    inconsistent('A completed row cannot be reverted');
  if (
    input.status === 'COMPLETED' &&
    row.requiredDomains.some(
      (domain) => statusByDomain.get(domain as BulkDomain) !== 'COMPLETED',
    )
  ) {
    inconsistent(
      'A completed row requires every required domain step to be completed',
    );
  }
  const failedDomain = input.failedDomain ?? null;
  if (
    input.status === 'FAILED' &&
    (!failedDomain || statusByDomain.get(failedDomain) !== 'FAILED')
  ) {
    inconsistent('A failed row requires a failed required domain step');
  }
  const needsReconciliation =
    input.status === 'FAILED' && appliedDomains.length > 0;
  if (
    input.needsReconciliation !== undefined &&
    input.needsReconciliation !== needsReconciliation
  ) {
    inconsistent(
      'Reconciliation flag does not match row state and applied domains',
    );
  }
  await tx
    .update(batchRows)
    .set({
      status: input.status,
      appliedDomains,
      failedDomain,
      needsReconciliation,
      errorCode: input.errorCode ?? null,
      errorDetail: input.errorDetail ?? null,
    })
    .where(eq(batchRows.id, row.id));

  const [counts] = await tx
    .select({
      total: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) FILTER (WHERE ${batchRows.status} = 'COMPLETED')::int`,
      failed: sql<number>`count(*) FILTER (WHERE ${batchRows.status} = 'FAILED')::int`,
    })
    .from(batchRows)
    .where(eq(batchRows.batchJobId, batch.id));
  const total = counts?.total ?? 0;
  const completed = counts?.completed ?? 0;
  const failed = counts?.failed ?? 0;
  const terminal =
    completed + failed === batch.totalRows && total === batch.totalRows;
  await tx
    .update(batchJobs)
    .set({
      status: terminal ? 'COMPLETED' : 'PROCESSING',
      completedRows: completed,
      failedRows: failed,
      needsReconciliation: failed > 0,
    })
    .where(eq(batchJobs.id, batch.id));
}

export const bulkRepositoryProvider = {
  provide: BulkPersistenceRepository,
  inject: [BULK_DATABASE],
  useFactory: (db: BulkDatabase | null) => new BulkPersistenceRepository(db),
};
