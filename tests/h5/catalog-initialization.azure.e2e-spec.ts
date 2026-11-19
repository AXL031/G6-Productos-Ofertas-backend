import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ManagedIdentityCredential } from '@azure/identity';
import { ServiceBusClient, type ServiceBusReceiver } from '@azure/service-bus';
import { sql } from 'drizzle-orm';
import { Database } from '../../apps/catalog-svc/src/database.js';
import { CatalogServiceBus } from '../../apps/catalog-svc/src/catalog-service-bus.js';
import { relayCatalogDelivery } from '../../apps/catalog-svc/src/catalog-service-bus-relay.js';
import { CatalogMessageService } from '../../apps/catalog-svc/src/catalog-message.service.js';
import {
  envelope,
  type CatalogEnvelope,
} from '../../apps/catalog-svc/src/catalog-messages.js';
import { DatabaseService } from '../../apps/inventory-svc/src/database/database.service.js';
import { InventoryCommandService } from '../../apps/inventory-svc/src/inbox/inventory-command.service.js';
import { InventoryServiceBusHandler } from '../../apps/inventory-svc/src/messaging/service-bus-consumer.js';
import { InventoryDeliveryStore } from '../../apps/inventory-svc/src/messaging/service-bus-deliveries.js';
import { InventoryServiceBusRelay } from '../../apps/inventory-svc/src/messaging/service-bus-relay.js';
import { IdempotencyService } from '../../apps/inventory-svc/src/idempotency/idempotency.service.js';
import { OutboxService } from '../../apps/inventory-svc/src/outbox/outbox.service.js';
import { DrizzleInboxRepository } from '../../apps/inventory-svc/src/repositories/drizzle/drizzle-inbox.repository.js';
import { DrizzleLocationsRepository } from '../../apps/inventory-svc/src/repositories/drizzle/drizzle-locations.repository.js';
import { DrizzleOperationsRepository } from '../../apps/inventory-svc/src/repositories/drizzle/drizzle-operations.repository.js';
import { DrizzleOutboxRepository } from '../../apps/inventory-svc/src/repositories/drizzle/drizzle-outbox.repository.js';
import { DrizzleStockBalanceRepository } from '../../apps/inventory-svc/src/repositories/drizzle/drizzle-stock-balance.repository.js';
import type { PricingConfig } from '../../apps/pricing-svc/src/config/environment.js';
import { CatalogSkuDeactivated } from '../../apps/pricing-svc/src/messaging/catalog-sku-deactivated.js';
import { PricingProductInitialization } from '../../apps/pricing-svc/src/messaging/pricing-initialization.js';
import { PricingCatalogServiceBusHandler } from '../../apps/pricing-svc/src/messaging/service-bus-catalog.js';
import {
  CATALOG_PRICING_QUEUE,
  PricingDeliveryStore,
} from '../../apps/pricing-svc/src/messaging/service-bus-deliveries.js';
import { PricingServiceBusRelay } from '../../apps/pricing-svc/src/messaging/service-bus-relay.js';
import { PricingDatabase } from '../../apps/pricing-svc/src/persistence/pricing.database.js';
import { PricingRepository } from '../../apps/pricing-svc/src/persistence/pricing.repository.js';
import { prepareInitializationDatabases } from './initialization-lab-postgres.js';

const commands = {
  INVENTORY: 'g6.inventory.from.catalog',
  PRICING: 'g6.pricing.from.catalog',
} as const;
const results = {
  INVENTORY: 'g6.catalog.from.inventory',
  PRICING: CATALOG_PRICING_QUEUE,
} as const;
type Dependency = keyof typeof commands;

function azureClients() {
  const namespace = process.env.G6_H5_LAB_NAMESPACE_FQDN ?? '';
  const ids = ['CATALOG', 'INVENTORY', 'PRICING'].map(
    (service) => process.env[`G6_H5_LAB_${service}_CLIENT_ID`] ?? '',
  );
  if (
    !/^g6-sb-h5-int-[a-z0-9]{13}\.servicebus\.windows\.net$/.test(namespace) ||
    !ids.every((id) =>
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id),
    ) ||
    new Set(ids.map((id) => id.toLowerCase())).size !== ids.length
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
  return {
    namespace,
    catalog: client(ids[0]),
    inventory: client(ids[1]),
    pricing: client(ids[2]),
  };
}

async function receive(receiver: ServiceBusReceiver, id: string) {
  const [message] = await receiver.receiveMessages(1, {
    maxWaitTimeInMs: 12_000,
    abortSignal: AbortSignal.timeout(15_000),
  });
  expect(message?.messageId).toBe(id);
  return message;
}

function configureInventory(url: URL, namespace: string) {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('MESSAGING_PROVIDER', 'AZURE_SERVICE_BUS');
  vi.stubEnv('SERVICE_BUS_NAMESPACE_FQDN', namespace);
  vi.stubEnv('G6_SERVICE_BUS_PILOT_ENABLED', 'true');
  vi.stubEnv('INVENTORY_SERVICE_BUS_PUBLISH_ENABLED', 'false');
  vi.stubEnv('INVENTORY_SERVICE_BUS_CONSUME_ENABLED', 'false');
  vi.stubEnv('INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED', 'true');
  vi.stubEnv('DATABASE_URL', url.href + '?sslmode=disable');
  for (const name of [
    'PGHOST',
    'PGDATABASE',
    'PGUSER',
    'PGPASSWORD',
    'PGSSLMODE',
    'PGSSLROOTCERT',
    'RABBITMQ_URL',
  ])
    vi.stubEnv(name, undefined);
}

describe.skipIf(!process.env.G6_H5_INIT_PG_URL)(
  'Catalog H5 bilateral initialization',
  () => {
    let db: Awaited<ReturnType<typeof prepareInitializationDatabases>>;

    beforeAll(async () => {
      db = await prepareInitializationDatabases(process.env.G6_H5_INIT_PG_URL!);
    }, 75_000);
    afterAll(async () => {
      await db?.close();
      vi.unstubAllEnvs();
    });

    it('prepares independent disposable databases with the H5 delivery tables', async () => {
      for (const context of ['catalog', 'inventory', 'pricing'] as const) {
        const result = await db[context].pool.query(
          'SELECT current_database() AS name, to_regclass($1)::text AS delivery',
          [context + '.outbox_delivery'],
        );
        expect(result.rows).toEqual([
          { name: 'g6_h5_' + context, delivery: context + '.outbox_delivery' },
        ]);
      }
    });

    it('starts Inventory H5 with a runtime role that owns neither delivery table', async () => {
      const inventory = new DatabaseService();
      configureInventory(
        db.inventory.runtimeUrl,
        'g6-sb-h5-int-fixture000000.servicebus.windows.net',
      );
      try {
        await inventory.onModuleInit();
        const { rows } = await inventory.query(
          "SELECT current_user AS role, pg_has_role(current_user, 'po_inventory_owner', 'MEMBER') AS owner",
        );
        expect(rows).toEqual([{ role: 'inventory_app', owner: false }]);
      } finally {
        await inventory.onModuleDestroy();
        vi.unstubAllEnvs();
      }
    });

    it.skipIf(process.env.G6_H5_INIT_REAL_AZURE !== '1')(
      'commits and replays R06/R07/R11/R15 with Service Bus and all three databases',
      async () => {
        const bus = azureClients();
        const catalog = new CatalogServiceBus(bus.catalog);
        configureInventory(db.inventory.runtimeUrl, bus.namespace);
        vi.stubEnv(
          'CATALOG_H5_DESTINATIONS',
          Object.values(commands).join(','),
        );
        const catalogDb = new Database({
          pool: { connectionString: db.catalog.runtimeUrl.href },
          expectedRole: db.catalog.user,
          database: db.catalog.name,
          user: db.catalog.user,
          password: db.catalog.password,
          mode: 'direct',
        });
        const inventoryDb = new DatabaseService();
        const pricingConfig: PricingConfig = {
          nodeEnv: 'test',
          port: 3002,
          securityMode: 'G7_AUTHENTICATED',
          publicOperations: [],
          databaseUrl: db.pricing.runtimeUrl.href,
          databaseSsl: false,
          serviceBus: {
            namespace: bus.namespace,
            catalogEnabled: true,
            fanoutEnabled: true,
          },
          priceChangedPublishingEnabled: true,
        };
        const pricingDb = new PricingDatabase(pricingConfig);
        const pricing = new PricingRepository(pricingDb);
        const catalogResults = new CatalogMessageService(catalogDb);
        const inventoryIn = bus.inventory.createReceiver(commands.INVENTORY, {
          receiveMode: 'peekLock',
          skipParsingBodyAsJson: true,
        });
        const pricingIn = bus.pricing.createReceiver(commands.PRICING, {
          receiveMode: 'peekLock',
          skipParsingBodyAsJson: true,
        });
        const inventoryOut = new InventoryServiceBusRelay(
          new InventoryDeliveryStore(inventoryDb),
          new Map([
            [results.INVENTORY, bus.inventory.createSender(results.INVENTORY)],
          ]),
        );
        const pricingOut = new PricingServiceBusRelay(
          new PricingDeliveryStore(pricing, results.PRICING),
          bus.pricing.createSender(results.PRICING),
          results.PRICING,
        );
        const inventory = new InventoryCommandService(
          inventoryDb,
          new IdempotencyService(),
          new OutboxService(new DrizzleOutboxRepository(inventoryDb)),
          new DrizzleInboxRepository(inventoryDb),
          new DrizzleOperationsRepository(inventoryDb),
          new DrizzleLocationsRepository(inventoryDb),
          new DrizzleStockBalanceRepository(inventoryDb),
        );
        const initialization = new PricingProductInitialization(
          pricing,
          pricingConfig,
        );
        const deactivated = new CatalogSkuDeactivated(pricing);
        const interrupted = new Set<string>();
        const completed = new Set<string>();
        const stopReceivers: (() => Promise<void>)[] = [];

        async function persistCatalogCommand(
          dependency: Dependency,
          message: CatalogEnvelope,
          sku: string,
        ) {
          await catalogDb.transaction(async (tx) => {
            await tx.execute(sql`
            INSERT INTO catalog.products (id,nombre,descripcion,categoria_id,tipo_producto_id,marca_id,sku_base,slug,tiene_variantes)
            VALUES (${message.data.product_id}, 'Lab SKU', 'Synthetic', 'lab-category', 'lab-type', 'lab-brand', ${sku}, ${sku}, false)
            ON CONFLICT (id) DO NOTHING
          `);
            if (message.kind === 'command')
              await tx.execute(sql`
              INSERT INTO catalog.activation_checks (product_id,sku,dependency,operation_id,correlation_id,state,request_payload)
              VALUES (${message.data.product_id},${sku},${dependency},${message.operation_id},${message.correlation_id},'PENDING',${JSON.stringify(message.data)}::jsonb)
            `);
            await tx.execute(sql`
            INSERT INTO catalog.outbox (message_id,schema_version,event_name,kind,correlation_id,operation_id,occurred_at,payload)
            VALUES (${message.message_id}, 1, ${message.name}, ${message.kind}, ${message.correlation_id}, ${message.operation_id}, ${message.occurred_at}::timestamptz, ${JSON.stringify(message.data)}::jsonb)
          `);
          });
        }

        async function catalogOutcome(
          message: CatalogEnvelope,
          state: string,
          code: string | null,
        ) {
          const end = Date.now() + 20_000;
          while (!completed.has(message.message_id) && Date.now() < end)
            await delay(200);
          expect(completed.has(message.message_id)).toBe(true);
          const row = await db.catalog.pool.query(
            `SELECT c.state, c.result_payload, i.result, i.payload
             FROM catalog.activation_checks c JOIN catalog.inbox i ON i.message_id=c.result_message_id
            WHERE c.operation_id=$1`,
            [message.operation_id],
          );
          expect(row.rows).toEqual([
            expect.objectContaining({
              state,
              result: 'APPLIED',
              result_payload: expect.objectContaining({ code }),
              payload: expect.objectContaining({
                correlation_id: message.correlation_id,
                causation_id: message.message_id,
                operation_id: message.operation_id,
              }),
            }),
          ]);
        }

        async function roundTrip(
          dependency: Dependency,
          msg: CatalogEnvelope,
          sku: string,
          code: string | null,
        ) {
          const receiver = dependency === 'INVENTORY' ? inventoryIn : pricingIn;
          await persistCatalogCommand(dependency, msg, sku);
          expect(await relayCatalogDelivery(catalogDb, catalog)).toBe(
            'CONFIRMED',
          );
          const first = await receive(receiver, msg.message_id);
          let abandonedAfterCommit = false;
          const settle = {
            completeMessage: async (delivery: typeof first) => {
              if (!abandonedAfterCommit) {
                const pending = await db[
                  dependency === 'INVENTORY' ? 'inventory' : 'pricing'
                ].pool.query(
                  dependency === 'INVENTORY'
                    ? "SELECT 1 FROM inventory.outbox WHERE payload->>'causation_id'=$1"
                    : 'SELECT 1 FROM pricing.outbox WHERE causation_id=$1',
                  [msg.message_id],
                );
                expect(pending.rowCount).toBe(1);
                await receiver.abandonMessage(delivery);
                abandonedAfterCommit = true;
              } else {
                await receiver.completeMessage(delivery);
              }
            },
            abandonMessage: receiver.abandonMessage.bind(receiver),
            deadLetterMessage: receiver.deadLetterMessage.bind(receiver),
          };
          const handler =
            dependency === 'INVENTORY'
              ? new InventoryServiceBusHandler(inventory, settle)
              : new PricingCatalogServiceBusHandler(
                  initialization,
                  deactivated,
                  settle,
                );
          await handler.handle(first);
          expect(abandonedAfterCommit).toBe(true);
          const replay = await receive(receiver, msg.message_id);
          expect(replay.deliveryCount).toBeGreaterThan(first.deliveryCount);
          await handler.handle(replay);
          const relay = dependency === 'INVENTORY' ? inventoryOut : pricingOut;
          expect(await relay.publishOne()).toBe('sent');
          await catalogOutcome(msg, code ? 'REJECTED' : 'COMPLETED', code);
          expect(await relay.publishOne()).toBe('empty');
        }

        try {
          await inventoryDb.onModuleInit();
          await catalogDb.verifyIdentity();
          for (const destination of Object.values(results)) {
            const stop = catalog.subscribe(
              destination,
              {
                consume: async (message) => {
                  const result = await catalogResults.consume(message);
                  const id = message.causation_id!;
                  if (!interrupted.has(id)) {
                    expect(result).toBe('APPLIED');
                    interrupted.add(id);
                    // Force real abandon after the Catalog transaction, before settlement.
                    throw new Error('TEST_ABANDON_AFTER_CATALOG_COMMIT');
                  }
                  expect(result).toBe('DUPLICATE');
                  completed.add(id);
                  return result;
                },
              },
              () => {},
            );
            stopReceivers.push(stop);
          }
          const location = randomUUID();
          await db.inventory.pool.query(
            "INSERT INTO inventory.locations (id,code,name,type) VALUES ($1,'LAB','Synthetic','ALMACEN')",
            [location],
          );
          const product = randomUUID();
          const sku = 'H5-' + product;
          const inventoryRequest = (
            productId: string,
            skuId: string,
            locationId: string,
          ) =>
            envelope(
              'inventory.sku.initialization.requested',
              {
                product_id: productId,
                sku: skuId,
                variant_id: null,
                default_location_id: locationId,
              },
              randomUUID(),
              randomUUID(),
            );
          const priceRequest = (amount: number) =>
            envelope(
              'pricing.product.initialization.requested',
              {
                product_id: product,
                sku_base: sku,
                precio_regular: amount,
                moneda: 'PEN',
                channel_id: null,
                motivo_cambio: 'ALTA_PRODUCTO',
              },
              randomUUID(),
              randomUUID(),
            );
          await roundTrip(
            'INVENTORY',
            inventoryRequest(product, sku, location),
            sku,
            null,
          );
          await roundTrip(
            'INVENTORY',
            inventoryRequest(randomUUID(), sku + '-UNKNOWN', randomUUID()),
            sku + '-UNKNOWN',
            'UBICACION_NO_ENCONTRADA',
          );
          await roundTrip('PRICING', priceRequest(25.3), sku, null);
          await roundTrip(
            'PRICING',
            priceRequest(40),
            sku,
            'PRODUCT_ALREADY_INITIALIZED',
          );

          const balance = await db.inventory.pool.query(
            'SELECT on_hand, reserved, blocked, stock_version::int AS version FROM inventory.stock_balance WHERE sku_id=$1 AND location_id=$2',
            [sku, location],
          );
          expect(balance.rows).toEqual([
            { on_hand: 0, reserved: 0, blocked: 0, version: 0 },
          ]);
          const balances = await db.inventory.pool.query(
            'SELECT count(*)::int AS n FROM inventory.stock_balance',
          );
          expect(balances.rows[0].n).toBe(1);
          const price = await db.pricing.pool.query(
            'SELECT v.precio_regular::text AS amount FROM pricing.prices p JOIN pricing.price_validities v ON v.price_id=p.id WHERE p.product_id=$1',
            [product],
          );
          expect(price.rows).toEqual([{ amount: '25.30' }]);
          const fact = envelope(
            'catalog.sku.deactivated',
            {
              product_id: product,
              sku,
              sku_version: 3,
              changed_at: new Date().toISOString(),
            },
            randomUUID(),
            randomUUID(),
          );
          await persistCatalogCommand('INVENTORY', fact, sku);
          expect(await relayCatalogDelivery(catalogDb, catalog)).toBe(
            'CONFIRMED',
          );
          expect(await relayCatalogDelivery(catalogDb, catalog)).toBe(
            'CONFIRMED',
          );
          const handlers = [
            {
              receiver: inventoryIn,
              queue: commands.INVENTORY,
              handler: new InventoryServiceBusHandler(inventory, inventoryIn),
            },
            {
              receiver: pricingIn,
              queue: commands.PRICING,
              handler: new PricingCatalogServiceBusHandler(
                initialization,
                deactivated,
                pricingIn,
              ),
            },
          ];
          for (const { receiver, queue, handler } of handlers) {
            await handler.handle(await receive(receiver, fact.message_id));
            await catalog.publish(queue, fact, AbortSignal.timeout(8000));
            await handler.handle(await receive(receiver, fact.message_id));
          }
          const lifecycle = await db.inventory.pool.query(
            'SELECT active,sku_version FROM inventory.sku_lifecycle WHERE sku_id=$1',
            [sku],
          );
          expect(lifecycle.rows).toEqual([{ active: false, sku_version: 3 }]);
          const pricingReceipt = await db.pricing.pool.query(
            'SELECT result FROM pricing.inbox WHERE message_id=$1',
            [fact.message_id],
          );
          expect(pricingReceipt.rows).toEqual([{ result: 'APPLIED' }]);
          const inventoryReceipt = await db.inventory.pool.query(
            'SELECT status FROM inventory.inbox WHERE message_id=$1',
            [fact.message_id],
          );
          expect(inventoryReceipt.rows).toEqual([{ status: 'PROCESSED' }]);
        } finally {
          await Promise.allSettled(stopReceivers.map((stop) => stop()));
          await Promise.allSettled([
            catalog.close(),
            bus.inventory.close(),
            bus.pricing.close(),
            catalogDb.onModuleDestroy(),
            inventoryDb.onModuleDestroy(),
            pricingDb.onApplicationShutdown(),
          ]);
        }
      },
      150_000,
    );
  },
);
