import { randomUUID } from 'node:crypto';
import { ManagedIdentityCredential } from '@azure/identity';
import { ServiceBusClient, type ServiceBusReceiver } from '@azure/service-bus';
import { Pool, type PoolClient } from 'pg';
import { CatalogServiceBus } from '../../apps/catalog-svc/src/catalog-service-bus.js';
import { envelope } from '../../apps/catalog-svc/src/catalog-messages.js';
import { CombosEventConsumer } from '../../apps/combos-svc/src/messaging/combos-event-consumer.js';
import type { CombosEventQueue } from '../../apps/combos-svc/src/messaging/combos-service-bus.js';
import type { CombosDatabase } from '../../apps/combos-svc/src/persistence/combos.database.js';
import { CombosRepository } from '../../apps/combos-svc/src/persistence/combos.repository.js';
import { DatabaseService } from '../../apps/inventory-svc/src/database/database.service.js';
import {
  InventoryDeliveryStore,
  INVENTORY_QUEUES,
} from '../../apps/inventory-svc/src/messaging/service-bus-deliveries.js';
import { InventoryServiceBusRelay } from '../../apps/inventory-svc/src/messaging/service-bus-relay.js';
import { OutboxService } from '../../apps/inventory-svc/src/outbox/outbox.service.js';
import { DrizzleOutboxRepository } from '../../apps/inventory-svc/src/repositories/drizzle/drizzle-outbox.repository.js';
import { prepareInitializationDatabases } from './initialization-lab-postgres.js';

describe.skipIf(!process.env.G6_H5_COMBOS_PG_URL)('Combos H5 events', () => {
  let lab: Awaited<ReturnType<typeof prepareInitializationDatabases>>;
  let combos: Awaited<ReturnType<typeof lab.prepareCombos>>;

  beforeAll(async () => {
    lab = await prepareInitializationDatabases(
      process.env.G6_H5_COMBOS_PG_URL!,
    );
    combos = await lab.prepareCombos();
  }, 75_000);
  afterAll(async () => {
    await lab?.close();
    vi.unstubAllEnvs();
  });

  it('creates disposable Combos persistence', async () => {
    expect(
      (
        await combos.pool.query(
          "SELECT to_regclass('combos.inbox')::text AS relation",
        )
      ).rows,
    ).toEqual([{ relation: 'combos.inbox' }]);
  });

  it.skipIf(process.env.G6_H5_COMBOS_REAL_AZURE !== '1')(
    'R05 SKU deactivation and R12 stock change persist once with Service Bus redelivery',
    async () => {
      const ns = process.env.G6_H5_LAB_NAMESPACE_FQDN ?? '';
      const ids = ['CATALOG', 'INVENTORY', 'COMBOS'].map(
        (name) => process.env[`G6_H5_LAB_${name}_CLIENT_ID`] ?? '',
      );
      if (
        !/^g6-sb-h5-int-[a-z0-9]{13}\.servicebus\.windows\.net$/.test(ns) ||
        !ids.every((id) =>
          /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id),
        ) ||
        new Set(ids.map((id) => id.toLowerCase())).size !== ids.length
      )
        throw new Error('DEDICATED_H5_LAB_AND_DISTINCT_IDENTITIES_REQUIRED');
      const client = (id: string) =>
        new ServiceBusClient(
          ns,
          new ManagedIdentityCredential({ clientId: id }),
          {
            retryOptions: { maxRetries: 1, timeoutInMs: 8_000 },
          },
        );
      const catalogQueue = 'g6.combos.from.catalog';
      const inventoryQueue = INVENTORY_QUEUES.COMBOS;
      const catalogBus = new CatalogServiceBus(client(ids[0]));
      const inventoryBus = client(ids[1]);
      const combosBus = client(ids[2]);
      const catalogIn = combosBus.createReceiver(catalogQueue, {
        receiveMode: 'peekLock',
        skipParsingBodyAsJson: true,
      });
      const inventoryIn = combosBus.createReceiver(inventoryQueue, {
        receiveMode: 'peekLock',
        skipParsingBodyAsJson: true,
      });
      const combosPool = new Pool({
        connectionString: combos.runtimeUrl.href,
        connectionTimeoutMillis: 2000,
      });
      const combosDb = {
        query: async <T>(work: (client: PoolClient) => Promise<T>) => {
          const client = await combosPool.connect();
          try {
            return await work(client);
          } finally {
            client.release();
          }
        },
      } as CombosDatabase;
      const consumer = new CombosEventConsumer(new CombosRepository(combosDb));
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('MESSAGING_PROVIDER', 'AZURE_SERVICE_BUS');
      vi.stubEnv('SERVICE_BUS_NAMESPACE_FQDN', ns);
      vi.stubEnv('G6_SERVICE_BUS_PILOT_ENABLED', 'true');
      vi.stubEnv('INVENTORY_SERVICE_BUS_PUBLISH_ENABLED', 'false');
      vi.stubEnv('INVENTORY_SERVICE_BUS_CONSUME_ENABLED', 'false');
      vi.stubEnv(
        'DATABASE_URL',
        lab.inventory.runtimeUrl.href + '?sslmode=disable',
      );
      const inventoryDb = new DatabaseService();
      const stock = new OutboxService(new DrizzleOutboxRepository(inventoryDb));
      const stockRelay = new InventoryServiceBusRelay(
        new InventoryDeliveryStore(inventoryDb),
        new Map([[inventoryQueue, inventoryBus.createSender(inventoryQueue)]]),
      );

      try {
        await inventoryDb.onModuleInit();
        const sku = 'H5-COMBO-' + randomUUID();
        const comboId = randomUUID();
        const itemId = randomUUID();
        await combos.pool.query(
          "INSERT INTO combos.combos(id,name,combo_price,currency) VALUES ($1,'Synthetic combo',50,'PEN')",
          [comboId],
        );
        await combos.pool.query(
          'INSERT INTO combos.combo_items(id,combo_id,sku,quantity) VALUES ($1,$2,$3,1)',
          [itemId, comboId, sku],
        );
        await combos.pool.query(
          "INSERT INTO combos.component_projection(combo_item_id,catalog_deactivated,projected_available,inventory_observed_at) VALUES ($1,false,4,'2000-01-01')",
          [itemId],
        );
        const projection = async () =>
          (
            await combos.pool.query(
              'SELECT catalog_deactivated,projected_available,inventory_observed_at FROM combos.component_projection WHERE combo_item_id=$1',
              [itemId],
            )
          ).rows;

        async function receiveTwice(
          queue: CombosEventQueue,
          receiver: ServiceBusReceiver,
          id: string,
        ) {
          const receive = async () => {
            const [delivery] = await receiver.receiveMessages(1, {
              maxWaitTimeInMs: 12_000,
              abortSignal: AbortSignal.timeout(15_000),
            });
            expect(delivery?.messageId).toBe(id);
            return delivery;
          };
          const assertInbox = async () => {
            const inbox = await combos.pool.query(
              'SELECT result FROM combos.inbox WHERE message_id=$1',
              [id],
            );
            expect(inbox.rows).toEqual([{ result: 'PROCESSED' }]);
          };
          const initial = await receive();
          let committed = false;
          await consumer.processServiceBusDelivery(
            queue,
            {
              completeMessage: async (delivery) => {
                await assertInbox();
                await receiver.abandonMessage(delivery);
                committed = true;
              },
              abandonMessage: receiver.abandonMessage.bind(receiver),
              deadLetterMessage: receiver.deadLetterMessage.bind(receiver),
            },
            initial,
          );
          expect(committed).toBe(true);
          const replay = await receive();
          expect(replay.deliveryCount).toBeGreaterThan(initial.deliveryCount);
          await consumer.processServiceBusDelivery(queue, receiver, replay);
          await assertInbox();
        }

        const deactivation = envelope(
          'catalog.sku.deactivated',
          {
            product_id: randomUUID(),
            sku,
            sku_version: 3,
            changed_at: new Date().toISOString(),
          },
          randomUUID(),
          randomUUID(),
        );
        await catalogBus.publish(
          catalogQueue,
          deactivation,
          AbortSignal.timeout(10_000),
        );
        await receiveTwice(catalogQueue, catalogIn, deactivation.message_id);
        expect(await projection()).toEqual([
          expect.objectContaining({ catalog_deactivated: true }),
        ]);

        const operation = randomUUID();
        const correlation = randomUUID();
        await inventoryDb.transaction((tx) =>
          stock.stockChanged(tx, {
            sku,
            location_id: randomUUID(),
            on_hand: 7,
            reserved: 1,
            blocked: 0,
            stock_version: 2,
            operationId: operation,
            correlationId: correlation,
          }),
        );
        const stored = await lab.inventory.pool.query(
          "SELECT event_id, payload->>'message_id' AS message_id FROM inventory.outbox WHERE correlation_id=$1",
          [correlation],
        );
        expect(stored.rowCount).toBe(1);
        // R13 runs in its own fixture. Only R12 is due in this test.
        const deferred = await lab.inventory.pool.query(
          "UPDATE inventory.outbox_delivery SET next_attempt_at=clock_timestamp()+interval '1 hour' WHERE message_id=$1 AND destination=$2",
          [stored.rows[0].event_id, INVENTORY_QUEUES.PROMOTIONS],
        );
        expect(deferred.rowCount).toBe(1);
        expect(await stockRelay.publishOne()).toBe('sent');
        await receiveTwice(
          inventoryQueue,
          inventoryIn,
          stored.rows[0].message_id,
        );
        expect(await projection()).toEqual([
          {
            catalog_deactivated: true,
            projected_available: null,
            inventory_observed_at: expect.any(Date),
          },
        ]);
      } finally {
        await Promise.allSettled([
          catalogBus.close(),
          inventoryBus.close(),
          combosBus.close(),
          combosPool.end(),
          inventoryDb.onModuleDestroy(),
        ]);
      }
    },
    100_000,
  );
});
