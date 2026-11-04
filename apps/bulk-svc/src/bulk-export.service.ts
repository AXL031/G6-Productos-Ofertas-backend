import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mapBulkPersistenceError } from './domain/bulk.errors.js';
import { BulkDomainError } from './domain/bulk.domain-error.js';
import { BulkPersistenceRepository } from './persistence/bulk.repository.js';

export type ExportFormat = 'CSV' | 'XLSX';

/**
 * Durable admission/query boundary for the consolidated export. The source
 * adapters are intentionally not substituted with local fixtures: until each
 * authorized provider is configured, accepted jobs terminate as FAILED_GENERAL.
 */
@Injectable()
export class BulkExportService implements OnModuleInit, OnModuleDestroy {
  private static readonly PROCESSING_LEASE_MS = 60_000;
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

  constructor(private readonly repository: BulkPersistenceRepository) {}

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
        !manifest.contentRef.trim()
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
        .catch(() => this.retry(exportId))
        .finally(() => this.scheduled.delete(exportId));
    });
  }

  private async process(exportId: string): Promise<void> {
    let fence = this.failureFences.get(exportId);
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
    // No authorized/provider-complete read adapters exist for Catalog, Pricing
    // and Inventory. Fail closed; never publish a partial file.
    await this.repository.failProcessingExportJob(exportId, fence);
    this.failureFences.delete(exportId);
    this.retryCounts.delete(exportId);
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
