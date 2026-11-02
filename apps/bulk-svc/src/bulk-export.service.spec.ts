import { randomUUID } from 'node:crypto';
import { BulkExportService } from './bulk-export.service.js';
import { BulkPersistenceError } from './persistence/bulk.persistence.errors.js';
import { BulkPersistenceRepository } from './persistence/bulk.repository.js';

describe('BulkExportService (isolated)', () => {
  it('persists valid admission and closes missing-source jobs without output', async () => {
    const job = {
      exportId: randomUUID(),
      status: 'QUEUED',
      format: 'CSV',
      outputFileId: null,
      createdAt: new Date('2026-11-02T00:00:00.000Z'),
      completedAt: null,
    };
    const repository = {
      createExportJob: vi.fn(
        async (input: { exportId: string; format: string }) => ({
          ...job,
          exportId: input.exportId,
          format: input.format,
        }),
      ),
      claimQueuedExportJob: vi.fn(async () => ({
        job: { ...job, status: 'PROCESSING' },
        fence: 'test-fence',
      })),
      failProcessingExportJob: vi.fn(async () => ({
        ...job,
        status: 'FAILED_GENERAL',
      })),
      listQueuedExportJobs: vi.fn().mockResolvedValue([]),
    };
    const service = new BulkExportService(repository as never);
    const accepted = await service.create('CSV');
    expect(repository.createExportJob).toHaveBeenCalledWith({
      exportId: accepted.export_id,
      format: 'CSV',
    });
    expect(accepted).toMatchObject({
      status: 'QUEUED',
      formato: 'CSV',
      download_url: null,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(repository.claimQueuedExportJob).toHaveBeenCalledWith(
      accepted.export_id,
    );
    expect(repository.failProcessingExportJob).toHaveBeenCalledWith(
      accepted.export_id,
      'test-fence',
    );
  });

  it('rejects unsupported formats before persistence', async () => {
    const repository = { createExportJob: vi.fn() };
    const service = new BulkExportService(repository as never);
    await expect(service.create('PDF' as never)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(repository.createExportJob).not.toHaveBeenCalled();
  });

  it('backs off when PostgreSQL is not configured and cancels retries on shutdown', async () => {
    vi.useFakeTimers();
    const repository = new BulkPersistenceRepository(null);
    const sweep = vi.spyOn(repository, 'requeueStaleProcessingExports');
    const service = new BulkExportService(repository);
    try {
      service.onModuleInit();
      await vi.advanceTimersByTimeAsync(0);
      expect(sweep).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(249);
      expect(sweep).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sweep).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(499);
      expect(sweep).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(sweep).toHaveBeenCalledTimes(3);

      let attempts = 3;
      for (const delay of [
        1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
      ]) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(sweep).toHaveBeenCalledTimes(attempts);
        await vi.advanceTimersByTimeAsync(1);
        attempts += 1;
        expect(sweep).toHaveBeenCalledTimes(attempts);
      }

      service.onModuleDestroy();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sweep).toHaveBeenCalledTimes(attempts);
    } finally {
      service.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('resumes the global recovery sweep when PostgreSQL becomes available', async () => {
    vi.useFakeTimers();
    let available = false;
    const repository = {
      requeueStaleProcessingExports: vi.fn(async () => {
        if (!available) throw new BulkPersistenceError('NOT_CONFIGURED');
        return [];
      }),
      listQueuedExportJobs: vi.fn().mockResolvedValue([]),
    };
    const service = new BulkExportService(repository as never);
    try {
      service.onModuleInit();
      await vi.advanceTimersByTimeAsync(0);
      expect(repository.requeueStaleProcessingExports).toHaveBeenCalledTimes(1);
      expect(repository.listQueuedExportJobs).not.toHaveBeenCalled();

      available = true;
      await vi.advanceTimersByTimeAsync(250);
      expect(repository.requeueStaleProcessingExports).toHaveBeenCalledTimes(2);
      expect(repository.listQueuedExportJobs).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      service.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('does not reactivate recovery timers when a sweep finishes after shutdown', async () => {
    vi.useFakeTimers();
    let finishSweep: ((jobs: never[]) => void) | undefined;
    const repository = {
      requeueStaleProcessingExports: vi.fn(
        () =>
          new Promise<never[]>((resolve) => {
            finishSweep = resolve;
          }),
      ),
      listQueuedExportJobs: vi.fn().mockResolvedValue([]),
    };
    const service = new BulkExportService(repository as never);
    try {
      service.onModuleInit();
      expect(finishSweep).toBeDefined();
      service.onModuleDestroy();
      finishSweep!([]);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
      expect(repository.listQueuedExportJobs).toHaveBeenCalledTimes(1);
    } finally {
      service.onModuleDestroy();
      vi.useRealTimers();
    }
  });
});
