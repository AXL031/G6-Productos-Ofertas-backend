import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
