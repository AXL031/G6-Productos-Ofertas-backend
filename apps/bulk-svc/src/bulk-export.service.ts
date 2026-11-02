import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BulkDomainError } from './domain/bulk.domain-error.js';
import { BulkPersistenceRepository } from './persistence/bulk.repository.js';

export type ExportFormat = 'CSV' | 'XLSX';

/**
 * Durable admission/query boundary for the consolidated export. The source
 * adapters are intentionally not substituted with local fixtures: until each
 * authorized provider is configured, accepted jobs terminate as FAILED_GENERAL.
 */
@Injectable()
export class BulkExportService implements OnModuleInit {
  private readonly scheduled = new Set<string>();

  constructor(private readonly repository: BulkPersistenceRepository) {}

  onModuleInit(): void {
    // Re-submit durable QUEUED work after restart. A DB claim makes concurrent
    // workers mutually exclusive before any source is read.
    void this.resumeQueuedExports().catch(() => undefined);
  }

  async create(format: ExportFormat) {
    if (format !== 'CSV' && format !== 'XLSX') {
      throw new BulkDomainError(
        'INVALID_INPUT',
        'formato debe ser CSV o XLSX.',
      );
    }
    const exportId = randomUUID();
    const job = await this.repository.createExportJob({ exportId, format });
    this.schedule(exportId);
    return this.toDto(job);
  }

  async get(exportId: string) {
    assertExportId(exportId);
    const job = await this.repository.findExportJobByExportId(exportId);
    if (!job)
      throw new BulkDomainError(
        'EXPORT_NOT_FOUND',
        'La exportación no existe.',
      );
    return this.toDto(job);
  }

  async download(exportId: string) {
    assertExportId(exportId);
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
    if (!manifest || manifest.role !== 'RESULTADO_EXPORTACION') {
      throw new BulkDomainError(
        'EXPORT_NOT_READY',
        'La exportación no tiene un archivo completo disponible.',
      );
    }
    return { job, manifest };
  }

  private async resumeQueuedExports(): Promise<void> {
    const jobs = await this.repository.listQueuedExportJobs();
    for (const job of jobs) this.schedule(job.exportId);
  }

  private schedule(exportId: string): void {
    if (this.scheduled.has(exportId)) return;
    this.scheduled.add(exportId);
    setImmediate(() => {
      void this.process(exportId)
        .catch(() => undefined)
        .finally(() => this.scheduled.delete(exportId));
    });
  }

  private async process(exportId: string): Promise<void> {
    const claimed = await this.repository.transitionExportJob(
      exportId,
      ['QUEUED'],
      'PROCESSING',
    );
    if (!claimed) return;
    // No authorized/provider-complete read adapters exist for Catalog, Pricing
    // and Inventory on this base. Fail closed; never publish a partial file.
    await this.repository.transitionExportJob(
      exportId,
      ['PROCESSING'],
      'FAILED_GENERAL',
    );
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
