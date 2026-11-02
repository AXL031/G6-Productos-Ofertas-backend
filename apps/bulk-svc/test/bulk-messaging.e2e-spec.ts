import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BulkOutboxRelay } from '../src/messaging/bulk-outbox-relay.js';
import { BulkImportService } from '../src/bulk-import.service.js';
import { BULK_TEMPLATE_HEADERS } from '../src/domain/bulk-template-v2.js';
import { CatalogBulkResultConsumer } from '../src/messaging/catalog-bulk-result-consumer.js';
import { bulkSchema } from '../src/persistence/bulk.schema.js';
import { BulkPersistenceRepository } from '../src/persistence/bulk.repository.js';
import { IsolatedBulkRabbitmq } from './isolated-bulk-rabbitmq.js';

const databaseUrl = process.env.BULK_TEST_DATABASE_URL;
const integration =
  databaseUrl && process.env.NODE_ENV === 'test' ? describe : describe.skip;
const id = () => randomUUID();
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

integration('bulk-svc disposable PostgreSQL 17 + RabbitMQ 4.2.9', () => {
  let pool: Pool;
  let repository: BulkPersistenceRepository;
  let broker: IsolatedBulkRabbitmq;
  let consumer: CatalogBulkResultConsumer;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('BULK_TEST_DATABASE_URL required');
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
      !url.searchParams.has('sslmode') ||
      url.searchParams.get('sslmode') !== 'disable'
    )
      throw new Error(
        'Solo se permite una PostgreSQL desechable en loopback con sslmode=disable.',
      );
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const version = await pool.query('SHOW server_version_num');
    expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(
      170000,
    );
    expect(Number(version.rows[0]?.server_version_num)).toBeLessThan(180000);
    await pool.query('SELECT 1 FROM bulk.inbox LIMIT 0');
    await pool.query(
      'TRUNCATE bulk.inbox, bulk.outbox, bulk.row_domain_steps, bulk.batch_rows, bulk.export_jobs, bulk.batch_jobs, bulk.file_manifests CASCADE',
    );
    repository = new BulkPersistenceRepository(
      drizzle(pool, { schema: bulkSchema, logger: false }),
    );
    broker = new IsolatedBulkRabbitmq();
    await broker.start();
    consumer = new CatalogBulkResultConsumer(repository, broker.url);
    await consumer.onModuleInit();
  }, 90000);

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE bulk.inbox, bulk.outbox, bulk.row_domain_steps, bulk.batch_rows, bulk.export_jobs, bulk.batch_jobs, bulk.file_manifests CASCADE',
    );
  });

  afterAll(async () => {
    await consumer?.onModuleDestroy();
    await broker?.stop();
    await pool?.end();
  });

  it('admits a simple-product CSV with a Catalog command in the same PostgreSQL transaction', async () => {
    const batchId = id();
    const correlationId = id();
    const values = [
      'ALTA',
      '',
      '',
      'SKU-SIMPLE',
      '',
      'Producto simple',
      'Descripción',
      'cat-1',
      'marca-1',
      'tipo-1',
      'false',
      '12.5',
      '[]',
      '',
      '',
      '0',
    ];
    const service = new BulkImportService(repository);
    const importInput = {
      bytes: Buffer.from(
        `${BULK_TEMPLATE_HEADERS.join(',')}\r\n${values.join(',')}\r\n`,
        'utf8',
      ),
      format: 'CSV',
      templateVersion: 2,
      correlationId,
      batchId,
      contentRef: `test://${id()}`,
    };
    const admitted = await service.receiveImport(importInput);
    expect(admitted.parsed.rows).toHaveLength(1);
    expect(admitted.parsed.rows[0]?.variant).toBeNull();
    const command = (await repository.findPendingOutbox(10)).find(
      (item) => item.correlationId === correlationId,
    );
    expect(command?.eventName).toBe('catalog.bulk.upsert.requested');
    await service.receiveImport(importInput);
    const replay = (await repository.findPendingOutbox(10)).find(
      (item) => item.correlationId === correlationId,
    );
    expect(replay?.messageId).toBe(command?.messageId);
    expect(replay?.payload).toEqual(command?.payload);
    const relay = new BulkOutboxRelay(repository, broker.url);
    await relay.flush();
    const sent = await broker.nextCommand();
    expect(sent).toEqual(command?.payload);
    expect(
      (await repository.findPendingOutbox(10)).some(
        (item) => item.messageId === command?.messageId,
      ),
    ).toBe(false);
  }, 30000);

  it('isolates row operation identities across independent batches with identical CSV and preserves each replay', async () => {
    const service = new BulkImportService(repository);
    const batchIds = [id(), id()] as const;
    const correlationIds = [id(), id()] as const;
    const values = [
      'ALTA',
      '',
      '',
      'SKU-SAME-FILE',
      '',
      'Producto idéntico',
      'Descripción',
      'cat-1',
      'marca-1',
      'tipo-1',
      'false',
      '12.5',
      '[]',
      '',
      '',
      '0',
    ];
    const bytes = Buffer.from(
      `${BULK_TEMPLATE_HEADERS.join(',')}\r\n${values.join(',')}\r\n`,
      'utf8',
    );
    const makeInput = (index: 0 | 1) => ({
      bytes,
      format: 'CSV' as const,
      templateVersion: 2,
      correlationId: correlationIds[index],
      batchId: batchIds[index],
      contentRef: 'test://same-csv-file',
    });

    const admitted = await Promise.all([
      service.receiveImport(makeInput(0)),
      service.receiveImport(makeInput(1)),
    ]);
    const initialIdentities = admitted.map((result) => ({
      rowId: result.parsed.rows[0]!.rowId,
      rowOperationId: result.parsed.rows[0]!.rowOperationId,
    }));
    expect(initialIdentities[0]?.rowOperationId).not.toBe(
      initialIdentities[1]?.rowOperationId,
    );
    expect(initialIdentities[0]?.rowId).toBe(
      initialIdentities[0]?.rowOperationId,
    );
    expect(initialIdentities[1]?.rowId).toBe(
      initialIdentities[1]?.rowOperationId,
    );

    const admittedCommands = await Promise.all(
      batchIds.map((batchId) => repository.findImportAdmissionIntent(batchId)),
    );
    const envelopes = admittedCommands.map(
      (intent) =>
        (
          intent!.catalogCommands as Array<{
            message_id: string;
            operation_id: string;
            data: {
              batch_id: string;
              rows: Array<{ row_operation_id: string }>;
            };
          }>
        )[0]!,
    );
    expect(envelopes[0]!.data.rows[0]!.row_operation_id).toBe(
      initialIdentities[0]!.rowOperationId,
    );
    expect(envelopes[1]!.data.rows[0]!.row_operation_id).toBe(
      initialIdentities[1]!.rowOperationId,
    );
    expect(new Set(envelopes.map((envelope) => envelope.message_id)).size).toBe(
      2,
    );

    const relay = new BulkOutboxRelay(repository, broker.url);
    await relay.flush();
    const delivered = [await broker.nextCommand(), await broker.nextCommand()];
    expect(
      new Set(
        delivered.map(
          (item) => (item as { data: { batch_id: string } }).data.batch_id,
        ),
      ),
    ).toEqual(new Set(batchIds));

    for (const [index, envelope] of envelopes.entries()) {
      const row = admitted[index]!.parsed.rows[0]!;
      await broker.publishResult({
        message_id: id(),
        schema_version: 1,
        occurred_at: new Date().toISOString(),
        correlation_id: correlationIds[index],
        causation_id: envelope.message_id,
        operation_id: envelope.operation_id,
        producer: 'catalog-svc',
        kind: 'result',
        name: 'catalog.bulk.upsert.completed',
        data: {
          batch_id: batchIds[index],
          batch_operation_id: envelope.operation_id,
          results: [
            {
              row_number: row.rowNumber,
              row_operation_id: row.rowOperationId,
              product_id: id(),
              sku_base: row.skuBase,
              status: 'COMPLETED',
              code: null,
            },
          ],
        },
      });
    }
    await waitFor(async () => {
      const stepSets = await Promise.all(
        batchIds.map(async (batchId, index) =>
          repository.listRowSteps(
            batchId,
            admitted[index]!.parsed.rows[0]!.rowId,
          ),
        ),
      );
      return stepSets.every((steps) =>
        steps.some(
          (step) => step.domain === 'CATALOGO' && step.status === 'COMPLETED',
        ),
      );
    });

    const replayed = await Promise.all([
      service.receiveImport(makeInput(0)),
      service.receiveImport(makeInput(1)),
    ]);
    expect(
      replayed.map((result) => ({
        rowId: result.parsed.rows[0]!.rowId,
        rowOperationId: result.parsed.rows[0]!.rowOperationId,
      })),
    ).toEqual(initialIdentities);
    expect(
      await Promise.all(
        batchIds.map((batchId) =>
          repository.findImportAdmissionIntent(batchId),
        ),
      ),
    ).toEqual(admittedCommands);
  }, 60000);

  it('persists, replays and consolidates multiple 1 MiB chunks with distinct chunk identities', async () => {
    const batchId = id();
    const correlationId = id();
    const service = new BulkImportService(repository);
    const rows = [
      { rowId: id(), rowOperationId: id(), rowNumber: 2, skuBase: 'FAMILY-A' },
      { rowId: id(), rowOperationId: id(), rowNumber: 3, skuBase: 'FAMILY-A' },
      { rowId: id(), rowOperationId: id(), rowNumber: 4, skuBase: 'FAMILY-B' },
    ];
    const input = {
      batchId,
      correlationId,
      contentRef: `test://${id()}`,
      format: 'CSV',
      templateVersion: 2,
      rows: rows.map((row, index) => ({
        rowId: row.rowId,
        productId: null,
        mode: 'ALTA' as const,
        skuIdentityRequired: true,
        skuBase: row.skuBase,
        variantSkus: [`${row.skuBase}-${index}`],
        stockInicial: 0,
      })),
      intentRows: rows.map((row, index) => ({
        ...row,
        productId: null,
        variantId: null,
        product: { nombre: `Producto ${index} ${'x'.repeat(400_000)}` },
        variant: null,
      })),
    };
    await service.createImport(input);
    const original = (await repository.findPendingOutbox(10))
      .filter((item) => item.correlationId === correlationId)
      .sort((left, right) => {
        const leftRows = (
          left.payload as { data: { rows: Array<{ row_number: number }> } }
        ).data.rows;
        const rightRows = (
          right.payload as { data: { rows: Array<{ row_number: number }> } }
        ).data.rows;
        return leftRows[0]!.row_number - rightRows[0]!.row_number;
      });
    expect(original).toHaveLength(2);
    const originalById = new Map(
      original.map((item) => [item.messageId, item]),
    );
    const firstEnvelopes = original.map((item) => item.payload);
    const identityValues = firstEnvelopes.map((value) => {
      const envelope = value as {
        operation_id: string;
        data: { batch_operation_id: string; rows: Array<{ sku_base: string }> };
      };
      expect(envelope.operation_id).toBe(envelope.data.batch_operation_id);
      return envelope.data.batch_operation_id;
    });
    expect(new Set(identityValues).size).toBe(2);
    expect(
      firstEnvelopes.map((value) =>
        (
          value as { data: { rows: Array<{ sku_base: string }> } }
        ).data.rows.map((row) => row.sku_base),
      ),
    ).toEqual([['FAMILY-A', 'FAMILY-A'], ['FAMILY-B']]);

    await service.createImport(input);
    const replayed = (await repository.findPendingOutbox(10))
      .filter((item) => item.correlationId === correlationId)
      .sort((left, right) => {
        const leftRows = (
          left.payload as { data: { rows: Array<{ row_number: number }> } }
        ).data.rows;
        const rightRows = (
          right.payload as { data: { rows: Array<{ row_number: number }> } }
        ).data.rows;
        return leftRows[0]!.row_number - rightRows[0]!.row_number;
      });
    expect(replayed.map((item) => fingerprint(item.payload))).toEqual(
      firstEnvelopes.map(fingerprint),
    );
    expect(replayed.map((item) => item.messageId)).toEqual(
      original.map((item) => item.messageId),
    );

    const relay = new BulkOutboxRelay(repository, broker.url);
    await relay.flush();
    const delivered = [
      await broker.nextCommand(),
      await broker.nextCommand(),
    ].sort((left, right) => {
      const leftRows = (
        left as { data: { rows: Array<{ row_number: number }> } }
      ).data.rows;
      const rightRows = (
        right as { data: { rows: Array<{ row_number: number }> } }
      ).data.rows;
      return leftRows[0]!.row_number - rightRows[0]!.row_number;
    });
    expect(delivered.map(fingerprint)).toEqual(firstEnvelopes.map(fingerprint));

    for (const [chunkIndex, commandValue] of firstEnvelopes.entries()) {
      const command = commandValue as {
        message_id: string;
        operation_id: string;
        occurred_at: string;
        correlation_id: string;
        data: {
          batch_operation_id: string;
          rows: Array<{
            row_number: number;
            row_operation_id: string;
            sku_base: string;
          }>;
        };
      };
      const results = command.data.rows.map((row) => ({
        row_number: row.row_number,
        row_operation_id: row.row_operation_id,
        product_id: `product-${row.row_number}`,
        sku_base: row.sku_base,
        status: 'COMPLETED',
        code: null,
      }));
      const resultMessageId = id();
      await broker.publishResult({
        message_id: resultMessageId,
        schema_version: 1,
        occurred_at: new Date().toISOString(),
        correlation_id: correlationId,
        causation_id: command.message_id,
        operation_id: command.operation_id,
        producer: 'catalog-svc',
        kind: 'result',
        name: 'catalog.bulk.upsert.completed',
        data: {
          batch_id: batchId,
          batch_operation_id: command.data.batch_operation_id,
          results,
        },
      });
      await waitFor(async () => {
        const receipt = await pool.query(
          'SELECT payload FROM bulk.inbox WHERE message_id = $1 AND handler = $2',
          [resultMessageId, 'bulk.catalog.invalid-result'],
        );
        if (receipt.rows.length > 0)
          throw new Error(
            `Chunk result was durably rejected: ${JSON.stringify(receipt.rows[0]?.payload)}`,
          );
        const row = rows[chunkIndex];
        if (chunkIndex === 0 && row) {
          const statuses = await Promise.all(
            rows
              .slice(0, 2)
              .map(async (entry) =>
                repository.listRowSteps(batchId, entry.rowId),
              ),
          );
          return statuses
            .flat()
            .every(
              (step) =>
                step.domain !== 'CATALOGO' || step.status === 'COMPLETED',
            );
        }
        const statuses = await repository.listRowSteps(batchId, rows[2]!.rowId);
        return statuses.some(
          (step) => step.domain === 'CATALOGO' && step.status === 'COMPLETED',
        );
      });
      expect(originalById.has(command.message_id)).toBe(true);
      expect(command.occurred_at).not.toBe('1970-01-01T00:00:00.000Z');
    }
    for (const row of rows) {
      const steps = await repository.listRowSteps(batchId, row.rowId);
      expect(steps.find((step) => step.domain === 'CATALOGO')?.status).toBe(
        'COMPLETED',
      );
      expect(
        steps
          .filter((step) => step.domain !== 'CATALOGO')
          .every((step) => step.status === 'PENDING'),
      ).toBe(true);
    }
  }, 60000);

  it('confirms Outbox publication, applies multi-row mixed results atomically, deduplicates transport and operation replay', async () => {
    const batchId = id();
    const correlationId = id();
    const batchOperationId = id();
    const rowA = {
      rowId: id(),
      rowOperationId: id(),
      rowNumber: 2,
      skuBase: 'SKU-A',
    };
    const rowB = {
      rowId: id(),
      rowOperationId: id(),
      rowNumber: 3,
      skuBase: 'SKU-B',
    };
    const command = {
      message_id: id(),
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      correlation_id: correlationId,
      causation_id: null,
      operation_id: id(),
      producer: 'bulk-svc',
      kind: 'command',
      name: 'catalog.bulk.upsert.requested',
      data: {
        batch_id: batchId,
        batch_operation_id: batchOperationId,
        template_version: 2,
        mode: 'ALTA',
        rows: [
          {
            row_number: rowA.rowNumber,
            row_operation_id: rowA.rowOperationId,
            producto_id: null,
            sku_base: rowA.skuBase,
            product: { nombre: 'A' },
            variant_id: null,
            variant: null,
          },
          {
            row_number: rowB.rowNumber,
            row_operation_id: rowB.rowOperationId,
            producto_id: null,
            sku_base: rowB.skuBase,
            product: { nombre: 'B' },
            variant_id: null,
            variant: null,
          },
        ],
      },
    };
    const admissionIntent = {
      batchOperationId,
      rows: [rowA, rowB],
      catalogCommands: [command],
    };
    await repository.createImportBatch({
      batchId,
      correlationId,
      templateVersion: 2,
      inputFile: { format: 'CSV', contentRef: `test://${id()}` },
      rows: [
        { rowId: rowA.rowId, requiredDomains: ['CATALOGO'] },
        { rowId: rowB.rowId, requiredDomains: ['CATALOGO'] },
      ],
      admissionIntent,
      catalogCommands: [
        {
          messageId: command.message_id,
          eventName: command.name,
          kind: 'command',
          schemaVersion: command.schema_version,
          correlationId,
          operationId: command.operation_id,
          occurredAt: new Date(command.occurred_at),
          payload: command,
        },
      ],
    });

    const unavailable = new BulkOutboxRelay(
      repository,
      'amqp://fixture:fixture@127.0.0.1:1/g6-productos-ofertas',
    );
    await unavailable.flush();
    const confirmedRelay = new BulkOutboxRelay(repository, broker.url);
    await confirmedRelay.flush();
    expect(await broker.nextCommand()).toEqual(command);

    const results = [
      {
        row_number: rowA.rowNumber,
        row_operation_id: rowA.rowOperationId,
        product_id: 'product-a',
        sku_base: rowA.skuBase,
        status: 'COMPLETED',
        code: null,
      },
      {
        row_number: rowB.rowNumber,
        row_operation_id: rowB.rowOperationId,
        product_id: null,
        sku_base: rowB.skuBase,
        status: 'REJECTED',
        code: 'VALIDACION',
      },
    ];
    const resultMessageId = id();
    const resultEnvelope = {
      message_id: resultMessageId,
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      correlation_id: correlationId,
      causation_id: command.message_id,
      operation_id: command.operation_id,
      producer: 'catalog-svc',
      kind: 'result',
      name: 'catalog.bulk.upsert.completed',
      data: {
        batch_id: batchId,
        batch_operation_id: batchOperationId,
        results,
      },
    };
    const invalidReplay = structuredClone(resultEnvelope);
    invalidReplay.message_id = id();
    invalidReplay.data.results[1]!.row_number += 1;
    await broker.publishResult(invalidReplay);
    await waitFor(async () =>
      (await repository.listBatchRows(batchId)).every(
        (row) => row.status === 'PENDING',
      ),
    );

    await broker.publishResult(resultEnvelope);
    await waitFor(
      async () =>
        (await repository.findBatchByBatchId(batchId))?.status === 'COMPLETED',
    );
    const rows = await repository.listBatchRows(batchId);
    expect(rows.map((row) => row.status).sort()).toEqual([
      'COMPLETED',
      'FAILED',
    ]);
    expect(
      rows.some(
        (row) =>
          row.appliedDomains.includes('PRICING') ||
          row.appliedDomains.includes('INVENTARIO'),
      ),
    ).toBe(false);
    const {
      rows: [messageReceiptCount],
    } = await pool.query(
      'SELECT count(*)::int AS count FROM bulk.inbox WHERE message_id = $1 AND handler = $2',
      [resultMessageId, 'bulk.catalog.bulk-upsert.result'],
    );
    expect(messageReceiptCount?.count).toBe(1);

    await broker.publishResult(resultEnvelope);
    const replayId = id();
    await broker.publishResult({ ...resultEnvelope, message_id: replayId });
    await waitFor(async () => {
      const {
        rows: [receipt],
      } = await pool.query(
        'SELECT count(*)::int AS count FROM bulk.inbox WHERE message_id = $1 AND handler = $2',
        [replayId, 'bulk.catalog.bulk-upsert.result'],
      );
      return receipt?.count === 1;
    });
    expect(await repository.listBatchRows(batchId)).toEqual(rows);

    const conflicted = structuredClone(resultEnvelope);
    conflicted.message_id = id();
    conflicted.data.results[0]!.product_id = 'different-product';
    await broker.publishResult(conflicted);
    await waitFor(async () => {
      const {
        rows: [receipt],
      } = await pool.query(
        'SELECT count(*)::int AS count FROM bulk.inbox WHERE message_id = $1 AND handler = $2',
        [conflicted.message_id, 'bulk.catalog.invalid-result'],
      );
      return receipt?.count === 1;
    });
    const {
      rows: [resultReceipts],
    } = await pool.query(
      'SELECT count(*)::int AS count FROM bulk.inbox WHERE message_id = $1 AND handler = $2',
      [conflicted.message_id, 'bulk.catalog.bulk-upsert.result'],
    );
    expect(resultReceipts?.count).toBe(0);
    const {
      rows: [inboxRows],
    } = await pool.query(
      'SELECT count(*)::int AS count FROM bulk.inbox WHERE message_id = $1',
      [resultMessageId],
    );
    expect(inboxRows?.count).toBe(3);
  }, 60000);

  it('treats catalog.bulk.upsert.rejected as a command-level rejection', async () => {
    const batchId = id();
    const batchOperationId = id();
    const correlationId = id();
    const rowId = id();
    const rowOperationId = id();
    const command = {
      message_id: id(),
      operation_id: id(),
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      correlation_id: correlationId,
      causation_id: null,
      producer: 'bulk-svc',
      kind: 'command',
      name: 'catalog.bulk.upsert.requested',
      data: {
        batch_id: batchId,
        batch_operation_id: batchOperationId,
        template_version: 2,
        mode: 'ALTA',
        rows: [
          {
            row_number: 2,
            row_operation_id: rowOperationId,
            producto_id: null,
            sku_base: 'SKU-REJECTED',
            product: { nombre: 'Producto' },
            variant_id: null,
            variant: null,
          },
        ],
      },
    };
    await repository.createImportBatch({
      batchId,
      correlationId,
      templateVersion: 2,
      inputFile: { format: 'CSV', contentRef: `test://${id()}` },
      rows: [{ rowId, requiredDomains: ['CATALOGO'] }],
      admissionIntent: {
        batchOperationId,
        rows: [
          { rowId, rowOperationId, rowNumber: 2, skuBase: 'SKU-REJECTED' },
        ],
        catalogCommands: [command],
      },
      catalogCommands: [
        {
          messageId: command.message_id,
          eventName: command.name,
          kind: 'command',
          schemaVersion: 1,
          correlationId,
          operationId: command.operation_id,
          occurredAt: new Date(command.occurred_at),
          payload: command,
        },
      ],
    });
    const rejection = {
      message_id: id(),
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      correlation_id: correlationId,
      causation_id: command.message_id,
      operation_id: command.operation_id,
      producer: 'catalog-svc',
      kind: 'result',
      name: 'catalog.bulk.upsert.rejected',
      data: {
        batch_id: batchId,
        batch_operation_id: batchOperationId,
        code: 'VALIDACION',
        detail: 'El comando fue rechazado antes de procesar filas.',
      },
    };
    await broker.publishResult(rejection);
    await waitFor(
      async () =>
        (await repository.listBatchRows(batchId))[0]?.status === 'FAILED',
    );
    const [row] = await repository.listBatchRows(batchId);
    expect(row?.failedDomain).toBe('CATALOGO');
    expect(row?.appliedDomains).toEqual([]);
    const batch = await repository.findBatchByBatchId(batchId);
    expect(batch?.failedRows).toBe(1);
  }, 30000);

  it('keeps publisher-confirmed but unrouted commands pending and pauses the relay', async () => {
    const messageId = id();
    await repository.enqueueOutbox({
      messageId,
      eventName: 'catalog.bulk.upsert.unrouted-test',
      kind: 'command',
      schemaVersion: 1,
      correlationId: id(),
      operationId: id(),
      occurredAt: new Date(),
      payload: {
        message_id: messageId,
        name: 'catalog.bulk.upsert.unrouted-test',
      },
    });
    const relay = new BulkOutboxRelay(repository, broker.url);
    await relay.flush();
    const pending = await repository.findPendingOutbox(10);
    expect(
      pending.some(
        (item) =>
          item.messageId === messageId &&
          item.publishedAt === null &&
          item.lastError === 'PUBLICATION_UNROUTED',
      ),
    ).toBe(true);
  }, 30000);

  it('recovers a transient broker outage in the same relay process without losing the pending command', async () => {
    const messageId = id();
    await repository.enqueueOutbox({
      messageId,
      eventName: 'catalog.bulk.upsert.requested',
      kind: 'command',
      schemaVersion: 1,
      correlationId: id(),
      operationId: id(),
      occurredAt: new Date(),
      payload: {
        message_id: messageId,
        name: 'catalog.bulk.upsert.requested',
      },
    });
    const relay = new BulkOutboxRelay(repository, broker.url);
    await broker.suspend();
    await relay.flush();
    expect(
      (await repository.findPendingOutbox(10)).some(
        (item) => item.messageId === messageId && item.publishedAt === null,
      ),
    ).toBe(true);

    await broker.resume();
    await waitFor(async () => {
      await relay.flush();
      return !(await repository.findPendingOutbox(10)).some(
        (item) => item.messageId === messageId,
      );
    });
    const delivered = await broker.nextCommand();
    expect(delivered).toEqual({
      message_id: messageId,
      name: 'catalog.bulk.upsert.requested',
    });
    expect(
      (await repository.findPendingOutbox(10)).some(
        (item) => item.messageId === messageId,
      ),
    ).toBe(false);
  }, 90000);
});

async function waitFor(
  predicate: () => Promise<boolean | undefined>,
): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    'El estado esperado no apareció en el plazo de la prueba aislada.',
  );
}
