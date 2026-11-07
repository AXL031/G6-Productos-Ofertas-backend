import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BulkSvcController } from '../bulk-svc.controller.js';
import { BulkSvcService } from '../bulk-svc.service.js';
import { BulkImportService } from '../bulk-import.service.js';
import { BulkStorageService } from '../storage/bulk-storage.service.js';
import { BulkReadinessService } from '../health/bulk-readiness.service.js';
import { BulkUserBearerGuard } from '../auth/bulk-user-bearer.guard.js';
import { BulkProblemFilter } from '../http/bulk-problem.filter.js';
import { BulkExportService } from '../bulk-export.service.js';
import type { BulkExportSource } from '../export/bulk-export-source.js';
import { parseBulkEnvironment } from '../config/bulk-environment.js';
import {
  bulkSchema,
  batchJobs,
  batchRows,
  exportJobs,
  fileManifests,
  inbox,
  outbox,
  rowDomainSteps,
} from './bulk.schema.js';
import { BulkPersistenceError } from './bulk.persistence.errors.js';
import {
  BulkPersistenceRepository,
  type UpdateWorkflowStateInput,
} from './bulk.repository.js';

const testUrl = process.env.BULK_TEST_DATABASE_URL;
const integration = testUrl ? describe : describe.skip;
let pool: Pool;
let repository: BulkPersistenceRepository;
let database: ReturnType<typeof drizzle<typeof bulkSchema>>;

async function waitForExport(exportId: string, status: string) {
  const deadline = Date.now() + 5_000;
  let job = await repository.findExportJobByExportId(exportId);
  while (job?.status !== status && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    job = await repository.findExportJobByExportId(exportId);
  }
  expect(job?.status).toBe(status);
  return job!;
}

integration('BulkPersistenceRepository with PostgreSQL 17 migration', () => {
  beforeAll(async () => {
    if (process.env.NODE_ENV !== 'test')
      throw new Error('NODE_ENV=test is required for local integration tests');
    const parsed = parseBulkEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: testUrl,
    });
    if (!parsed.databaseUrl)
      throw new Error('BULK_TEST_DATABASE_URL is required');
    const url = new URL(parsed.databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !testUrl?.includes('sslmode=disable')
    ) {
      throw new Error(
        'Integration tests require loopback PostgreSQL and explicit sslmode=disable',
      );
    }
    pool = new Pool({
      connectionString: parsed.databaseUrl,
      ssl: parsed.databaseSsl,
      max: 2,
      connectionTimeoutMillis: parsed.databaseConnectionTimeoutMs,
      query_timeout: parsed.databaseQueryTimeoutMs,
      statement_timeout: parsed.databaseQueryTimeoutMs,
      idleTimeoutMillis: parsed.databaseIdleTimeoutMs,
    });
    database = drizzle(pool, { schema: bulkSchema, logger: false });
    repository = new BulkPersistenceRepository(database);
    const version = await pool.query('SHOW server_version_num');
    expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(
      170000,
    );
    expect(Number(version.rows[0]?.server_version_num)).toBeLessThan(180000);
    await pool.query('SELECT 1 FROM bulk.file_manifests LIMIT 0');
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
  });

  const importBatch = (
    rows: Array<{
      rowId: string;
      requiredDomains: Array<'CATALOGO' | 'PRICING' | 'INVENTARIO'>;
    }>,
    admissionIntent?: Record<string, unknown>,
  ) =>
    repository.createImportBatch({
      batchId: randomUUID(),
      templateVersion: 2,
      correlationId: randomUUID(),
      inputFile: { format: 'CSV', contentRef: `test://${randomUUID()}` },
      rows,
      admissionIntent,
    });

  it('inserts/query manifests and atomically creates a batch with rows and domain steps', async () => {
    const created = await importBatch([
      { rowId: randomUUID(), requiredDomains: ['CATALOGO', 'PRICING'] },
      { rowId: randomUUID(), requiredDomains: ['INVENTARIO'] },
    ]);
    expect(created.manifest.role).toBe('ENTRADA_IMPORTACION');
    expect(
      (await repository.findBatchByBatchId(created.batch.batchId))?.id,
    ).toBe(created.batch.id);
    expect(
      (await repository.listBatchRows(created.batch.batchId))
        .map((row) => row.id)
        .sort(),
    ).toEqual(created.rows.map(({ row }) => row.id).sort());
    expect(
      (
        await repository.listRowSteps(
          created.batch.batchId,
          created.rows[0]!.row.rowId,
        )
      ).map((step) => step.domain),
    ).toEqual(['CATALOGO', 'PRICING']);
  });

  it('deduplicates results by command and row identity without colliding across rows', async () => {
    const batchId = randomUUID();
    const correlationId = randomUUID();
    const rowA = randomUUID();
    const rowB = randomUUID();
    await repository.createImportBatch({
      batchId,
      correlationId,
      templateVersion: 2,
      inputFile: { format: 'CSV', contentRef: `test://${randomUUID()}` },
      rows: [rowA, rowB].map((rowId) => ({
        rowId,
        requiredDomains: ['CATALOGO' as const],
      })),
      admissionIntent: {
        rows: [rowA, rowB].map((rowId, index) => ({
          rowId,
          vendibleSkus: [`SKU-${index}`],
          stockInicial: 0,
          defaultLocationId: null,
        })),
      },
    });
    const commandId = randomUUID();
    const result = (rowId: string, messageId: string) =>
      repository.recordDomainResult({
        batchId,
        rowId,
        domain: 'CATALOGO',
        operationId: commandId,
        messageId,
        correlationId,
        eventName: 'catalog.bulk.upsert.completed',
        action: 'UPSERT',
        status: 'COMPLETED',
      });
    expect(await result(rowA, randomUUID())).toMatchObject({ processed: true });
    expect(await result(rowB, randomUUID())).toMatchObject({ processed: true });
    expect(await result(rowA, randomUUID())).toMatchObject({
      processed: false,
    });
  });

  it('applies per-row Catalog results from one completed command without false successes', async () => {
    const batchId = randomUUID();
    const correlationId = randomUUID();
    const completedRow = randomUUID();
    const rejectedRow = randomUUID();
    await repository.createImportBatch({
      batchId,
      correlationId,
      templateVersion: 2,
      inputFile: { format: 'CSV', contentRef: `test://${randomUUID()}` },
      rows: [completedRow, rejectedRow].map((rowId) => ({
        rowId,
        requiredDomains: ['CATALOGO' as const],
      })),
      admissionIntent: {
        rows: [completedRow, rejectedRow].map((rowId) => ({
          rowId,
          vendibleSkus: ['SKU-1'],
          stockInicial: 0,
          defaultLocationId: null,
        })),
      },
    });
    const batchOperationId = randomUUID();
    const completed = {
      batchId,
      rowId: completedRow,
      domain: 'CATALOGO' as const,
      operationId: batchOperationId,
      messageId: randomUUID(),
      correlationId,
      eventName: 'catalog.bulk.upsert.completed',
      action: 'UPSERT' as const,
      status: 'COMPLETED' as const,
    };
    const rejected = {
      batchId,
      rowId: rejectedRow,
      domain: 'CATALOGO' as const,
      operationId: batchOperationId,
      messageId: randomUUID(),
      correlationId,
      eventName: 'catalog.bulk.upsert.completed',
      action: 'UPSERT' as const,
      status: 'FAILED' as const,
      errorCode: 'VALIDACION',
      errorDetail: 'Fila rechazada por Catalog',
    };
    expect(await repository.recordDomainResult(completed)).toMatchObject({
      processed: true,
    });
    expect(await repository.recordDomainResult(rejected)).toMatchObject({
      processed: true,
    });
    expect(await repository.recordDomainResult(completed)).toMatchObject({
      processed: false,
    });
    expect(await repository.recordDomainResult(rejected)).toMatchObject({
      processed: false,
    });
    const commandRejectedBatchId = randomUUID();
    const commandRejectedRowId = randomUUID();
    const commandRejectedCorrelationId = randomUUID();
    await repository.createImportBatch({
      batchId: commandRejectedBatchId,
      correlationId: commandRejectedCorrelationId,
      templateVersion: 2,
      inputFile: { format: 'CSV', contentRef: `test://${randomUUID()}` },
      rows: [{ rowId: commandRejectedRowId, requiredDomains: ['CATALOGO'] }],
      admissionIntent: {
        rows: [
          {
            rowId: commandRejectedRowId,
            vendibleSkus: ['SKU-CMD-REJECT'],
            stockInicial: 0,
            defaultLocationId: null,
          },
        ],
      },
    });
    await expect(
      repository.recordDomainResult({
        ...rejected,
        batchId: commandRejectedBatchId,
        rowId: commandRejectedRowId,
        operationId: randomUUID(),
        messageId: randomUUID(),
        correlationId: commandRejectedCorrelationId,
        eventName: 'catalog.bulk.upsert.rejected',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(await repository.findBatchByBatchId(batchId)).toMatchObject({
      status: 'COMPLETED',
      totalRows: 2,
      completedRows: 1,
      failedRows: 1,
    });
    const rows = await repository.listBatchRows(batchId);
    expect(rows.find((row) => row.rowId === completedRow)).toMatchObject({
      status: 'COMPLETED',
      appliedDomains: ['CATALOGO'],
      failedDomain: null,
    });
    expect(rows.find((row) => row.rowId === rejectedRow)).toMatchObject({
      status: 'FAILED',
      appliedDomains: [],
      failedDomain: 'CATALOGO',
      errorCode: 'VALIDACION',
      needsReconciliation: false,
    });
  });

  it('matches all seven migration table columns, nullability and default presence', async () => {
    const actual = await pool.query(
      `SELECT table_name, column_name, udt_name, is_nullable, column_default IS NOT NULL AS has_default
       FROM information_schema.columns WHERE table_schema='bulk'
         AND table_name IN ('file_manifests','batch_jobs','batch_rows','row_domain_steps','export_jobs','outbox','inbox')
       ORDER BY table_name, column_name`,
    );
    const tables = [
      fileManifests,
      batchJobs,
      batchRows,
      rowDomainSteps,
      exportJobs,
      outbox,
      inbox,
    ];
    const expected = tables
      .flatMap((table) =>
        getTableConfig(table).columns.map((column) => ({
          table_name: getTableConfig(table).name,
          column_name: column.name,
          udt_name:
            column.getSQLType() === 'timestamp with time zone'
              ? 'timestamptz'
              : column.getSQLType() === 'text[]'
                ? '_text'
                : column.getSQLType() === 'integer'
                  ? 'int4'
                  : column.getSQLType() === 'boolean'
                    ? 'bool'
                    : column.getSQLType(),
          is_nullable: column.notNull ? 'NO' : 'YES',
          has_default: column.hasDefault,
        })),
      )
      .concat({
        table_name: 'file_manifests',
        column_name: 'metadata',
        udt_name: 'jsonb',
        is_nullable: 'NO',
        has_default: true,
      })
      .sort((a, b) =>
        `${a.table_name}.${a.column_name}`.localeCompare(
          `${b.table_name}.${b.column_name}`,
        ),
      );
    const migrated = actual.rows
      .map((row) => ({
        ...row,
        has_default: row.has_default === true,
      }))
      .sort((a, b) =>
        `${a.table_name}.${a.column_name}`.localeCompare(
          `${b.table_name}.${b.column_name}`,
        ),
      );
    expect(migrated).toEqual(expected);
  });

  it('rolls back manifest, batch, rows and steps when an intermediate row violates uniqueness', async () => {
    const batchId = randomUUID();
    const ref = `test://${randomUUID()}`;
    const duplicateRowId = randomUUID();
    try {
      await repository.createImportBatch({
        batchId,
        templateVersion: 2,
        correlationId: randomUUID(),
        inputFile: { format: 'CSV', contentRef: ref },
        rows: [
          { rowId: randomUUID(), requiredDomains: ['CATALOGO'] },
          { rowId: duplicateRowId, requiredDomains: ['PRICING'] },
          { rowId: duplicateRowId, requiredDomains: ['INVENTARIO'] },
        ],
      });
      throw new Error('duplicate rows should reject');
    } catch (error) {
      expect(error).toMatchObject({ code: 'UNIQUE_CONFLICT' });
    }
    expect(
      await database
        .select()
        .from(fileManifests)
        .where(eq(fileManifests.contentRef, ref)),
    ).toHaveLength(0);
    expect(await repository.findBatchByBatchId(batchId)).toBeNull();
  });

  it('rolls back all inserts when an official check rejects required domains and rejects repeated row ids', async () => {
    const batchId = randomUUID();
    const ref = `test://${randomUUID()}`;
    await expect(
      repository.createImportBatch({
        batchId,
        templateVersion: 2,
        correlationId: randomUUID(),
        inputFile: { format: 'CSV', contentRef: ref },
        rows: [
          {
            rowId: randomUUID(),
            requiredDomains: ['CATALOGO', 'CATALOGO'] as never,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CHECK_VIOLATION' });
    expect(
      await database
        .select()
        .from(fileManifests)
        .where(eq(fileManifests.contentRef, ref)),
    ).toHaveLength(0);
    const duplicate = randomUUID();
    await expect(
      importBatch([
        { rowId: duplicate, requiredDomains: ['CATALOGO'] },
        { rowId: duplicate, requiredDomains: ['PRICING'] },
      ]),
    ).rejects.toMatchObject({ code: 'UNIQUE_CONFLICT' });
  });

  it('rolls back batch creation when writing a domain step fails', async () => {
    const ref = `test://${randomUUID()}`;
    const batchId = randomUUID();
    await pool.query(
      `CREATE OR REPLACE FUNCTION bulk.fn_test_fail_step_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='injected integration failure'; END $$`,
    );
    await pool.query(
      'CREATE TRIGGER trg_test_fail_step_insert BEFORE INSERT ON bulk.row_domain_steps FOR EACH ROW EXECUTE FUNCTION bulk.fn_test_fail_step_insert()',
    );
    try {
      await expect(
        repository.createImportBatch({
          batchId,
          templateVersion: 2,
          correlationId: randomUUID(),
          inputFile: { format: 'CSV', contentRef: ref },
          rows: [{ rowId: randomUUID(), requiredDomains: ['CATALOGO'] }],
        }),
      ).rejects.toMatchObject({ code: 'CHECK_VIOLATION' });
      expect(
        await database
          .select()
          .from(fileManifests)
          .where(eq(fileManifests.contentRef, ref)),
      ).toHaveLength(0);
      expect(await repository.findBatchByBatchId(batchId)).toBeNull();
    } finally {
      await pool.query(
        'DROP TRIGGER IF EXISTS trg_test_fail_step_insert ON bulk.row_domain_steps',
      );
      await pool.query(
        'DROP FUNCTION IF EXISTS bulk.fn_test_fail_step_insert()',
      );
    }
  });

  it('enforces foreign keys, invalid domains, counter constraints and final-state constraints', async () => {
    await expect(
      database.insert(batchRows).values({
        batchJobId: randomUUID(),
        rowId: randomUUID(),
        requiredDomains: ['CATALOGO'],
      }),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
    const created = await importBatch([
      { rowId: randomUUID(), requiredDomains: ['CATALOGO'] },
    ]);
    await expect(
      database
        .insert(rowDomainSteps)
        .values({ batchRowId: created.rows[0]!.row.id, domain: 'UNKNOWN' }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(
      database
        .update(batchJobs)
        .set({ totalRows: -1 })
        .where(eq(batchJobs.id, created.batch.id)),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      database
        .update(batchJobs)
        .set({ completedRows: 2 })
        .where(eq(batchJobs.id, created.batch.id)),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      database
        .update(batchRows)
        .set({ appliedDomains: ['PRICING'] })
        .where(eq(batchRows.id, created.rows[0]!.row.id)),
    ).rejects.toBeInstanceOf(Error);
    const job = await repository.createExportJob({
      exportId: randomUUID(),
      format: 'CSV',
    });
    await expect(
      database
        .update(exportJobs)
        .set({ status: 'COMPLETED' })
        .where(eq(exportJobs.id, job.id)),
    ).rejects.toBeInstanceOf(Error);
  });

  it('rejects incompatible file role/format combinations and completes exports atomically', async () => {
    const previousBucket = process.env.BULK_STORAGE_BUCKET;
    process.env.BULK_STORAGE_BUCKET = 'bulk-private-test';
    try {
      const job = await repository.createExportJob({
        exportId: randomUUID(),
        format: 'CSV',
      });
      const snapshot = {
        requestedAt: job.createdAt.toISOString(),
        catalogObservedAt: job.createdAt.toISOString(),
        pricingObservedAt: job.createdAt.toISOString(),
        inventoryObservedAt: job.createdAt.toISOString(),
        catalogVersion: 'catalog-v1',
        pricingVersion: 'pricing-v1',
        inventoryVersion: 'inventory-v1',
      };
      const ref = (fence: string, extension = 'csv') =>
        `supabase://bulk-private-test/exports/${job.exportId}/${fence}/${randomUUID()}.${extension}`;
      const before = await pool.query(
        "SELECT count(*)::int AS count FROM bulk.file_manifests WHERE role = 'RESULTADO_EXPORTACION'",
      );
      await expect(
        repository.completeExportJob(
          job.exportId,
          {
            format: 'CSV',
            contentRef: ref('0'),
          },
          'not-claimed',
          snapshot,
        ),
      ).resolves.toBeNull();
      expect(
        (await repository.findExportJobByExportId(job.exportId))?.status,
      ).toBe('QUEUED');
      const claimed = await repository.claimQueuedExportJob(job.exportId);
      expect(claimed?.job.status).toBe('PROCESSING');

      await expect(
        repository.completeExportJob(
          job.exportId,
          {
            format: 'XLSX',
            contentRef: ref(claimed!.fence, 'xlsx'),
          },
          claimed!.fence,
          snapshot,
        ),
      ).rejects.toMatchObject({ code: 'CHECK_VIOLATION' });
      for (const contentRef of [
        `test://${randomUUID()}`,
        `https://example.invalid/${randomUUID()}.csv`,
        `supabase://another-bucket/exports/${randomUUID()}.csv`,
        'supabase://bulk-private-test/',
        'supabase://bulk-private-test/exports/../outside.csv',
      ]) {
        await expect(
          repository.completeExportJob(
            job.exportId,
            {
              format: 'CSV',
              contentRef,
            },
            claimed!.fence,
            snapshot,
          ),
        ).rejects.toMatchObject({ code: 'CHECK_VIOLATION' });
      }

      const stillProcessing = await repository.findExportJobByExportId(
        job.exportId,
      );
      expect(stillProcessing).toMatchObject({
        status: 'PROCESSING',
        outputFileId: null,
        completedAt: null,
      });
      const noPartialManifest = await pool.query(
        "SELECT count(*)::int AS count FROM bulk.file_manifests WHERE role = 'RESULTADO_EXPORTACION'",
      );
      expect(noPartialManifest.rows[0]?.count).toBe(before.rows[0]?.count);

      const contentRef = ref(claimed!.fence);
      const done = await repository.completeExportJob(
        job.exportId,
        {
          format: 'CSV',
          contentRef,
        },
        claimed!.fence,
        snapshot,
      );
      expect(done?.status).toBe('COMPLETED');
      expect(done?.completedAt).toBeInstanceOf(Date);
      expect(
        await repository.findFileManifest(done!.outputFileId!),
      ).toMatchObject({
        role: 'RESULTADO_EXPORTACION',
        format: 'CSV',
        contentRef,
      });
    } finally {
      if (previousBucket === undefined) delete process.env.BULK_STORAGE_BUCKET;
      else process.env.BULK_STORAGE_BUCKET = previousBucket;
    }
  });

  it('retains a PostgreSQL-committed export when the completion response is lost and serves its download', async () => {
    const previousBucket = process.env.BULK_STORAGE_BUCKET;
    process.env.BULK_STORAGE_BUCKET = 'bulk-private-test';
    const stored = new Map<string, Buffer>();
    const removed: string[] = [];
    const storage = {
      put: async (bytes: Buffer, _contentType: string, path: string) => {
        const ref = `supabase://bulk-private-test/${path}`;
        stored.set(ref, Buffer.from(bytes));
        return ref;
      },
      get: async (ref: string) => stored.get(ref) ?? null,
      remove: async (ref: string) => {
        removed.push(ref);
        stored.delete(ref);
      },
    };
    const observedAt = new Date().toISOString();
    const page = { items: [], nextCursor: null, observedAt, version: 'v1' };
    const source: BulkExportSource = {
      catalog: async () => page,
      pricing: async () => page,
      inventory: async () => page,
    };
    const complete = repository.completeExportJob.bind(repository);
    const completeSpy = vi
      .spyOn(repository, 'completeExportJob')
      .mockImplementationOnce(async (...args) => {
        const committed = await complete(...args);
        expect(committed?.status).toBe('COMPLETED');
        throw new Error('connection lost after PostgreSQL COMMIT');
      });
    const service = new BulkExportService(repository, storage as never, source);
    try {
      const accepted = await service.create('CSV');
      const job = await waitForExport(accepted.export_id, 'COMPLETED');
      expect(completeSpy).toHaveBeenCalledTimes(1);
      expect(job.outputFileId).toBeTruthy();
      const download = await service.download(accepted.export_id);
      expect(
        await repository.isExportArtifactReferenced(
          download.manifest.contentRef,
        ),
      ).toBe(true);
      expect(
        stored.get(download.manifest.contentRef)?.byteLength,
      ).toBeGreaterThan(0);
      expect(removed).toEqual([]);
    } finally {
      service.onModuleDestroy();
      completeSpy.mockRestore();
      if (previousBucket === undefined) delete process.env.BULK_STORAGE_BUCKET;
      else process.env.BULK_STORAGE_BUCKET = previousBucket;
    }
  }, 30_000);

  it('retains and later serves an artifact when reconciliation reads before the pending PostgreSQL commit', async () => {
    const previousBucket = process.env.BULK_STORAGE_BUCKET;
    process.env.BULK_STORAGE_BUCKET = 'bulk-private-test';
    const pendingPool = new Pool({ connectionString: testUrl, max: 2 });
    const pendingRepository = new BulkPersistenceRepository(
      drizzle(pendingPool, { schema: bulkSchema, logger: false }),
    );
    const suffix = randomUUID().replaceAll('-', '');
    const fn = `bulk.delay_manifest_${suffix}`;
    const trigger = `delay_manifest_trigger_${suffix}`;
    const stored = new Map<string, Buffer>();
    const removed: string[] = [];
    const refs: string[] = [];
    const storage = {
      put: async (bytes: Buffer, _contentType: string, path: string) => {
        const ref = `supabase://bulk-private-test/${path}`;
        refs.push(ref);
        stored.set(ref, Buffer.from(bytes));
        return ref;
      },
      get: async (ref: string) => stored.get(ref) ?? null,
      remove: async (ref: string) => {
        removed.push(ref);
        stored.delete(ref);
      },
    };
    const observedAt = new Date().toISOString();
    const page = { items: [], nextCursor: null, observedAt, version: 'v1' };
    const source: BulkExportSource = {
      catalog: async () => page,
      pricing: async () => page,
      inventory: async () => page,
    };
    await pendingPool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.role = 'RESULTADO_EXPORTACION' THEN PERFORM pg_sleep(2.0); END IF;
        RETURN NEW;
      END
    $$`);
    await pendingPool.query(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON bulk.file_manifests FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );
    const complete =
      pendingRepository.completeExportJob.bind(pendingRepository);
    let pendingCommit: ReturnType<
      typeof pendingRepository.completeExportJob
    > | null = null;
    const completeSpy = vi
      .spyOn(pendingRepository, 'completeExportJob')
      .mockImplementationOnce(async (...args) => {
        pendingCommit = complete(...args);
        await vi.waitFor(
          async () => {
            const activeInsert = await pendingPool.query(
              `SELECT count(*)::int AS count FROM pg_stat_activity
               WHERE pid <> pg_backend_pid() AND state = 'active'
                 AND query ILIKE '%INSERT INTO%file_manifests%'`,
            );
            expect(activeInsert.rows[0]?.count).toBe(1);
          },
          { timeout: 5_000, interval: 20 },
        );
        // The PG statement is deliberately blocked inside the trigger. The
        // wrapper loses its response while the real transaction is still live.
        throw new Error(
          'response lost while PostgreSQL transaction is pending',
        );
      });
    const referenceReads: boolean[] = [];
    const isReferenced =
      pendingRepository.isExportArtifactReferenced.bind(pendingRepository);
    const referenceSpy = vi
      .spyOn(pendingRepository, 'isExportArtifactReferenced')
      .mockImplementation(async (ref) => {
        const result = await isReferenced(ref);
        referenceReads.push(result);
        return result;
      });
    const service = new BulkExportService(
      pendingRepository,
      storage as never,
      source,
    );
    try {
      const accepted = await service.create('CSV');
      await vi.waitFor(() => expect(referenceReads).toEqual([false]), {
        timeout: 5_000,
      });
      const ref = refs[0]!;
      expect(removed).toEqual([]);
      expect(stored.has(ref)).toBe(true);
      const reconciliation = await pendingPool.query(
        `SELECT result, payload FROM bulk.inbox
         WHERE message_id = $1 AND handler = 'bulk.export-artifact-reconciliation'`,
        [ref],
      );
      expect(reconciliation.rows[0]).toMatchObject({
        result: 'PENDING_RECONCILIATION',
        payload: {
          export_id: accepted.export_id,
          content_ref: ref,
          reason: 'COMPLETION_OUTCOME_UNCERTAIN',
        },
      });

      service.onModuleDestroy();
      await pendingCommit;
      const deadline = Date.now() + 5_000;
      let job = await pendingRepository.findExportJobByExportId(
        accepted.export_id,
      );
      while (job?.status !== 'COMPLETED' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        job = await pendingRepository.findExportJobByExportId(
          accepted.export_id,
        );
      }
      expect(job?.status).toBe('COMPLETED');
      expect(job.outputFileId).toBeTruthy();
      const downloaded = await service.download(accepted.export_id);
      expect(downloaded.manifest.contentRef).toBe(ref);
      expect(await storage.get(ref)).toBeInstanceOf(Buffer);
      expect(removed).toEqual([]);
    } finally {
      service.onModuleDestroy();
      completeSpy.mockRestore();
      referenceSpy.mockRestore();
      await pendingCommit?.catch(() => undefined);
      await pendingPool.query(
        `DROP TRIGGER IF EXISTS ${trigger} ON bulk.file_manifests`,
      );
      await pendingPool.query(`DROP FUNCTION IF EXISTS ${fn}()`);
      await pendingPool.end();
      if (previousBucket === undefined) delete process.env.BULK_STORAGE_BUCKET;
      else process.env.BULK_STORAGE_BUCKET = previousBucket;
    }
  }, 30_000);

  it('cleans an export artifact only after PostgreSQL confirms the manifest transaction rolled back', async () => {
    const previousBucket = process.env.BULK_STORAGE_BUCKET;
    process.env.BULK_STORAGE_BUCKET = 'bulk-private-test';
    const suffix = randomUUID().replaceAll('-', '');
    const fn = `bulk.fail_manifest_${suffix}`;
    const trigger = `fail_manifest_trigger_${suffix}`;
    const stored = new Map<string, Buffer>();
    const removed: string[] = [];
    const storage = {
      put: async (bytes: Buffer, _contentType: string, path: string) => {
        const ref = `supabase://bulk-private-test/${path}`;
        stored.set(ref, Buffer.from(bytes));
        return ref;
      },
      remove: async (ref: string) => {
        removed.push(ref);
        stored.delete(ref);
      },
    };
    const observedAt = new Date().toISOString();
    const page = { items: [], nextCursor: null, observedAt, version: 'v1' };
    const source: BulkExportSource = {
      catalog: async () => page,
      pricing: async () => page,
      inventory: async () => page,
    };
    await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.role = 'RESULTADO_EXPORTACION' THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='injected manifest rollback';
        END IF;
        RETURN NEW;
      END
    $$`);
    await pool.query(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON bulk.file_manifests FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );
    const service = new BulkExportService(repository, storage as never, source);
    try {
      const accepted = await service.create('CSV');
      await vi.waitFor(() => expect(removed.length).toBe(1), {
        timeout: 5_000,
      });
      const ref = removed[0]!;
      expect(await repository.isExportArtifactReferenced(ref)).toBe(false);
      expect(stored.has(ref)).toBe(false);
      const manifestCount = await pool.query(
        'SELECT count(*)::int AS count FROM bulk.file_manifests WHERE content_ref = $1',
        [ref],
      );
      expect(manifestCount.rows[0]?.count).toBe(0);
      expect(
        (await repository.findExportJobByExportId(accepted.export_id))?.status,
      ).toBe('PROCESSING');
    } finally {
      service.onModuleDestroy();
      await pool.query(
        `DROP TRIGGER IF EXISTS ${trigger} ON bulk.file_manifests`,
      );
      await pool.query(`DROP FUNCTION IF EXISTS ${fn}()`);
      if (previousBucket === undefined) delete process.env.BULK_STORAGE_BUCKET;
      else process.env.BULK_STORAGE_BUCKET = previousBucket;
    }
  }, 30_000);

  it('persists and conditionally advances an export without exposing partial output', async () => {
    const job = await repository.createExportJob({
      exportId: randomUUID(),
      format: 'XLSX',
    });
    expect(job.status).toBe('QUEUED');
    expect(await repository.listQueuedExportJobs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ exportId: job.exportId }),
      ]),
    );
    const processing = await repository.claimQueuedExportJob(job.exportId);
    expect(processing?.job.status).toBe('PROCESSING');
    expect(await repository.claimQueuedExportJob(job.exportId)).toBeNull();
    await expect(
      repository.transitionExportJob(
        job.exportId,
        ['QUEUED'],
        'FAILED_GENERAL',
      ),
    ).rejects.toMatchObject({ code: 'CHECK_VIOLATION' });
    const failed = await repository.failProcessingExportJob(
      job.exportId,
      processing!.fence,
    );
    expect(failed?.status).toBe('FAILED_GENERAL');
    expect(failed?.outputFileId).toBeNull();
    expect(
      await repository.failProcessingExportJob(job.exportId, processing!.fence),
    ).toBeNull();
  });

  it('fences two PostgreSQL workers so only the current claim publishes a manifest', async () => {
    const previousBucket = process.env.BULK_STORAGE_BUCKET;
    process.env.BULK_STORAGE_BUCKET = 'bulk-private-test';
    const workerA = new BulkPersistenceRepository(database);
    const workerB = new BulkPersistenceRepository(database);
    const exportId = randomUUID();
    try {
      const created = await workerA.createExportJob({
        exportId,
        format: 'CSV',
      });
      const first = await workerA.claimQueuedExportJob(exportId);
      expect(first).not.toBeNull();
      await pool.query(
        "UPDATE bulk.export_jobs SET lease_until = now() - interval '1 millisecond' WHERE export_id = $1",
        [exportId],
      );
      await workerB.requeueStaleProcessingExports(new Date());
      const second = await workerB.claimQueuedExportJob(exportId);
      expect(second).not.toBeNull();
      expect(second!.fence).not.toBe(first!.fence);

      const snapshot = {
        requestedAt: created.createdAt.toISOString(),
        catalogObservedAt: created.createdAt.toISOString(),
        pricingObservedAt: created.createdAt.toISOString(),
        inventoryObservedAt: created.createdAt.toISOString(),
        catalogVersion: 'catalog-v1',
        pricingVersion: 'pricing-v1',
        inventoryVersion: 'inventory-v1',
      };
      const ref = (fence: string) =>
        `supabase://bulk-private-test/exports/${exportId}/${fence}/${randomUUID()}.csv`;
      const stale = await workerA.completeExportJob(
        exportId,
        { format: 'CSV', contentRef: ref(first!.fence) },
        first!.fence,
        snapshot,
      );
      expect(stale).toBeNull();
      expect(
        await pool.query(
          `SELECT count(*)::int AS count FROM bulk.file_manifests
           WHERE content_ref LIKE $1`,
          [`%/${exportId}/%`],
        ),
      ).toMatchObject({ rows: [{ count: 0 }] });

      const completed = await workerB.completeExportJob(
        exportId,
        { format: 'CSV', contentRef: ref(second!.fence) },
        second!.fence,
        snapshot,
      );
      expect(completed?.status).toBe('COMPLETED');
      expect(completed?.outputFileId).toBeTruthy();
      const manifest = await workerB.findFileManifest(completed!.outputFileId!);
      expect(manifest?.metadata).toMatchObject({
        export_id: exportId,
        requested_at: created.createdAt.toISOString(),
        catalog_version: 'catalog-v1',
        pricing_version: 'pricing-v1',
        inventory_version: 'inventory-v1',
      });
    } finally {
      if (previousBucket === undefined) delete process.env.BULK_STORAGE_BUCKET;
      else process.env.BULK_STORAGE_BUCKET = previousBucket;
    }
  });

  it('renews a long PostgreSQL export lease across worker restart and fences a concurrent reclaim', async () => {
    const previousBucket = process.env.BULK_STORAGE_BUCKET;
    process.env.BULK_STORAGE_BUCKET = 'bulk-private-test';
    const workerA = new BulkPersistenceRepository(database);
    const workerB = new BulkPersistenceRepository(database);
    const exportId = randomUUID();
    let renewing = true;
    const created = await workerA.createExportJob({ exportId, format: 'CSV' });
    const first = await workerA.claimQueuedExportJob(exportId);
    expect(first).not.toBeNull();
    const renew = setInterval(() => {
      if (renewing) void workerA.renewExportClaim(exportId, first!.fence);
    }, 15_000);
    renew.unref();
    try {
      await new Promise((resolve) => setTimeout(resolve, 61_000));
      expect(await workerA.isExportClaimCurrent(exportId, first!.fence)).toBe(
        true,
      );
      await workerB.requeueStaleProcessingExports(new Date());
      expect(await workerB.claimQueuedExportJob(exportId)).toBeNull();

      renewing = false;
      clearInterval(renew);
      await pool.query(
        "UPDATE bulk.export_jobs SET lease_until = now() - interval '1 millisecond' WHERE export_id = $1",
        [exportId],
      );
      await workerB.requeueStaleProcessingExports(new Date());
      const restartedWorkerClaim = await workerB.claimQueuedExportJob(exportId);
      expect(restartedWorkerClaim).not.toBeNull();

      const snapshot = {
        requestedAt: created.createdAt.toISOString(),
        catalogObservedAt: created.createdAt.toISOString(),
        pricingObservedAt: created.createdAt.toISOString(),
        inventoryObservedAt: created.createdAt.toISOString(),
        catalogVersion: 'catalog-v1',
        pricingVersion: 'pricing-v1',
        inventoryVersion: 'inventory-v1',
      };
      const stale = await workerA.completeExportJob(
        exportId,
        {
          format: 'CSV',
          contentRef: `supabase://bulk-private-test/exports/${exportId}/${first!.fence}/${randomUUID()}.csv`,
        },
        first!.fence,
        snapshot,
      );
      expect(stale).toBeNull();
      const completed = await workerB.completeExportJob(
        exportId,
        {
          format: 'CSV',
          contentRef: `supabase://bulk-private-test/exports/${exportId}/${restartedWorkerClaim!.fence}/${randomUUID()}.csv`,
        },
        restartedWorkerClaim!.fence,
        snapshot,
      );
      expect(completed?.status).toBe('COMPLETED');
      expect(
        await pool.query(
          'SELECT count(*)::int AS count FROM bulk.file_manifests WHERE content_ref LIKE $1',
          [`%/${exportId}/%`],
        ),
      ).toMatchObject({ rows: [{ count: 1 }] });
    } finally {
      renewing = false;
      clearInterval(renew);
      if (previousBucket === undefined) delete process.env.BULK_STORAGE_BUCKET;
      else process.env.BULK_STORAGE_BUCKET = previousBucket;
    }
  }, 90000);

  it('retries a transient PostgreSQL failure during an export claim', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const seq = `bulk.export_retry_${suffix}`;
    const fn = `bulk.export_retry_fn_${suffix}`;
    const trigger = `export_retry_trigger_${suffix}`;
    await pool.query(`CREATE SEQUENCE ${seq} START 1`);
    await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status = 'QUEUED' AND NEW.status = 'PROCESSING' AND nextval('${seq}') = 1 THEN
          RAISE EXCEPTION 'injected transient failure';
        END IF;
        RETURN NEW;
      END
    $$`);
    await pool.query(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE ON bulk.export_jobs FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );
    const service = new BulkExportService(repository);
    try {
      const before = await pool.query(
        "SELECT count(*)::int AS count FROM bulk.file_manifests WHERE role = 'RESULTADO_EXPORTACION'",
      );
      const accepted = await service.create('CSV');
      const terminal = await waitForExport(
        accepted.export_id,
        'FAILED_GENERAL',
      );
      expect(terminal.outputFileId).toBeNull();
      expect(terminal.status).toBe('FAILED_GENERAL');
      const after = await pool.query(
        "SELECT count(*)::int AS count FROM bulk.file_manifests WHERE role = 'RESULTADO_EXPORTACION'",
      );
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    } finally {
      service.onModuleDestroy();
      await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON bulk.export_jobs`);
      await pool.query(`DROP FUNCTION IF EXISTS ${fn}()`);
      await pool.query(`DROP SEQUENCE IF EXISTS ${seq}`);
    }
  }, 10_000);

  it('recovers a stale PROCESSING export after service restart without publishing an artifact', async () => {
    const job = await repository.createExportJob({
      exportId: randomUUID(),
      format: 'XLSX',
    });
    await repository.claimQueuedExportJob(job.exportId);
    try {
      await pool.query(
        'ALTER TABLE bulk.export_jobs DISABLE TRIGGER trg_export_jobs_updated_at',
      );
      await pool.query(
        "UPDATE bulk.export_jobs SET updated_at = now() - interval '2 minutes', lease_until = now() - interval '1 millisecond' WHERE export_id = $1",
        [job.exportId],
      );
    } finally {
      await pool.query(
        'ALTER TABLE bulk.export_jobs ENABLE TRIGGER trg_export_jobs_updated_at',
      );
    }
    const restarted = new BulkExportService(repository);
    try {
      const before = await pool.query(
        "SELECT count(*)::int AS count FROM bulk.file_manifests WHERE role = 'RESULTADO_EXPORTACION'",
      );
      restarted.onModuleInit();
      const terminal = await waitForExport(job.exportId, 'FAILED_GENERAL');
      expect(terminal.outputFileId).toBeNull();
      expect(terminal.completedAt).toBeNull();
      const after = await pool.query(
        "SELECT count(*)::int AS count FROM bulk.file_manifests WHERE role = 'RESULTADO_EXPORTACION'",
      );
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    } finally {
      restarted.onModuleDestroy();
    }
  }, 10_000);

  it('maps an actual PostgreSQL repository outage to a safe HTTP 503', async () => {
    const outagePool = new Pool({
      connectionString:
        'postgresql://bulk_test:bulk_test_only@127.0.0.1:1/bulk_test?sslmode=disable&connect_timeout=1',
      max: 2,
      connectionTimeoutMillis: 500,
    });
    const outageRepository = new BulkPersistenceRepository(
      drizzle(outagePool, { schema: bulkSchema, logger: false }),
    );
    const exportService = new BulkExportService(outageRepository);
    const appModule = await Test.createTestingModule({
      controllers: [BulkSvcController],
      providers: [
        BulkSvcService,
        {
          provide: BulkExportService,
          useValue: exportService,
        },
        { provide: BulkImportService, useValue: {} },
        { provide: BulkStorageService, useValue: {} },
        {
          provide: BulkReadinessService,
          useValue: { check: async () => true },
        },
      ],
    })
      .overrideGuard(BulkUserBearerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = appModule.createNestApplication();
    app.useGlobalFilters(new BulkProblemFilter());
    await app.init();
    try {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/carga-masiva/productos/exportaciones/${randomUUID()}`)
        .expect(503);
      expect(response.body).toMatchObject({
        status: 503,
        code: 'SERVICIO_NO_DISPONIBLE',
        detail: 'La persistencia no está disponible.',
      });
      expect(JSON.stringify(response.body)).not.toMatch(
        /ECONNREFUSED|password|bulk_test|SQL/i,
      );
    } finally {
      exportService.onModuleDestroy();
      await app.close();
      await outagePool.end();
    }
  }, 15_000);

  it('enforces message and operation idempotency in Outbox and lists pending messages', async () => {
    const message = {
      messageId: randomUUID(),
      eventName: 'test.event',
      kind: 'event' as const,
      correlationId: 'corr',
      occurredAt: new Date(),
      payload: { ok: true },
    };
    await repository.enqueueOutbox(message);
    await expect(repository.enqueueOutbox(message)).rejects.toMatchObject({
      code: 'UNIQUE_CONFLICT',
    });
    const operationId = randomUUID();
    await repository.enqueueOutbox({
      ...message,
      messageId: randomUUID(),
      operationId,
    });
    await expect(
      repository.enqueueOutbox({
        ...message,
        messageId: randomUUID(),
        operationId,
      }),
    ).rejects.toMatchObject({ code: 'UNIQUE_CONFLICT' });
    expect(
      (await repository.findPendingOutbox(1000)).some(
        (item) => item.messageId === message.messageId,
      ),
    ).toBe(true);
    await repository.markOutboxPublished(message.messageId, {
      attempts: 1,
      lastError: 'temporary transport failure',
    });
    expect(
      (await repository.findPendingOutbox(1000)).some(
        (item) => item.messageId === message.messageId,
      ),
    ).toBe(true);
    await repository.markOutboxPublished(message.messageId, {
      publishedAt: new Date(),
      attempts: 2,
    });
  });

  it('preserves confirmed Outbox publication against delayed failures and out-of-order attempts', async () => {
    const confirmedAt = new Date('2026-10-23T12:00:00.000Z');
    const duplicateAt = new Date('2026-10-23T12:05:00.000Z');
    const published = {
      messageId: randomUUID(),
      eventName: 'test.outbox.confirmed',
      kind: 'event' as const,
      correlationId: randomUUID(),
      occurredAt: new Date(),
      payload: { value: 'confirmed' },
    };
    await repository.enqueueOutbox(published);
    await repository.markOutboxPublished(published.messageId, {
      publishedAt: confirmedAt,
      attempts: 4,
    });
    await repository.markOutboxPublished(published.messageId, {
      attempts: 2,
      lastError: 'late transport failure',
    });
    await repository.markOutboxPublished(published.messageId, {
      publishedAt: duplicateAt,
      attempts: 1,
    });
    const [confirmed] = await database
      .select()
      .from(outbox)
      .where(eq(outbox.messageId, published.messageId));
    expect(confirmed?.publishedAt?.toISOString()).toBe(
      confirmedAt.toISOString(),
    );
    expect(confirmed?.attempts).toBe(4);
    expect(confirmed?.lastError).toBeNull();
    expect(
      (await repository.findPendingOutbox()).some(
        (message) => message.messageId === published.messageId,
      ),
    ).toBe(false);

    const pending = { ...published, messageId: randomUUID() };
    await repository.enqueueOutbox(pending);
    await repository.markOutboxPublished(pending.messageId, {
      attempts: 3,
      lastError: 'temporary failure',
    });
    expect(
      (await repository.findPendingOutbox()).some(
        (message) => message.messageId === pending.messageId,
      ),
    ).toBe(true);
    await repository.markOutboxPublished(pending.messageId, {
      publishedAt: confirmedAt,
      attempts: 1,
    });
    const [recovered] = await database
      .select()
      .from(outbox)
      .where(eq(outbox.messageId, pending.messageId));
    expect(recovered?.publishedAt?.toISOString()).toBe(
      confirmedAt.toISOString(),
    );
    expect(recovered?.attempts).toBe(3);
    await expect(
      repository.markOutboxPublished(randomUUID(), { attempts: 1 }),
    ).rejects.toMatchObject({ code: 'FOREIGN_KEY_VIOLATION' });
  });

  it('processes each Inbox handler once and rolls back the receipt if its local mutation fails', async () => {
    const input = {
      messageId: randomUUID(),
      handler: 'handler-a',
      eventName: 'test.event',
      payload: { value: 1 },
    };
    let count = 0;
    const effect = async () => {
      count += 1;
      return 'applied';
    };
    expect(await repository.processInboxOnce(input, effect)).toEqual({
      processed: true,
      result: 'applied',
    });
    expect(await repository.processInboxOnce(input, effect)).toEqual({
      processed: false,
      result: 'applied',
    });
    expect(
      await repository.processInboxOnce(
        { ...input, handler: 'handler-b' },
        effect,
      ),
    ).toEqual({ processed: true, result: 'applied' });
    expect(count).toBe(2);
    const applying = await importBatch([
      { rowId: randomUUID(), requiredDomains: ['CATALOGO'] },
    ]);
    const applied = await repository.processInboxOnce(
      {
        messageId: randomUUID(),
        handler: 'workflow-handler',
        eventName: 'workflow.done',
        payload: {},
      },
      async (context) => {
        await context.updateWorkflowState({
          batchId: applying.batch.batchId,
          rowId: applying.rows[0]!.row.rowId,
          status: 'COMPLETED',
          steps: [{ domain: 'CATALOGO', status: 'COMPLETED' }],
        });
        return 'workflow-applied';
      },
    );
    expect(applied.processed).toBe(true);
    expect(
      (await repository.findBatchByBatchId(applying.batch.batchId))?.status,
    ).toBe('COMPLETED');
    const failing = {
      ...input,
      messageId: randomUUID(),
      handler: 'rollback-handler',
    };
    const rollback = await importBatch([
      { rowId: randomUUID(), requiredDomains: ['CATALOGO'] },
    ]);
    await expect(
      repository.processInboxOnce(failing, async (context) => {
        await context.updateWorkflowState({
          batchId: rollback.batch.batchId,
          rowId: rollback.rows[0]!.row.rowId,
          status: 'COMPLETED',
          steps: [{ domain: 'CATALOGO', status: 'COMPLETED' }],
        });
        throw new Error('local mutation failed');
      }),
    ).rejects.toBeInstanceOf(BulkPersistenceError);
    expect(
      (await repository.findBatchByBatchId(rollback.batch.batchId))?.status,
    ).toBe('QUEUED');
    expect(
      await database
        .select()
        .from(inbox)
        .where(
          and(
            eq(inbox.messageId, failing.messageId),
            eq(inbox.handler, failing.handler),
          ),
        ),
    ).toHaveLength(0);
  });

  it('validates Inbox replay identity structurally and deduplicates concurrent deliveries', async () => {
    const input = {
      messageId: randomUUID(),
      handler: 'identity-handler',
      eventName: 'test.identity',
      correlationId: 'identity-correlation',
      payload: { nested: { first: 1, second: 2 }, list: [1, 2] },
    };
    let effectCount = 0;
    const effect = async () => {
      effectCount += 1;
      return 'stored-result';
    };
    await expect(repository.processInboxOnce(input, effect)).resolves.toEqual({
      processed: true,
      result: 'stored-result',
    });
    await expect(
      repository.processInboxOnce(
        {
          ...input,
          payload: { list: [1, 2], nested: { second: 2, first: 1 } },
        },
        effect,
      ),
    ).resolves.toEqual({ processed: false, result: 'stored-result' });
    for (const incompatible of [
      { ...input, eventName: 'test.other' },
      { ...input, correlationId: 'other-correlation' },
      { ...input, payload: { nested: { first: 9, second: 2 }, list: [1, 2] } },
    ]) {
      await expect(
        repository.processInboxOnce(incompatible, effect),
      ).rejects.toMatchObject({ code: 'CHECK_VIOLATION' });
    }
    expect(effectCount).toBe(1);

    const concurrent = { ...input, messageId: randomUUID() };
    let concurrentEffects = 0;
    const concurrentEffect = async () => {
      concurrentEffects += 1;
      return 'once';
    };
    const results = await Promise.all([
      repository.processInboxOnce(concurrent, concurrentEffect),
      repository.processInboxOnce(concurrent, concurrentEffect),
    ]);
    expect(results.map((result) => result.processed).sort()).toEqual([
      false,
      true,
    ]);
    expect(results.map((result) => result.result)).toEqual(['once', 'once']);
    expect(concurrentEffects).toBe(1);
  });

  it('uses transactional locks to preserve counters for concurrent writes to one batch', async () => {
    const created = await importBatch([
      { rowId: randomUUID(), requiredDomains: ['CATALOGO'] },
      { rowId: randomUUID(), requiredDomains: ['CATALOGO'] },
    ]);
    const update = (rowId: string): UpdateWorkflowStateInput => ({
      batchId: created.batch.batchId,
      rowId,
      status: 'COMPLETED',
      steps: [{ domain: 'CATALOGO', status: 'COMPLETED' }],
    });
    await Promise.all(
      created.rows.map(({ row }) =>
        repository.updateWorkflowState(update(row.rowId)),
      ),
    );
    const final = await repository.findBatchByBatchId(created.batch.batchId);
    expect(final).toMatchObject({
      status: 'COMPLETED',
      totalRows: 2,
      completedRows: 2,
      failedRows: 0,
      needsReconciliation: false,
    });
  });

  it('completes a partially failed batch with reconciliation counters consistent with SPEC', async () => {
    const created = await importBatch([
      { rowId: randomUUID(), requiredDomains: ['CATALOGO', 'PRICING'] },
    ]);
    const rowId = created.rows[0]!.row.rowId;
    await repository.updateWorkflowState({
      batchId: created.batch.batchId,
      rowId,
      status: 'PROCESSING',
      steps: [{ domain: 'CATALOGO', status: 'COMPLETED' }],
    });
    await repository.updateWorkflowState({
      batchId: created.batch.batchId,
      rowId,
      status: 'FAILED',
      failedDomain: 'PRICING',
      needsReconciliation: true,
      steps: [{ domain: 'PRICING', status: 'FAILED' }],
    });
    expect(
      await repository.findBatchByBatchId(created.batch.batchId),
    ).toMatchObject({
      status: 'COMPLETED',
      completedRows: 0,
      failedRows: 1,
      needsReconciliation: true,
    });
  });

  it('rejects requeue without a new domain attempt and preserves the durable failure', async () => {
    const created = await importBatch([
      { rowId: randomUUID(), requiredDomains: ['CATALOGO', 'PRICING'] },
      { rowId: randomUUID(), requiredDomains: ['CATALOGO'] },
    ]);
    const [failed, completed] = created.rows.map(({ row }) => row.rowId);
    await repository.updateWorkflowState({
      batchId: created.batch.batchId,
      rowId: failed!,
      status: 'PROCESSING',
      steps: [{ domain: 'CATALOGO', status: 'COMPLETED' }],
    });
    await repository.updateWorkflowState({
      batchId: created.batch.batchId,
      rowId: failed!,
      status: 'FAILED',
      failedDomain: 'PRICING',
      steps: [{ domain: 'PRICING', status: 'FAILED' }],
    });
    await repository.updateWorkflowState({
      batchId: created.batch.batchId,
      rowId: completed!,
      status: 'COMPLETED',
      steps: [{ domain: 'CATALOGO', status: 'COMPLETED' }],
    });
    await expect(
      repository.requeueBatch(created.batch.batchId),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(
      await repository.findBatchByBatchId(created.batch.batchId),
    ).toMatchObject({
      status: 'COMPLETED',
      completedRows: 1,
      failedRows: 1,
      needsReconciliation: true,
    });
    expect(
      (await repository.listBatchRows(created.batch.batchId)).find(
        (row) => row.rowId === failed,
      ),
    ).toMatchObject({
      status: 'FAILED',
      appliedDomains: ['CATALOGO'],
      needsReconciliation: true,
    });
    expect(
      await repository.listRowSteps(created.batch.batchId, failed!),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ domain: 'CATALOGO', status: 'COMPLETED' }),
        expect.objectContaining({ domain: 'PRICING', status: 'FAILED' }),
      ]),
    );
    await expect(
      repository.requeueBatch(created.batch.batchId),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('replays an identical normalized batch intent and conflicts on changed intent', async () => {
    const batchId = randomUUID();
    const correlationId = randomUUID();
    const rowId = randomUUID();
    const admissionIntent = {
      format: 'CSV',
      templateVersion: 2,
      rows: [{ rowId, vendibleSkus: ['SKU-1'], stockInicial: 0 }],
    };
    const input = {
      batchId,
      correlationId,
      templateVersion: 2,
      inputFile: {
        format: 'CSV' as const,
        contentRef: `test://${randomUUID()}`,
      },
      rows: [
        {
          rowId,
          requiredDomains: ['CATALOGO', 'INVENTARIO'] as Array<
            'CATALOGO' | 'INVENTARIO'
          >,
        },
      ],
      admissionIntent,
    };
    const first = await repository.createImportBatch(input);
    const replay = await repository.createImportBatch(input);
    expect(replay.batch.id).toBe(first.batch.id);
    expect(replay.rows[0]?.row.id).toBe(first.rows[0]?.row.id);
    await expect(
      repository.createImportBatch({
        ...input,
        admissionIntent: {
          ...admissionIntent,
          rows: [{ rowId, vendibleSkus: ['SKU-2'], stockInicial: 0 }],
        },
      }),
    ).rejects.toMatchObject({ code: 'UNIQUE_CONFLICT' });
    expect(
      await database
        .select()
        .from(fileManifests)
        .where(eq(fileManifests.id, first.manifest.id)),
    ).toHaveLength(1);
  });

  it('waits for each SKU and stock adjustment and deduplicates equivalent operation results durably', async () => {
    const rowId = randomUUID();
    const batchId = randomUUID();
    const correlationId = randomUUID();
    const intent = {
      format: 'CSV',
      templateVersion: 2,
      rows: [
        {
          rowId,
          vendibleSkus: ['SKU-A', 'SKU-B'],
          variantSkus: ['SKU-A', 'SKU-B'],
          stockInicial: 4,
          defaultLocationId: randomUUID(),
        },
      ],
    };
    const created = await repository.createImportBatch({
      batchId,
      correlationId,
      templateVersion: 2,
      inputFile: { format: 'CSV', contentRef: `test://${randomUUID()}` },
      rows: [{ rowId, requiredDomains: ['CATALOGO', 'INVENTARIO'] }],
      admissionIntent: intent,
    });
    const result = (
      input: Partial<Parameters<typeof repository.recordDomainResult>[0]>,
    ) =>
      repository.recordDomainResult({
        batchId,
        rowId,
        domain: 'INVENTARIO',
        operationId: randomUUID(),
        messageId: randomUUID(),
        correlationId,
        eventName: 'inventory.sku.initialization.completed',
        action: 'SKU_INITIALIZATION',
        skuId: 'SKU-A',
        status: 'COMPLETED',
        ...input,
      });
    await repository.recordDomainResult({
      batchId,
      rowId,
      domain: 'CATALOGO',
      operationId: randomUUID(),
      messageId: randomUUID(),
      correlationId,
      eventName: 'catalog.bulk.upsert.completed',
      action: 'UPSERT',
      status: 'COMPLETED',
    });
    const skuA = {
      operationId: randomUUID(),
      messageId: randomUUID(),
      skuId: 'SKU-A',
    };
    const first = await result(skuA);
    expect(first).toMatchObject({ processed: true, result: 'PROCESSING' });
    expect(await result(skuA)).toMatchObject({
      processed: false,
      result: 'PROCESSING',
    });
    await expect(
      result({
        ...skuA,
        eventName: 'inventory.sku.initialization.rejected',
        status: 'FAILED',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await result({
      operationId: randomUUID(),
      messageId: randomUUID(),
      skuId: 'SKU-B',
    });
    expect((await repository.findBatchByBatchId(batchId))?.status).toBe(
      'PROCESSING',
    );
    await repository.recordDomainResult({
      batchId,
      rowId,
      domain: 'INVENTARIO',
      operationId: randomUUID(),
      messageId: randomUUID(),
      correlationId,
      eventName: 'inventory.bulk.stock.adjust.completed',
      action: 'STOCK_ADJUSTMENT',
      status: 'COMPLETED',
    });
    expect(await repository.findBatchByBatchId(batchId)).toMatchObject({
      status: 'COMPLETED',
      completedRows: 1,
      failedRows: 0,
    });
    expect((await repository.listBatchRows(batchId))[0]).toMatchObject({
      status: 'COMPLETED',
      appliedDomains: ['CATALOGO', 'INVENTARIO'],
    });
    const messageCount = (
      await database
        .select()
        .from(inbox)
        .where(eq(inbox.handler, 'bulk.domain-result'))
    ).filter((receipt) => receipt.payload.batchId === batchId);
    expect(messageCount).toHaveLength(4);
    expect(created.rows).toHaveLength(1);
  });

  it('turns positive initial stock without a default location into a durable functional row failure', async () => {
    const rowId = randomUUID();
    const batchId = randomUUID();
    const correlationId = randomUUID();
    await repository.createImportBatch({
      batchId,
      correlationId,
      templateVersion: 2,
      inputFile: { format: 'CSV', contentRef: `test://${randomUUID()}` },
      rows: [{ rowId, requiredDomains: ['CATALOGO', 'INVENTARIO'] }],
      admissionIntent: {
        format: 'CSV',
        templateVersion: 2,
        rows: [
          {
            rowId,
            vendibleSkus: ['SKU-A'],
            variantSkus: [],
            skuBase: 'SKU-A',
            stockInicial: 1,
            defaultLocationId: null,
          },
        ],
      },
    });
    await repository.recordDomainResult({
      batchId,
      rowId,
      domain: 'CATALOGO',
      operationId: randomUUID(),
      messageId: randomUUID(),
      correlationId,
      eventName: 'catalog.bulk.upsert.completed',
      action: 'UPSERT',
      status: 'COMPLETED',
    });
    await repository.recordDomainResult({
      batchId,
      rowId,
      domain: 'INVENTARIO',
      operationId: randomUUID(),
      messageId: randomUUID(),
      correlationId,
      eventName: 'inventory.sku.initialization.completed',
      action: 'SKU_INITIALIZATION',
      skuId: 'SKU-A',
      status: 'COMPLETED',
    });
    expect(await repository.findBatchByBatchId(batchId)).toMatchObject({
      status: 'COMPLETED',
      failedRows: 1,
      needsReconciliation: true,
    });
    expect((await repository.listBatchRows(batchId))[0]).toMatchObject({
      status: 'FAILED',
      failedDomain: 'INVENTARIO',
      errorCode: 'DEFAULT_LOCATION_REQUIRED',
    });
  });

  it('rejects retry without a new domain protocol and preserves the failed receipt', async () => {
    const rowId = randomUUID();
    const batchId = randomUUID();
    const correlationId = randomUUID();
    const operationId = randomUUID();
    await repository.createImportBatch({
      batchId,
      correlationId,
      templateVersion: 2,
      inputFile: { format: 'CSV', contentRef: `test://${randomUUID()}` },
      rows: [{ rowId, requiredDomains: ['CATALOGO', 'INVENTARIO'] }],
      admissionIntent: {
        format: 'CSV',
        templateVersion: 2,
        rows: [
          {
            rowId,
            vendibleSkus: ['SKU-A'],
            variantSkus: [],
            skuBase: 'SKU-A',
            stockInicial: 0,
            defaultLocationId: null,
          },
        ],
      },
    });
    await repository.recordDomainResult({
      batchId,
      rowId,
      domain: 'CATALOGO',
      operationId: randomUUID(),
      messageId: randomUUID(),
      correlationId,
      eventName: 'catalog.bulk.upsert.completed',
      action: 'UPSERT',
      status: 'COMPLETED',
    });
    const rejected = {
      batchId,
      rowId,
      domain: 'INVENTARIO' as const,
      operationId,
      messageId: randomUUID(),
      correlationId,
      causationId: 'inventory-request-attempt-1',
      eventName: 'inventory.sku.initialization.rejected',
      action: 'SKU_INITIALIZATION' as const,
      skuId: 'SKU-A',
      status: 'FAILED' as const,
      errorCode: 'TEMPORARY_REJECTION',
      errorDetail: 'retryable',
    };
    await repository.recordDomainResult(rejected);
    await expect(repository.requeueBatch(batchId)).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(await repository.recordDomainResult(rejected)).toMatchObject({
      processed: false,
      result: 'FAILED',
    });
    expect(await repository.findBatchByBatchId(batchId)).toMatchObject({
      status: 'COMPLETED',
      failedRows: 1,
      needsReconciliation: true,
    });
    await expect(
      repository.recordDomainResult({
        ...rejected,
        operationId: randomUUID(),
        messageId: randomUUID(),
        causationId: 'inventory-request-attempt-2',
        eventName: 'inventory.sku.initialization.completed',
        status: 'COMPLETED',
        errorCode: null,
        errorDetail: null,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await repository.findBatchByBatchId(batchId)).toMatchObject({
      status: 'COMPLETED',
      completedRows: 0,
      failedRows: 1,
      needsReconciliation: true,
    });
    expect((await repository.listBatchRows(batchId))[0]).toMatchObject({
      status: 'FAILED',
      appliedDomains: ['CATALOGO'],
      needsReconciliation: true,
    });
  });

  it('keeps a pricing failure open until already-started Inventory work reports its result', async () => {
    const rowId = randomUUID();
    const batchId = randomUUID();
    const correlationId = randomUUID();
    await repository.createImportBatch({
      batchId,
      correlationId,
      templateVersion: 2,
      inputFile: { format: 'CSV', contentRef: `test://${randomUUID()}` },
      rows: [{ rowId, requiredDomains: ['CATALOGO', 'PRICING', 'INVENTARIO'] }],
      admissionIntent: {
        format: 'CSV',
        templateVersion: 2,
        rows: [
          {
            rowId,
            vendibleSkus: ['SKU-A'],
            variantSkus: [],
            skuBase: 'SKU-A',
            precioRegular: 20,
            stockInicial: 0,
            defaultLocationId: null,
          },
        ],
      },
    });
    await repository.recordDomainResult({
      batchId,
      rowId,
      domain: 'CATALOGO',
      operationId: randomUUID(),
      messageId: randomUUID(),
      correlationId,
      eventName: 'catalog.bulk.upsert.completed',
      action: 'UPSERT',
      status: 'COMPLETED',
    });
    await repository.recordDomainResult({
      batchId,
      rowId,
      domain: 'PRICING',
      operationId: randomUUID(),
      messageId: randomUUID(),
      correlationId,
      eventName: 'pricing.product.initialization.rejected',
      action: 'PRICE_INITIALIZATION',
      causationId: randomUUID(),
      status: 'FAILED',
      errorCode: 'PRICE_REJECTED',
      errorDetail: 'invalid business price',
    });
    expect(await repository.findBatchByBatchId(batchId)).toMatchObject({
      status: 'PROCESSING',
      failedRows: 0,
    });
    expect((await repository.listBatchRows(batchId))[0]).toMatchObject({
      status: 'PROCESSING',
    });
    await repository.recordDomainResult({
      batchId,
      rowId,
      domain: 'INVENTARIO',
      operationId: randomUUID(),
      messageId: randomUUID(),
      correlationId,
      eventName: 'inventory.sku.initialization.completed',
      action: 'SKU_INITIALIZATION',
      skuId: 'SKU-A',
      status: 'COMPLETED',
    });
    expect(await repository.findBatchByBatchId(batchId)).toMatchObject({
      status: 'COMPLETED',
      completedRows: 0,
      failedRows: 1,
    });
    expect((await repository.listBatchRows(batchId))[0]).toMatchObject({
      status: 'FAILED',
      failedDomain: 'PRICING',
      appliedDomains: ['CATALOGO', 'INVENTARIO'],
      errorCode: 'PRICE_REJECTED',
      errorDetail: 'invalid business price',
      needsReconciliation: true,
    });
  });

  it('accepts official Pricing ALTA initialization results and preserves identity on replay', async () => {
    const batchId = randomUUID();
    const correlationId = randomUUID();
    const readyRow = randomUUID();
    const rejectedRow = randomUUID();
    await repository.createImportBatch({
      batchId,
      correlationId,
      templateVersion: 2,
      inputFile: { format: 'CSV', contentRef: `test://${randomUUID()}` },
      rows: [readyRow, rejectedRow].map((rowId) => ({
        rowId,
        requiredDomains: ['CATALOGO' as const, 'PRICING' as const],
      })),
      admissionIntent: {
        rows: [readyRow, rejectedRow].map((rowId) => ({
          rowId,
          vendibleSkus: ['SKU-PRICE'],
          precioRegular: 18,
          stockInicial: 0,
          defaultLocationId: null,
        })),
      },
    });
    for (const rowId of [readyRow, rejectedRow]) {
      await repository.recordDomainResult({
        batchId,
        rowId,
        domain: 'CATALOGO',
        operationId: randomUUID(),
        messageId: randomUUID(),
        correlationId,
        eventName: 'catalog.bulk.upsert.completed',
        action: 'UPSERT',
        status: 'COMPLETED',
      });
    }
    const completed = {
      batchId,
      rowId: readyRow,
      domain: 'PRICING' as const,
      operationId: randomUUID(),
      causationId: randomUUID(),
      messageId: randomUUID(),
      correlationId,
      eventName: 'pricing.product.initialization.completed',
      action: 'PRICE_INITIALIZATION' as const,
      status: 'COMPLETED' as const,
    };
    const rejected = {
      batchId,
      rowId: rejectedRow,
      domain: 'PRICING' as const,
      operationId: randomUUID(),
      causationId: randomUUID(),
      messageId: randomUUID(),
      correlationId,
      eventName: 'pricing.product.initialization.rejected',
      action: 'PRICE_INITIALIZATION' as const,
      status: 'FAILED' as const,
      errorCode: 'PRICE_REJECTED',
      errorDetail: 'Pricing rechazó el precio base',
    };
    await expect(
      repository.recordDomainResult({
        ...completed,
        eventName: 'pricing.bulk.price.apply.completed',
      }),
    ).rejects.toMatchObject({ code: 'CHECK_VIOLATION' });
    await expect(
      repository.recordDomainResult({ ...completed, causationId: undefined }),
    ).rejects.toMatchObject({ code: 'CHECK_VIOLATION' });
    expect(await repository.recordDomainResult(completed)).toMatchObject({
      processed: true,
    });
    expect(await repository.recordDomainResult(completed)).toMatchObject({
      processed: false,
    });
    expect(await repository.recordDomainResult(rejected)).toMatchObject({
      processed: true,
    });
    expect(await repository.recordDomainResult(rejected)).toMatchObject({
      processed: false,
    });
    expect(await repository.findBatchByBatchId(batchId)).toMatchObject({
      status: 'COMPLETED',
      totalRows: 2,
      completedRows: 1,
      failedRows: 1,
    });
    const rows = await repository.listBatchRows(batchId);
    expect(rows.find((row) => row.rowId === readyRow)).toMatchObject({
      status: 'COMPLETED',
      appliedDomains: ['CATALOGO', 'PRICING'],
      failedDomain: null,
    });
    expect(rows.find((row) => row.rowId === rejectedRow)).toMatchObject({
      status: 'FAILED',
      appliedDomains: ['CATALOGO'],
      failedDomain: 'PRICING',
      errorCode: 'PRICE_REJECTED',
    });
  });

  it('rejects completed-step and completed-row regressions and preserves durable applied domains', async () => {
    const created = await importBatch([
      { rowId: randomUUID(), requiredDomains: ['CATALOGO', 'PRICING'] },
    ]);
    const rowId = created.rows[0]!.row.rowId;
    await repository.updateWorkflowState({
      batchId: created.batch.batchId,
      rowId,
      status: 'PROCESSING',
      steps: [{ domain: 'CATALOGO', status: 'COMPLETED' }],
    });
    await expect(
      repository.updateWorkflowState({
        batchId: created.batch.batchId,
        rowId,
        status: 'PROCESSING',
        steps: [
          { domain: 'PRICING', status: 'PROCESSING' },
          { domain: 'CATALOGO', status: 'FAILED' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CHECK_VIOLATION' });
    expect(
      (await repository.listRowSteps(created.batch.batchId, rowId)).map(
        (step) => [step.domain, step.status],
      ),
    ).toEqual([
      ['CATALOGO', 'COMPLETED'],
      ['PRICING', 'PENDING'],
    ]);
    expect(
      (await repository.listBatchRows(created.batch.batchId))[0]
        ?.appliedDomains,
    ).toEqual(['CATALOGO']);

    await repository.updateWorkflowState({
      batchId: created.batch.batchId,
      rowId,
      status: 'FAILED',
      failedDomain: 'PRICING',
      steps: [{ domain: 'PRICING', status: 'FAILED' }],
    });
    expect(
      (await repository.listBatchRows(created.batch.batchId))[0],
    ).toMatchObject({
      status: 'FAILED',
      appliedDomains: ['CATALOGO'],
      needsReconciliation: true,
    });
    await expect(
      repository.requeueBatch(created.batch.batchId),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(
      (await repository.listBatchRows(created.batch.batchId))[0],
    ).toMatchObject({
      status: 'FAILED',
      appliedDomains: ['CATALOGO'],
      needsReconciliation: true,
    });
    await expect(
      repository.updateWorkflowState({
        batchId: created.batch.batchId,
        rowId,
        status: 'PROCESSING',
        steps: [],
      }),
    ).rejects.toMatchObject({ code: 'CHECK_VIOLATION' });
    expect(
      (await repository.listBatchRows(created.batch.batchId))[0],
    ).toMatchObject({
      status: 'FAILED',
      appliedDomains: ['CATALOGO'],
      failedDomain: 'PRICING',
      needsReconciliation: true,
    });
  });

  it('derives reconciliation for partial failure and rolls back an incompatible explicit flag', async () => {
    const created = await importBatch([
      { rowId: randomUUID(), requiredDomains: ['CATALOGO', 'PRICING'] },
    ]);
    const rowId = created.rows[0]!.row.rowId;
    await repository.updateWorkflowState({
      batchId: created.batch.batchId,
      rowId,
      status: 'PROCESSING',
      steps: [{ domain: 'CATALOGO', status: 'COMPLETED' }],
    });
    await expect(
      repository.updateWorkflowState({
        batchId: created.batch.batchId,
        rowId,
        status: 'FAILED',
        failedDomain: 'PRICING',
        needsReconciliation: false,
        steps: [{ domain: 'PRICING', status: 'FAILED' }],
      }),
    ).rejects.toMatchObject({ code: 'CHECK_VIOLATION' });
    expect(
      (await repository.listRowSteps(created.batch.batchId, rowId)).map(
        (step) => step.status,
      ),
    ).toEqual(['COMPLETED', 'PENDING']);
    expect(
      (await repository.listBatchRows(created.batch.batchId))[0],
    ).toMatchObject({
      status: 'PROCESSING',
      appliedDomains: ['CATALOGO'],
      needsReconciliation: false,
    });
    expect(
      await repository.findBatchByBatchId(created.batch.batchId),
    ).toMatchObject({
      status: 'PROCESSING',
      failedRows: 0,
      needsReconciliation: false,
    });
    await repository.updateWorkflowState({
      batchId: created.batch.batchId,
      rowId,
      status: 'FAILED',
      failedDomain: 'PRICING',
      steps: [{ domain: 'PRICING', status: 'FAILED' }],
    });
    expect(
      (await repository.listBatchRows(created.batch.batchId))[0],
    ).toMatchObject({
      status: 'FAILED',
      needsReconciliation: true,
    });
    expect(
      await repository.findBatchByBatchId(created.batch.batchId),
    ).toMatchObject({
      status: 'COMPLETED',
      failedRows: 1,
      needsReconciliation: true,
    });
  });

  it('commits workflow and Outbox together and rolls both back on an idempotency conflict', async () => {
    const created = await importBatch([
      { rowId: randomUUID(), requiredDomains: ['CATALOGO'] },
      { rowId: randomUUID(), requiredDomains: ['CATALOGO'] },
    ]);
    const message = {
      messageId: randomUUID(),
      eventName: 'workflow.test',
      kind: 'event' as const,
      correlationId: 'corr',
      occurredAt: new Date(),
      payload: { ok: true },
    };
    const first: UpdateWorkflowStateInput = {
      batchId: created.batch.batchId,
      rowId: created.rows[0]!.row.rowId,
      status: 'COMPLETED',
      steps: [{ domain: 'CATALOGO', status: 'COMPLETED' }],
    };
    await repository.enqueueOutbox(message, first);
    const second: UpdateWorkflowStateInput = {
      batchId: created.batch.batchId,
      rowId: created.rows[1]!.row.rowId,
      status: 'COMPLETED',
      steps: [{ domain: 'CATALOGO', status: 'COMPLETED' }],
    };
    await expect(
      repository.enqueueOutbox(message, second),
    ).rejects.toMatchObject({ code: 'UNIQUE_CONFLICT' });
    const rows = await repository.listBatchRows(created.batch.batchId);
    expect(rows.map((row) => row.status).sort()).toEqual([
      'COMPLETED',
      'PENDING',
    ]);
    expect(
      (await repository.findBatchByBatchId(created.batch.batchId))
        ?.completedRows,
    ).toBe(1);
  });

  it('checks terminal completion cannot precede required steps and there are no cross-schema foreign keys', async () => {
    const created = await importBatch([
      { rowId: randomUUID(), requiredDomains: ['CATALOGO', 'PRICING'] },
    ]);
    await expect(
      repository.updateWorkflowState({
        batchId: created.batch.batchId,
        rowId: created.rows[0]!.row.rowId,
        status: 'COMPLETED',
        steps: [],
      }),
    ).rejects.toMatchObject({ code: 'CHECK_VIOLATION' });
    const fks = await pool.query(
      `SELECT count(*)::int AS count FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace s ON s.oid=t.relnamespace JOIN pg_class d ON d.oid=c.confrelid JOIN pg_namespace n ON n.oid=d.relnamespace WHERE s.nspname='bulk' AND c.contype='f' AND n.nspname <> 'bulk'`,
    );
    expect(fks.rows[0]?.count).toBe(0);
  });
});
