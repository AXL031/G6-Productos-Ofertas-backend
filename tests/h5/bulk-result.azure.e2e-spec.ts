import { randomUUID } from 'node:crypto';
import { ManagedIdentityCredential } from '@azure/identity';
import { ServiceBusClient } from '@azure/service-bus';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { CatalogServiceBus } from '../../apps/catalog-svc/src/catalog-service-bus.js';
import { envelope } from '../../apps/catalog-svc/src/catalog-messages.js';
import { CatalogBulkResultConsumer } from '../../apps/bulk-svc/src/messaging/catalog-bulk-result-consumer.js';
import { BulkPersistenceRepository } from '../../apps/bulk-svc/src/persistence/bulk.repository.js';
import { bulkSchema } from '../../apps/bulk-svc/src/persistence/bulk.schema.js';
import { prepareInitializationDatabases } from './initialization-lab-postgres.js';

function fixture(rejected: boolean) {
  const batchOperationId = randomUUID();
  return {
    rejected,
    batchId: randomUUID(),
    correlationId: randomUUID(),
    operationId: batchOperationId,
    batchOperationId,
    commandId: randomUUID(),
    row: {
      rowId: randomUUID(),
      rowOperationId: randomUUID(),
      rowNumber: 2,
      skuBase: 'H5-BULK-' + randomUUID(),
    },
  };
}

function result(test: ReturnType<typeof fixture>) {
  const {
    batchId,
    correlationId,
    operationId,
    batchOperationId,
    commandId,
    row,
    rejected,
  } = test;
  return envelope(
    rejected ? 'catalog.bulk.upsert.rejected' : 'catalog.bulk.upsert.completed',
    {
      batch_id: batchId,
      batch_operation_id: batchOperationId,
      ...(rejected
        ? { code: 'VALIDACION', detail: 'Synthetic rejection' }
        : {
            results: [
              {
                row_number: row.rowNumber,
                row_operation_id: row.rowOperationId,
                product_id: randomUUID(),
                sku_base: row.skuBase,
                status: 'COMPLETED',
                code: null,
              },
            ],
          }),
    },
    correlationId,
    operationId,
    commandId,
  );
}

describe.skipIf(!process.env.G6_H5_BULK_PG_URL)(
  'Bulk H5 catalog results',
  () => {
    let lab: Awaited<ReturnType<typeof prepareInitializationDatabases>>;
    let db: Awaited<ReturnType<typeof lab.prepareBulk>>;
    let runtime: Pool;
    let bulk: BulkPersistenceRepository;
    const cases = [fixture(false), fixture(true)];

    beforeAll(async () => {
      lab = await prepareInitializationDatabases(
        process.env.G6_H5_BULK_PG_URL!,
      );
      db = await lab.prepareBulk();
      runtime = new Pool({
        connectionString: db.runtimeUrl.href,
        connectionTimeoutMillis: 2000,
      });
      bulk = new BulkPersistenceRepository(
        drizzle(runtime, { schema: bulkSchema, logger: false }),
      );
      for (const test of cases) {
        const {
          batchId,
          correlationId,
          operationId,
          batchOperationId,
          commandId,
          row,
        } = test;
        const command = {
          message_id: commandId,
          schema_version: 1,
          occurred_at: new Date().toISOString(),
          correlation_id: correlationId,
          causation_id: null,
          operation_id: operationId,
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
                row_number: row.rowNumber,
                row_operation_id: row.rowOperationId,
                producto_id: null,
                sku_base: row.skuBase,
                product: { nombre: 'Fixture' },
                variant_id: null,
                variant: null,
              },
            ],
          },
        };
        // Seed an admitted historical batch. The command is never published.
        await bulk.createImportBatch({
          batchId,
          correlationId,
          templateVersion: 2,
          inputFile: { format: 'CSV', contentRef: 'test://' + batchId },
          rows: [{ rowId: row.rowId, requiredDomains: ['CATALOGO'] }],
          admissionIntent: {
            batchOperationId,
            rows: [row],
            catalogCommands: [command],
          },
          catalogCommands: [
            {
              messageId: commandId,
              eventName: command.name,
              kind: 'command',
              schemaVersion: 1,
              correlationId,
              operationId,
              occurredAt: new Date(command.occurred_at),
              payload: command,
            },
          ],
        });
      }
    }, 75_000);
    afterAll(async () => {
      await Promise.allSettled([runtime?.end(), lab?.close()]);
    });

    it('loads two previously admitted disposable batches without publishing a command', async () => {
      for (const test of cases) {
        const { batchId, row } = test;
        expect(result(test).operation_id).toBe(test.batchOperationId);
        expect(await bulk.listRowSteps(batchId, row.rowId)).toEqual([
          expect.objectContaining({ domain: 'CATALOGO', status: 'PENDING' }),
        ]);
      }
    });

    it.skipIf(process.env.G6_H5_BULK_REAL_AZURE === '1')(
      'reconciles the same contract results against PostgreSQL without transport',
      async () => {
        for (const test of cases) {
          const reply = result(test);
          const input = {
            messageId: reply.message_id,
            operationId: test.operationId,
            causationId: test.commandId,
            correlationId: test.correlationId,
            eventName: test.rejected
              ? ('catalog.bulk.upsert.rejected' as const)
              : ('catalog.bulk.upsert.completed' as const),
            payload: { ...reply },
          };
          expect((await bulk.recordCatalogBulkResult(input)).processed).toBe(
            true,
          );
          expect((await bulk.recordCatalogBulkResult(input)).processed).toBe(
            false,
          );
          expect(await bulk.listRowSteps(test.batchId, test.row.rowId)).toEqual(
            [
              expect.objectContaining({
                domain: 'CATALOGO',
                status: test.rejected ? 'FAILED' : 'COMPLETED',
              }),
            ],
          );
        }
      },
    );

    it.skipIf(process.env.G6_H5_BULK_REAL_AZURE !== '1')(
      'R04 reconciles accepted and rejected Catalog results once after redelivery',
      async () => {
        const namespace = process.env.G6_H5_LAB_NAMESPACE_FQDN ?? '';
        const ids = [
          process.env.G6_H5_LAB_CATALOG_CLIENT_ID ?? '',
          process.env.G6_H5_LAB_BULK_CLIENT_ID ?? '',
        ];
        if (
          !/^g6-sb-h5-int-[a-z0-9]{13}\.servicebus\.windows\.net$/.test(
            namespace,
          ) ||
          !ids.every((id) =>
            /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id),
          ) ||
          ids[0].toLowerCase() === ids[1].toLowerCase()
        )
          throw new Error('DEDICATED_H5_LAB_AND_DISTINCT_IDENTITIES_REQUIRED');
        const client = (id: string) =>
          new ServiceBusClient(
            namespace,
            new ManagedIdentityCredential({ clientId: id }),
            {
              retryOptions: { maxRetries: 1, timeoutInMs: 8_000 },
            },
          );
        const queue = 'g6.bulk.from.catalog';
        const catalog = new CatalogServiceBus(client(ids[0]));
        const bulkBus = client(ids[1]);
        const receiver = bulkBus.createReceiver(queue, {
          receiveMode: 'peekLock',
          skipParsingBodyAsJson: true,
        });
        const consumer = new CatalogBulkResultConsumer(bulk, null);

        try {
          for (const test of cases) {
            const { batchId, row, rejected } = test;
            const reply = result(test);
            await catalog.publish(queue, reply, AbortSignal.timeout(10_000));
            const receive = async () => {
              const [message] = await receiver.receiveMessages(1, {
                maxWaitTimeInMs: 12_000,
                abortSignal: AbortSignal.timeout(15_000),
              });
              expect(message?.messageId).toBe(reply.message_id);
              return message;
            };
            const assertDurable = async () => {
              expect(await bulk.listRowSteps(batchId, row.rowId)).toEqual([
                expect.objectContaining({
                  domain: 'CATALOGO',
                  status: rejected ? 'FAILED' : 'COMPLETED',
                }),
              ]);
              const receipt = await db.pool.query(
                'SELECT payload FROM bulk.inbox WHERE message_id=$1 AND handler=$2',
                [reply.message_id, 'bulk.catalog.bulk-upsert.result'],
              );
              expect(receipt.rows).toEqual([{ payload: reply }]);
            };
            const first = await receive();
            let committed = false;
            await consumer.handleAzure(first, {
              completeMessage: async (message) => {
                await assertDurable();
                await receiver.abandonMessage(message);
                committed = true;
              },
              abandonMessage: receiver.abandonMessage.bind(receiver),
              deadLetterMessage: receiver.deadLetterMessage.bind(receiver),
            });
            expect(committed).toBe(true);
            const replay = await receive();
            expect(replay.deliveryCount).toBeGreaterThan(
              first.deliveryCount ?? 0,
            );
            await consumer.handleAzure(replay, receiver);
            await assertDurable();
          }
        } finally {
          await Promise.allSettled([
            catalog.close(),
            bulkBus.close(),
            consumer.onModuleDestroy(),
          ]);
        }
      },
      100_000,
    );
  },
);
