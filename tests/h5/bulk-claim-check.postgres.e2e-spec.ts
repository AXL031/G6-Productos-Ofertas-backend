import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ManagedIdentityCredential } from '@azure/identity';
import {
  ServiceBusClient,
  type ServiceBusReceivedMessage,
  type ServiceBusMessage,
  type ServiceBusReceiver,
} from '@azure/service-bus';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { BulkImportService } from '../../apps/bulk-svc/src/bulk-import.service.js';
import { BulkCatalogContentController } from '../../apps/bulk-svc/src/http/bulk-catalog-content.controller.js';
import { BulkCatalogBusPublisher } from '../../apps/bulk-svc/src/messaging/bulk-catalog-bus-publisher.js';
import { CatalogBulkResultConsumer } from '../../apps/bulk-svc/src/messaging/catalog-bulk-result-consumer.js';
import { BulkPersistenceRepository } from '../../apps/bulk-svc/src/persistence/bulk.repository.js';
import { bulkSchema } from '../../apps/bulk-svc/src/persistence/bulk.schema.js';
import {
  CatalogBulkContentReader,
  type CatalogBulkContentIdentity,
} from '../../apps/catalog-svc/src/catalog-bulk-content.js';
import {
  CatalogBulkService,
  type CatalogBulkIdentity,
} from '../../apps/catalog-svc/src/catalog-bulk.service.js';
import { parseCatalogMessage } from '../../apps/catalog-svc/src/catalog-messages.js';
import { CatalogMutationService } from '../../apps/catalog-svc/src/catalog-mutation.service.js';
import { relayCatalogDelivery } from '../../apps/catalog-svc/src/catalog-service-bus-relay.js';
import {
  CatalogServiceBus,
  normalizeCatalogServiceBusBody,
} from '../../apps/catalog-svc/src/catalog-service-bus.js';
import { CatalogTransactionManager } from '../../apps/catalog-svc/src/catalog-transaction.js';
import { Database } from '../../apps/catalog-svc/src/database.js';
import { PostgresCatalogWriteRepository } from '../../apps/catalog-svc/src/postgres-catalog-write.repository.js';
import type { CatalogMasterClient } from '../../apps/catalog-svc/src/catalog-master.client.js';
import { prepareInitializationDatabases } from './initialization-lab-postgres.js';

const pgUrl = process.env.G6_H5_R01_PG_URL;
const realAzure = process.env.G6_H5_R01_REAL_AZURE === '1';
const commandQueue = 'g6.catalog.from.bulk';
const resultQueue = 'g6.bulk.from.catalog';

function azureClients() {
  if (!realAzure) return;
  const namespace = process.env.G6_H5_LAB_NAMESPACE_FQDN ?? '';
  const bulkId = process.env.G6_H5_LAB_BULK_CLIENT_ID ?? '';
  const catalogId = process.env.G6_H5_LAB_CATALOG_CLIENT_ID ?? '';
  if (
    !/^g6-sb-h5-int-[a-z0-9]{13}\.servicebus\.windows\.net$/.test(namespace) ||
    ![bulkId, catalogId].every((id) =>
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id),
    ) ||
    bulkId.toLowerCase() === catalogId.toLowerCase()
  )
    throw new Error('DEDICATED_H5_LAB_AND_DISTINCT_IDENTITIES_REQUIRED');
  const client = (id: string) =>
    new ServiceBusClient(
      namespace,
      new ManagedIdentityCredential({ clientId: id }),
      { retryOptions: { maxRetries: 0, timeoutInMs: 8000 } },
    );
  return { namespace, bulk: client(bulkId), catalog: client(catalogId) };
}

async function receive(receiver: ServiceBusReceiver, messageId: string) {
  const [message] = await receiver.receiveMessages(1, {
    maxWaitTimeInMs: 12_000,
    abortSignal: AbortSignal.timeout(15_000),
  });
  expect(message?.messageId).toBe(messageId);
  return message;
}

it.skipIf(!pgUrl)(
  'reconciles an admitted R01 claim-check and R04 against real PostgreSQL',
  async () => {
    const azure = azureClients();
    const lab = await prepareInitializationDatabases(pgUrl!);
    const bulkDb = await lab.prepareBulk();
    const pool = new Pool({ connectionString: bulkDb.runtimeUrl.href });
    const bulk = new BulkPersistenceRepository(
      drizzle(pool, { schema: bulkSchema }),
    );
    const catalog = new Database({
      pool: { connectionString: lab.catalog.runtimeUrl.href },
      expectedRole: lab.catalog.user,
      database: lab.catalog.name,
      user: lab.catalog.user,
      password: lab.catalog.password,
      mode: 'direct',
    });
    const fixtureIssuer = 'https://g7-r01.fixture.test';
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    for (const [key, value] of Object.entries({
      MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
      SERVICE_BUS_NAMESPACE_FQDN:
        azure?.namespace ?? 'claimcheck-fixture.servicebus.windows.net',
      BULK_SERVICE_BUS_CATALOG_RESULTS_ENABLED: 'true',
      BULK_SERVICE_BUS_CATALOG_COMMANDS_ENABLED: 'true',
      BULK_CATALOG_CONTENT_ENABLED: 'true',
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      G7_JWT_ISSUER: fixtureIssuer,
      G7_JWT_PUBLIC_KEY: publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString(),
      CATALOG_H5_DESTINATIONS: resultQueue,
    }))
      vi.stubEnv(key, value);
    vi.stubEnv('G7_JWT_JWKS_URL', undefined);
    const module = await Test.createTestingModule({
      controllers: [BulkCatalogContentController],
      providers: [{ provide: BulkPersistenceRepository, useValue: bulk }],
    }).compile();
    const app = module.createNestApplication();
    const now = Math.floor(Date.now() / 1000);
    const encoded = [
      { alg: 'RS256' },
      {
        tipo: 'servicio',
        sub: 'catalog-svc',
        scope: 'carga-masiva:contenidos:leer',
        aud: 'api-productos',
        iss: fixtureIssuer,
        iat: now,
        exp: now + 90,
        jti: randomUUID(),
      },
    ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
      .join('.');
    const authorization =
      'Bearer ' +
      encoded +
      '.' +
      sign('RSA-SHA256', Buffer.from(encoded), privateKey).toString(
        'base64url',
      );
    const authenticateContent = vi.fn(async () => authorization);
    const reader = new CatalogBulkContentReader({
      authorization: authenticateContent,
    } as unknown as CatalogBulkContentIdentity);
    const mutations = new CatalogMutationService(
      new CatalogTransactionManager(catalog),
      new PostgresCatalogWriteRepository(),
      { masters: async () => undefined } as unknown as CatalogMasterClient,
    );
    const handler = new CatalogBulkService(
      catalog,
      mutations,
      {
        authorization: async () => 'Bearer taxonomy-fixture',
      } as unknown as CatalogBulkIdentity,
      reader,
    );
    const results = new CatalogBulkResultConsumer(bulk, null);
    const batchId = randomUUID(),
      correlationId = randomUUID(),
      rowId = randomUUID(),
      productId = randomUUID();
    const sku = 'R01-' + randomUUID();
    try {
      await app.listen(0, '127.0.0.1');
      vi.stubEnv('CATALOG_BULK_CONTENT_ORIGIN', await app.getUrl());
      const before = await catalog.transaction(
        async (tx) =>
          (
            await tx.execute<{ catalog_version: number }>(sql`
      INSERT INTO catalog.products (id,nombre,descripcion,categoria_id,tipo_producto_id,marca_id,sku_base,slug,tiene_variantes)
      VALUES (${productId}, 'Antes', 'Synthetic', 'lab-category', 'lab-type', 'lab-brand', ${sku}, ${sku}, false)
      RETURNING catalog_version
    `)
          ).rows[0],
      );
      await new BulkImportService(bulk).createImport({
        batchId,
        correlationId,
        format: 'CSV',
        templateVersion: 2,
        contentRef: 'test://' + batchId,
        rows: [
          {
            rowId,
            productId,
            mode: 'ACTUALIZACION',
            skuBase: sku,
            variantSkus: [],
          },
        ],
        intentRows: [
          {
            rowId,
            rowOperationId: rowId,
            rowNumber: 2,
            productId,
            skuBase: sku,
            product: {
              catalogVersion: Number(before.catalog_version),
              nombre: 'Después ñ',
            },
            variant: null,
          },
        ],
      });
      expect(await bulk.findPendingOutbox(10, true, 'LEGACY')).toHaveLength(0);
      const pending = await bulk.findPendingOutbox(
        10,
        true,
        'CATALOG_SERVICE_BUS',
      );
      expect(pending).toHaveLength(1);
      const { messageId } = pending[0];
      const publisher = new BulkCatalogBusPublisher(bulk);
      const consume = async (transport: ServiceBusMessage) => {
        const command = parseCatalogMessage(
          normalizeCatalogServiceBusBody(transport.body),
          true,
        );
        expect(command).toMatchObject({
          message_id: transport.messageId,
          correlation_id: transport.correlationId,
          name: transport.subject,
          schema_version: 3,
          data: { mode: 'ACTUALIZACION' },
        });
        expect(transport.contentType).toBe('application/json');
        expect(command.data).not.toHaveProperty('rows');
        return handler.consume(command);
      };
      if (azure) {
        const receiver = azure.catalog.createReceiver(commandQueue, {
          skipParsingBodyAsJson: true,
        });
        const sender = azure.bulk.createSender(commandQueue);
        await publisher.flush(sender);
        const first = await receive(receiver, messageId);
        expect(await consume(first)).toBe('APPLIED');
        await receiver.abandonMessage(first);
        const redelivery = await receive(receiver, messageId);
        expect(redelivery.deliveryCount).toBeGreaterThan(
          first.deliveryCount ?? 0,
        );
        expect(await consume(redelivery)).toBe('DUPLICATE');
        await receiver.completeMessage(redelivery);
      } else {
        let transportMessage: ServiceBusMessage | undefined;
        const sender = {
          createMessageBatch: vi.fn(async () => ({
            tryAddMessage: (message: ServiceBusMessage) => {
              transportMessage = message;
              return (
                Buffer.isBuffer(message.body) &&
                message.body.byteLength < 256 * 1024
              );
            },
          })),
          sendMessages: vi.fn(async () => {
            expect(await consume(transportMessage!)).toBe('APPLIED');
            expect(await consume(transportMessage!)).toBe('DUPLICATE');
          }),
        };
        await publisher.flush(
          sender as unknown as Parameters<BulkCatalogBusPublisher['flush']>[0],
        );
      }
      expect(authenticateContent).toHaveBeenCalledTimes(1);
      expect(
        await relayCatalogDelivery(catalog, {
          publish: async (queue, envelope) => {
            expect(queue).toBe(resultQueue);
            expect(envelope).toMatchObject({
              name: 'catalog.bulk.upsert.completed',
              causation_id: messageId,
            });
            const completed = async () => {
              expect((await bulk.findBatchByBatchId(batchId))?.status).toBe(
                'COMPLETED',
              );
            };
            if (azure) {
              const bus = new CatalogServiceBus(azure.catalog);
              const receiver = azure.bulk.createReceiver(resultQueue, {
                skipParsingBodyAsJson: true,
              });
              await bus.publish(queue, envelope, AbortSignal.timeout(8000));
              const first = await receive(receiver, envelope.message_id);
              await results.handleAzure(first, {
                completeMessage: async (message) => {
                  await completed();
                  await receiver.abandonMessage(message);
                },
                abandonMessage: receiver.abandonMessage.bind(receiver),
                deadLetterMessage: receiver.deadLetterMessage.bind(receiver),
              });
              const replay = await receive(receiver, envelope.message_id);
              expect(replay.deliveryCount).toBeGreaterThan(
                first.deliveryCount ?? 0,
              );
              await results.handleAzure(replay, receiver);
              await completed();
              return;
            }
            const result = {
              body: Buffer.from(JSON.stringify(envelope)),
              contentType: 'application/json',
              subject: envelope.name,
              messageId: envelope.message_id,
              correlationId: envelope.correlation_id,
            } as ServiceBusReceivedMessage;
            const receiver = {
              completeMessage: vi.fn(completed),
              abandonMessage: vi.fn(),
              deadLetterMessage: vi.fn(),
            };
            await results.handleAzure(result, receiver);
            await results.handleAzure(result, receiver);
            expect(receiver.completeMessage).toHaveBeenCalledTimes(2);
            expect(receiver.deadLetterMessage).not.toHaveBeenCalled();
            expect(receiver.abandonMessage).not.toHaveBeenCalled();
          },
        }),
      ).toBe('CONFIRMED');
      const product = (
        await lab.catalog.pool.query(
          'SELECT nombre,catalog_version FROM catalog.products WHERE id=$1',
          [productId],
        )
      ).rows[0];
      expect(product.nombre).toBe('Después ñ');
      expect(Number(product.catalog_version)).toBe(
        Number(before.catalog_version) + 1,
      );
      expect(
        await bulk.findPendingOutbox(10, false, 'CATALOG_SERVICE_BUS'),
      ).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
      await Promise.allSettled([
        app.close(),
        results.onModuleDestroy(),
        catalog.onModuleDestroy(),
        pool.end(),
        lab.close(),
        azure?.bulk.close(),
        azure?.catalog.close(),
      ]);
    }
  },
  90_000,
);
