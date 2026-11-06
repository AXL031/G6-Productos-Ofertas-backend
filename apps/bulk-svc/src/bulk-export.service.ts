import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mapBulkPersistenceError } from './domain/bulk.errors.js';
import { BulkDomainError } from './domain/bulk.domain-error.js';
import { isConfirmedTransactionRollback } from './persistence/bulk.persistence.errors.js';
import { BulkPersistenceRepository } from './persistence/bulk.repository.js';
import { BulkStorageService } from './storage/bulk-storage.service.js';
import {
  BULK_EXPORT_SOURCE,
  type BulkExportSource,
  type ExportPage,
} from './export/bulk-export-source.js';
import {
  consolidateExportRows,
  createExportCsv,
  createExportXlsx,
  type ExportSnapshot,
} from './export/bulk-export-format.js';

export type ExportFormat = 'CSV' | 'XLSX';

class ExportCompletionOutcomeUncertainError extends Error {
  constructor(cause: unknown) {
    super('La transacción de finalización requiere conciliación.', { cause });
    this.name = 'ExportCompletionOutcomeUncertainError';
  }
}

/**
 * Durable worker. Contract-approved source adapters can be bound without
 * changing the export pipeline; absent adapters fail closed.
 */
@Injectable()
export class BulkExportService implements OnModuleInit, OnModuleDestroy {
  private static readonly PROCESSING_LEASE_MS = 60_000;
  private static readonly LEASE_RENEW_INTERVAL_MS = 20_000;
  private static readonly MAX_EXPORT_ROWS = 100_000;
  private static readonly MAX_EXPORT_BYTES = 64 * 1024 * 1024;
  private static readonly RETRY_BASE_MS = 250;
  private static readonly RETRY_MAX_MS = 30_000;
  private recoveryFailures = 0;
  private destroyed = false;
  private readonly scheduled = new Set<string>();
  private readonly failureFences = new Map<string, string>();
  private readonly retryCounts = new Map<string, number>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly logger = new Logger(BulkExportService.name);
  private recoveryTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repository: BulkPersistenceRepository,
    @Optional() private readonly storage: BulkStorageService | null = null,
    @Optional()
    @Inject(BULK_EXPORT_SOURCE)
    private readonly source: BulkExportSource | null = null,
  ) {}

  onModuleInit(): void {
    void this.runRecovery();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  async create(format: ExportFormat) {
    if (format !== 'CSV' && format !== 'XLSX') {
      throw new BulkDomainError(
        'INVALID_INPUT',
        'formato debe ser CSV o XLSX.',
      );
    }
    try {
      const exportId = randomUUID();
      const job = await this.repository.createExportJob({ exportId, format });
      this.schedule(exportId);
      return this.toDto(job);
    } catch (error) {
      throw mapBulkPersistenceError(error);
    }
  }

  async get(exportId: string) {
    assertExportId(exportId);
    try {
      const job = await this.repository.findExportJobByExportId(exportId);
      if (!job)
        throw new BulkDomainError(
          'EXPORT_NOT_FOUND',
          'La exportación no existe.',
        );
      return this.toDto(job);
    } catch (error) {
      throw mapBulkPersistenceError(error);
    }
  }

  async download(exportId: string) {
    assertExportId(exportId);
    try {
      const job = await this.repository.findExportJobByExportId(exportId);
      if (!job)
        throw new BulkDomainError(
          'EXPORT_NOT_FOUND',
          'La exportación no existe.',
        );
      if (job.status !== 'COMPLETED' || !job.outputFileId) {
        throw new BulkDomainError(
          'EXPORT_NOT_READY',
          'La exportación no tiene un archivo completo disponible.',
        );
      }
      const manifest = await this.repository.findFileManifest(job.outputFileId);
      if (
        !manifest ||
        manifest.role !== 'RESULTADO_EXPORTACION' ||
        manifest.format !== job.format ||
        !manifest.contentRef.trim() ||
        !isExportManifestForJob(manifest, exportId, job.createdAt, job.format)
      ) {
        throw new BulkDomainError(
          'EXPORT_NOT_READY',
          'La exportación no tiene un archivo completo disponible.',
        );
      }
      return { job, manifest };
    } catch (error) {
      throw mapBulkPersistenceError(error);
    }
  }

  private async recoverAndDispatch(): Promise<void> {
    const staleBefore = new Date(
      Date.now() - BulkExportService.PROCESSING_LEASE_MS,
    );
    await this.repository.requeueStaleProcessingExports(staleBefore);
    const jobs = await this.repository.listQueuedExportJobs();
    for (const job of jobs) this.schedule(job.exportId);
  }

  private scheduleRecovery(delay: number): void {
    if (this.destroyed) return;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      if (!this.destroyed) void this.runRecovery();
    }, delay);
    this.recoveryTimer.unref();
  }

  private async runRecovery(): Promise<void> {
    if (this.destroyed) return;
    try {
      await this.recoverAndDispatch();
      if (this.destroyed) return;
      this.recoveryFailures = 0;
      this.scheduleRecovery(BulkExportService.PROCESSING_LEASE_MS / 2);
    } catch {
      if (this.destroyed) return;
      this.logger.warn(
        'No se pudo recuperar la cola de exportaciones; se reintentará.',
      );
      this.recoveryFailures += 1;
      const delay = Math.min(
        BulkExportService.RETRY_BASE_MS *
          2 ** Math.min(this.recoveryFailures - 1, 16),
        BulkExportService.RETRY_MAX_MS,
      );
      this.scheduleRecovery(delay);
    }
  }

  private schedule(exportId: string): void {
    if (this.scheduled.has(exportId)) return;
    this.scheduled.add(exportId);
    setImmediate(() => {
      void this.process(exportId)
        .catch((error: unknown) => {
          if (error instanceof ExportCompletionOutcomeUncertainError) {
            this.logger.warn(
              `La exportación ${exportId} queda sin reintento hasta que venza su lease; el objeto permanece para conciliación.`,
            );
            return;
          }
          this.retry(exportId);
        })
        .finally(() => this.scheduled.delete(exportId));
    });
  }

  private async process(exportId: string): Promise<void> {
    let fence = this.failureFences.get(exportId);
    if (
      fence &&
      !(await this.repository.isExportClaimCurrent(exportId, fence))
    ) {
      this.failureFences.delete(exportId);
      this.retryCounts.delete(exportId);
      return;
    }
    if (!fence) {
      const claimed = await this.repository.claimQueuedExportJob(exportId);
      if (!claimed) {
        this.failureFences.delete(exportId);
        this.retryCounts.delete(exportId);
        return;
      }
      fence = claimed.fence;
      this.failureFences.set(exportId, fence);
    }
    let leaseLost = false;
    let renewalInProgress = false;
    const leaseTimer = setInterval(() => {
      if (renewalInProgress || leaseLost || this.destroyed) return;
      renewalInProgress = true;
      void this.repository
        .renewExportClaim(exportId, fence!)
        .then((renewed) => {
          if (!renewed) leaseLost = true;
        })
        .catch(() => {
          leaseLost = true;
        })
        .finally(() => {
          renewalInProgress = false;
        });
    }, BulkExportService.LEASE_RENEW_INTERVAL_MS);
    leaseTimer.unref();
    try {
      if (!this.source || !this.storage) {
        await this.repository.failProcessingExportJob(exportId, fence);
        this.failureFences.delete(exportId);
        this.retryCounts.delete(exportId);
        return;
      }
      let file: { format: ExportFormat; contentRef: string };
      let snapshot: ExportSnapshot;
      try {
        const job = await this.repository.findExportJobByExportId(exportId);
        if (!job || (job.format !== 'CSV' && job.format !== 'XLSX'))
          throw new Error('Export format is invalid');
        const requestedAt = job.createdAt.toISOString();
        const [catalog, pricing, inventory] = await Promise.all([
          this.readAll((cursor, limit, signal) =>
            this.source!.catalog(cursor, limit, signal),
          ),
          this.readAll(
            (cursor, limit, signal, at) =>
              this.source!.pricing(cursor, limit, signal, at!),
            requestedAt,
          ),
          this.readAll((cursor, limit, signal) =>
            this.source!.inventory(cursor, limit, signal),
          ),
        ]);
        snapshot = {
          requestedAt,
          catalogObservedAt: catalog.observedAt,
          pricingObservedAt: pricing.observedAt,
          inventoryObservedAt: inventory.observedAt,
          catalogVersion: catalog.version,
          pricingVersion: pricing.version,
          inventoryVersion: inventory.version,
        };
        const rows = consolidateExportRows({
          catalog: catalog.items,
          prices: pricing.items,
          stock: inventory.items,
          snapshot,
        });
        const bytes =
          job.format === 'CSV' ? createExportCsv(rows) : createExportXlsx(rows);
        const contentType =
          job.format === 'CSV'
            ? 'text/csv; charset=utf-8'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        const attemptId = randomUUID();
        if (
          leaseLost ||
          !(await this.repository.isExportClaimCurrent(exportId, fence))
        )
          return;
        if (bytes.byteLength > BulkExportService.MAX_EXPORT_BYTES)
          throw new Error('Export exceeds the configured safe byte limit');
        const contentRef = await this.storage.put(
          bytes,
          contentType,
          `exports/${exportId}/${fence}/${attemptId}.${job.format.toLowerCase()}`,
        );
        file = { format: job.format, contentRef };
      } catch {
        await this.repository.failProcessingExportJob(exportId, fence);
        this.failureFences.delete(exportId);
        this.retryCounts.delete(exportId);
        return;
      }
      if (
        leaseLost ||
        !(await this.repository.isExportClaimCurrent(exportId, fence))
      ) {
        await this.removeUnpublishedArtifact(exportId, fence, file.contentRef);
        return;
      }
      // Database failures here remain retryable. Each retry writes to a unique
      // immutable object path, so a stale attempt cannot overwrite a published file.
      let completed;
      try {
        completed = await this.repository.completeExportJob(
          exportId,
          { format: file.format, contentRef: file.contentRef },
          fence,
          snapshot,
        );
      } catch (error) {
        if (isConfirmedTransactionRollback(error)) {
          // An acknowledged database rejection is terminal for that attempt;
          // cleanup still requires a fresh durable reference check.
          await this.removeUnpublishedArtifact(
            exportId,
            fence,
            file.contentRef,
          );
        } else {
          // A connection loss or unknown failure can arrive while COMMIT is
          // still in flight. A negative read is not proof of rollback.
          await this.preserveUncertainArtifact(
            exportId,
            fence,
            file.contentRef,
          );
          // Do not retry against a row whose original completion may still be
          // executing. Recovery can reclaim only after the DB lease expires.
          this.failureFences.delete(exportId);
          this.retryCounts.delete(exportId);
          throw new ExportCompletionOutcomeUncertainError(error);
        }
        throw error;
      }
      this.failureFences.delete(exportId);
      this.retryCounts.delete(exportId);
      if (!completed) {
        // A null result is a confirmed fencing rejection, but still reconcile
        // so this attempt can never delete an artifact referenced durably.
        await this.removeUnpublishedArtifact(exportId, fence, file.contentRef);
        return;
      }
    } finally {
      clearInterval(leaseTimer);
    }
  }

  private async removeUnpublishedArtifact(
    exportId: string,
    fence: string,
    contentRef: string,
  ): Promise<void> {
    const bucket = process.env.BULK_STORAGE_BUCKET;
    if (
      !bucket ||
      !contentRef.startsWith(
        `supabase://${bucket}/exports/${exportId}/${fence}/`,
      )
    ) {
      this.logger.warn(
        `Se conserva un objeto cuya propiedad no pudo verificarse para la exportación ${exportId}: ${contentRef}`,
      );
      return;
    }
    try {
      if (await this.repository.isExportArtifactReferenced(contentRef)) {
        this.logger.log(
          `Se conserva el objeto referenciado por PostgreSQL para la exportación ${exportId}.`,
        );
        return;
      }
      await this.storage?.remove(contentRef);
    } catch {
      this.logger.warn(
        `No se pudo reconciliar el objeto de la exportación ${exportId}; se conserva para conciliación: ${contentRef}`,
      );
    }
  }

  private async preserveUncertainArtifact(
    exportId: string,
    fence: string,
    contentRef: string,
  ): Promise<void> {
    try {
      if (await this.repository.isExportArtifactReferenced(contentRef)) {
        this.logger.log(
          `La exportación ${exportId} ya tiene referencia durable; se conserva el objeto ${contentRef}.`,
        );
        return;
      }
      this.logger.warn(
        `La referencia ${contentRef} aún no aparece en PostgreSQL, pero el resultado de COMMIT es incierto; se conserva para conciliación.`,
      );
    } catch {
      this.logger.error(
        `PostgreSQL no está disponible para conciliar ${contentRef}; se conserva para revisión operativa.`,
      );
    }
    try {
      await this.repository.recordExportArtifactForReconciliation({
        exportId,
        fence,
        contentRef,
        reason: 'COMPLETION_OUTCOME_UNCERTAIN',
      });
    } catch {
      // If PostgreSQL itself is unreachable, this log is the remaining
      // existing operational signal; the object is still never removed.
      this.logger.error(
        `No se pudo persistir el registro de conciliación de ${contentRef}; el objeto se conserva.`,
      );
    }
  }

  private async readAll<T>(
    read: (
      cursor: string | null,
      limit: number,
      signal: AbortSignal,
      at?: string,
    ) => Promise<ExportPage<T>>,
    at?: string,
  ): Promise<{ items: T[]; observedAt: string; version: string }> {
    const items: T[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let observedAt: string | undefined;
    let version: string | undefined;
    do {
      const controller = new AbortController();
      let timer: NodeJS.Timeout;
      let page: ExportPage<T>;
      try {
        page = await Promise.race([
          read(cursor, 250, controller.signal, at),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error('Export provider timed out'));
            }, 15_000);
            timer.unref();
          }),
        ]);
      } finally {
        clearTimeout(timer!);
      }
      if (
        !page ||
        !Array.isArray(page.items) ||
        !(
          page.nextCursor === null ||
          (typeof page.nextCursor === 'string' && page.nextCursor.length > 0)
        ) ||
        typeof page.observedAt !== 'string' ||
        !Number.isFinite(Date.parse(page.observedAt)) ||
        typeof page.version !== 'string' ||
        page.version.length === 0
      )
        throw new Error('Invalid export provider page');
      if (items.length + page.items.length > BulkExportService.MAX_EXPORT_ROWS)
        throw new Error('Export exceeds the configured safe row limit');
      if (
        observedAt !== undefined &&
        (observedAt !== page.observedAt || version !== page.version)
      )
        throw new Error('Provider snapshot changed between pages');
      observedAt = page.observedAt;
      version = page.version;
      items.push(...page.items);
      if (
        page.nextCursor !== null &&
        (cursors.has(page.nextCursor) || cursors.size >= 9999)
      )
        throw new Error('Export pagination cursor did not advance');
      if (page.nextCursor !== null) cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor !== null);
    if (observedAt === undefined || version === undefined)
      throw new Error('Provider returned no snapshot metadata');
    return { items, observedAt, version };
  }

  private retry(exportId: string): void {
    const attempt = (this.retryCounts.get(exportId) ?? 0) + 1;
    this.retryCounts.set(exportId, attempt);
    const delay = Math.min(
      BulkExportService.RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 16),
      BulkExportService.RETRY_MAX_MS,
    );
    this.logger.warn(
      'Fallo técnico al persistir una transición de exportación; se reintentará.',
    );
    const timer = setTimeout(() => {
      this.retryTimers.delete(exportId);
      this.schedule(exportId);
    }, delay);
    timer.unref();
    this.retryTimers.set(exportId, timer);
  }

  private toDto(job: {
    exportId: string;
    status: string;
    format: string;
    createdAt: Date;
    completedAt: Date | null;
  }) {
    return {
      export_id: job.exportId,
      status: job.status,
      formato: job.format,
      download_url: null,
      created_at: job.createdAt.toISOString(),
      completed_at: job.completedAt?.toISOString() ?? null,
    };
  }
}

function assertExportId(exportId: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      exportId,
    )
  ) {
    throw new BulkDomainError('EXPORT_NOT_FOUND', 'La exportación no existe.');
  }
}

function isExportManifestForJob(
  manifest: {
    contentRef: string;
    metadata: Record<string, unknown>;
  },
  exportId: string,
  createdAt: Date,
  format: string,
): boolean {
  if (format !== 'CSV' && format !== 'XLSX') return false;
  const bucket = process.env.BULK_STORAGE_BUCKET;
  if (!bucket) return false;
  const prefix = `supabase://${bucket}/exports/${exportId}/`;
  const metadata = manifest.metadata;
  const expected = [
    'requested_at',
    'catalog_observed_at',
    'pricing_observed_at',
    'inventory_observed_at',
    'catalog_version',
    'pricing_version',
    'inventory_version',
  ];
  return (
    manifest.contentRef.startsWith(prefix) &&
    /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(csv|xlsx)$/i.test(
      manifest.contentRef.slice(prefix.length),
    ) &&
    metadata.export_id === exportId &&
    metadata.requested_at === createdAt.toISOString() &&
    expected.every(
      (key) =>
        typeof metadata[key] === 'string' &&
        (key.endsWith('_observed_at')
          ? Number.isFinite(Date.parse(metadata[key] as string))
          : !key.endsWith('_version') || (metadata[key] as string).length > 0),
    )
  );
}
