import { randomUUID } from 'node:crypto';
import { BulkExportService } from './bulk-export.service.js';
import { BulkPersistenceError } from './persistence/bulk.persistence.errors.js';
import { BulkPersistenceRepository } from './persistence/bulk.repository.js';
import type {
  BulkExportSource,
  ExportPage,
} from './export/bulk-export-source.js';

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

  it.each(['CSV', 'XLSX'] as const)(
    'generates, stores and serves a real paginated %s file',
    async (format) => {
      const previousBucket = process.env.BULK_STORAGE_BUCKET;
      process.env.BULK_STORAGE_BUCKET = 'exports';
      const exportId = randomUUID();
      const observedAt = '2026-11-05T00:00:00.000Z';
      const products = Array.from({ length: 251 }, (_value, index) => ({
        productId: `product-${index}`,
        skuBase: `SKU-${index}`,
        variantSku: null,
        name: index === 0 ? '=1+1' : `Product ${index}`,
        description: null,
        categoryId: 'category',
        brandId: 'brand',
        productTypeId: 'type',
      }));
      const paged = <T>(items: T[], cursor: string | null): ExportPage<T> => {
        const start = cursor === null ? 0 : Number(cursor);
        const end = Math.min(start + 250, items.length);
        return {
          items: items.slice(start, end),
          nextCursor: end < items.length ? String(end) : null,
          observedAt,
          version: 'v1',
        };
      };
      const source: BulkExportSource = {
        catalog: vi.fn(async (cursor) => paged(products, cursor)),
        pricing: vi.fn(async (cursor) =>
          paged(
            products.map((product) => ({
              productId: product.productId,
              sku: null,
              regular: 10,
              offer: null,
              offerStartsAt: null,
              offerEndsAt: null,
            })),
            cursor,
          ),
        ),
        inventory: vi.fn(async (cursor) =>
          paged(
            products.map((product) => ({
              sku: product.skuBase,
              locationId: 'location-1',
              onHand: 4,
              reserved: 1,
              blocked: 0,
            })),
            cursor,
          ),
        ),
      };
      const job = {
        exportId,
        status: 'QUEUED',
        format,
        outputFileId: null as string | null,
        createdAt: new Date('2026-11-05T00:00:00.000Z'),
        completedAt: null as Date | null,
      };
      let manifest: {
        id: string;
        role: string;
        format: string;
        contentRef: string;
        metadata: Record<string, unknown>;
      } | null = null;
      let bytes = Buffer.alloc(0);
      const stored = new Map<string, Buffer>();
      const repository = {
        createExportJob: vi.fn(async (input) => {
          job.exportId = input.exportId;
          return job;
        }),
        claimQueuedExportJob: vi.fn(async () => {
          job.status = 'PROCESSING';
          return { job, fence: '123' };
        }),
        isExportClaimCurrent: vi.fn(async () => true),
        findExportJobByExportId: vi.fn(async () => job),
        completeExportJob: vi.fn(async (_id, input, _fence, snapshot) => {
          manifest = {
            id: 'manifest-1',
            role: 'RESULTADO_EXPORTACION',
            format: input.format,
            contentRef: input.contentRef,
            metadata: {
              export_id: job.exportId,
              requested_at: snapshot.requestedAt,
              catalog_observed_at: snapshot.catalogObservedAt,
              pricing_observed_at: snapshot.pricingObservedAt,
              inventory_observed_at: snapshot.inventoryObservedAt,
              catalog_version: snapshot.catalogVersion,
              pricing_version: snapshot.pricingVersion,
              inventory_version: snapshot.inventoryVersion,
            },
          };
          job.status = 'COMPLETED';
          job.outputFileId = manifest.id;
          job.completedAt = new Date();
          return job;
        }),
        failProcessingExportJob: vi.fn(async () => {
          job.status = 'FAILED_GENERAL';
          return job;
        }),
        listQueuedExportJobs: vi.fn(async () => []),
        findFileManifest: vi.fn(async () => manifest),
      };
      const storage = {
        put: vi.fn(async (content: Buffer, _type: string, path: string) => {
          bytes = Buffer.from(content);
          stored.set(path, bytes);
          return `supabase://exports/${path}`;
        }),
        get: vi.fn(async (ref: string) => {
          const path = ref.replace('supabase://exports/', '');
          return stored.get(path) ?? Buffer.alloc(0);
        }),
      };
      const service = new BulkExportService(
        repository as never,
        storage as never,
        source,
      );
      try {
        await service.create(format);
        await vi.waitFor(() => expect(job.status).toBe('COMPLETED'));
        expect(source.catalog).toHaveBeenCalledTimes(2);
        expect(source.pricing).toHaveBeenCalledTimes(2);
        expect(source.inventory).toHaveBeenCalledTimes(2);
        expect(repository.completeExportJob).toHaveBeenCalledTimes(1);
        expect(source.pricing).toHaveBeenCalledWith(
          null,
          250,
          expect.any(AbortSignal),
          job.createdAt.toISOString(),
        );
        expect(manifest?.role).toBe('RESULTADO_EXPORTACION');
        expect(manifest).toMatchObject({
          format,
          contentRef: expect.stringMatching(
            new RegExp(
              `^supabase://exports/exports/${job.exportId}/123/.+\\.${format.toLowerCase()}$`,
            ),
          ),
          metadata: {
            export_id: job.exportId,
            requested_at: job.createdAt.toISOString(),
          },
        });
        const downloaded = await service.download(job.exportId);
        const delivered = await storage.get(downloaded.manifest.contentRef);
        expect(delivered).toEqual(bytes);
        if (format === 'CSV') {
          expect(delivered.toString('utf8').split('\r\n')).toHaveLength(253);
          expect(delivered.toString('utf8')).toContain("'=1+1");
        } else {
          expect(delivered.subarray(0, 4).toString('hex')).toBe('504b0304');
          expect(delivered.toString('utf8')).toContain(
            'xl/worksheets/sheet1.xml',
          );
          expect(delivered.toString('utf8')).toContain('&apos;=1+1');
        }
      } finally {
        service.onModuleDestroy();
        if (previousBucket === undefined)
          delete process.env.BULK_STORAGE_BUCKET;
        else process.env.BULK_STORAGE_BUCKET = previousBucket;
      }
    },
  );

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
