import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ManagedIdentityCredential } from '@azure/identity';
import { ServiceBusClient } from '@azure/service-bus';
import type {
  ServiceBusMessage,
  ServiceBusReceivedMessage,
} from '@azure/service-bus';
import { Pool } from 'pg';
import { InventoryServiceBusRelay } from '../../apps/inventory-svc/src/messaging/service-bus-relay.js';
import { INVENTORY_QUEUES } from '../../apps/inventory-svc/src/messaging/service-bus-deliveries.js';
import {
  OutboxService,
  type OutboxRecord,
} from '../../apps/inventory-svc/src/outbox/outbox.service.js';
import type { IDatabaseClient } from '../../apps/inventory-svc/src/database/database.interface.js';
import { PromotionsAssignedEventDispatcher } from '../../apps/promotions-svc/src/coupons/assigned-event-dispatcher.js';
import { assignedH4Contracts } from '../../apps/promotions-svc/src/coupons/assigned-h4-contract.generated.js';
import { h4EventAdapters } from '../../apps/promotions-svc/src/coupons/h4-event-adapters.js';
import {
  PromotionsServiceBusEvents,
  nativePromotionsEventBus,
  type EventReceiver,
} from '../../apps/promotions-svc/src/coupons/service-bus-events.js';
import { officialMigrations } from '../../apps/promotions-svc/test/support/official-migrations.mjs';
import { CatalogServiceBus } from '../../apps/catalog-svc/src/catalog-service-bus.js';
import type { CatalogEnvelope } from '../../apps/catalog-svc/src/catalog-messages.js';

function catalogDeactivation(
  sku: string,
  productId: string,
  version: number,
): CatalogEnvelope {
  const occurred = new Date(
    Date.UTC(2026, 10, 18, 0, 0, version),
  ).toISOString();
  return {
    message_id: randomUUID(),
    schema_version: 1,
    occurred_at: occurred,
    correlation_id: randomUUID(),
    causation_id: null,
    operation_id: null,
    producer: 'catalog-svc',
    kind: 'event',
    name: 'catalog.sku.deactivated',
    data: {
      sku,
      product_id: productId,
      sku_version: version,
      changed_at: occurred,
    },
  };
}

function trackReceiver(
  receiver: EventReceiver,
  completed: string[],
): EventReceiver {
  return {
    peekMessages: receiver.peekMessages.bind(receiver),
    subscribe: receiver.subscribe.bind(receiver),
    abandonMessage: receiver.abandonMessage.bind(receiver),
    deadLetterMessage: receiver.deadLetterMessage.bind(receiver),
    close: receiver.close.bind(receiver),
    completeMessage: async (message) => {
      await receiver.completeMessage(message);
      completed.push(String(message.messageId));
    },
  };
}

describe.skipIf(process.env.PROMOTIONS_H5_POSTGRES_TESTS !== '1')(
  'Catalog and Inventory to Promotions H5 over the SDK message boundary',
  () => {
    let pool: Pool;

    beforeAll(async () => {
      const url = new URL(process.env.PROMOTIONS_H5_TEST_DATABASE_URL ?? '');
      if (
        url.hostname !== '127.0.0.1' ||
        !/^\/g6_promotions_h5_test_[a-z0-9]+$/.test(url.pathname)
      )
        throw new Error('DISPOSABLE_LOCAL_DATABASE_REQUIRED');
      pool = new Pool({
        connectionString: url.href,
        connectionTimeoutMillis: 2000,
      });
      const existing = await pool.query(
        "SELECT to_regnamespace('promotions') AS schema",
      );
      if (existing.rows[0].schema !== null)
        throw new Error('EMPTY_DATABASE_REQUIRED');
      const migrations: string[] = await officialMigrations();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'CREATE ROLE po_promotions_owner NOLOGIN; CREATE ROLE po_promotions_runtime NOLOGIN; CREATE SCHEMA promotions AUTHORIZATION po_promotions_owner',
        );
        await client.query('SET LOCAL ROLE po_promotions_owner');
        for (const migration of migrations) await client.query(migration);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    }, 30_000);

    afterAll(async () => pool?.end());

    it.skipIf(process.env.G6_H5_R13_REAL_AZURE !== '1')(
      'R13 uses the laboratory broker and the two assigned managed identities',
      async () => {
        const namespace = process.env.G6_H5_LAB_NAMESPACE_FQDN ?? '';
        const inventoryId = process.env.G6_H5_LAB_INVENTORY_CLIENT_ID ?? '';
        const promotionsId = process.env.G6_H5_LAB_PROMOTIONS_CLIENT_ID ?? '';
        const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
        if (
          !/^g6-sb-h5-int-[a-z0-9]{13}\.servicebus\.windows\.net$/.test(
            namespace,
          ) ||
          !uuid.test(inventoryId) ||
          !uuid.test(promotionsId) ||
          inventoryId.toLowerCase() === promotionsId.toLowerCase()
        ) {
          throw new Error(
            'DEDICATED_H5_LAB_AND_DISTINCT_MANAGED_IDENTITIES_REQUIRED',
          );
        }
        const destination = INVENTORY_QUEUES.PROMOTIONS;
        const completed: string[] = [];
        const inventory = new ServiceBusClient(
          namespace,
          new ManagedIdentityCredential({ clientId: inventoryId }),
          {
            retryOptions: { maxRetries: 0, timeoutInMs: 8000 },
          },
        );
        const promotions = new PromotionsServiceBusEvents(
          {
            namespace,
            eventsEnabled: true,
            eventQueues: [destination],
            managedIdentityClientId: promotionsId,
          },
          new PromotionsAssignedEventDispatcher(
            pool,
            h4EventAdapters,
            assignedH4Contracts,
            true,
          ),
          (config) => {
            const bus = nativePromotionsEventBus(config);
            return {
              close: () => bus.close(),
              receiver: (queue) =>
                trackReceiver(bus.receiver(queue), completed),
            };
          },
        );
        const sku = 'H5-REAL-' + randomUUID();
        const location_id = randomUUID();
        try {
          await promotions.onApplicationBootstrap();
          const unexpectedReceiver = inventory.createReceiver(destination);
          try {
            await expect(
              unexpectedReceiver.peekMessages(1, {
                abortSignal: AbortSignal.timeout(8000),
              }),
            ).rejects.toMatchObject({ code: 'UnauthorizedAccess' });
          } finally {
            await unexpectedReceiver.close().catch(() => undefined);
          }
          const rows: OutboxRecord[] = [];
          const record = new OutboxService({
            enqueue: async (_client, fact) => {
              rows.push(fact);
            },
            findPendingForUpdateSkipLocked: async () => [],
            findPending: async () => [],
            markAsPublished: async () => undefined,
          });
          const query: IDatabaseClient['query'] = async () => ({
            rows: [],
            rowCount: 0,
          });
          await record.stockChanged(
            { query },
            {
              sku,
              location_id,
              on_hand: 7,
              reserved: 1,
              blocked: 0,
              stock_version: 2,
              operationId: randomUUID(),
              correlationId: randomUUID(),
            },
          );
          const fact = rows[0];
          const claim = {
            token: randomUUID(),
            destination,
            row: { ...fact, id: randomUUID(), status: 'PENDING' as const },
          };
          const sender = inventory.createSender(destination);
          const relay = new InventoryServiceBusRelay(
            {
              claim: async () => claim,
              finish: async (_claim, outcome) => outcome === 'confirmed',
            },
            new Map([[destination, sender]]),
          );
          try {
            expect(await relay.publishOne()).toBe('sent');
            expect(await relay.publishOne()).toBe('sent');
            const deadline = Date.now() + 20_000;
            let inbox: Record<string, unknown>[] = [];
            while (Date.now() < deadline) {
              inbox = (
                await pool.query(
                  'SELECT completed_at, result FROM promotions.inbox WHERE message_id=$1 AND completed_at IS NOT NULL',
                  [fact.payload.message_id],
                )
              ).rows;
              if (
                inbox.length &&
                completed.filter((id) => id === fact.payload.message_id)
                  .length >= 2
              )
                break;
              await delay(200);
            }
            expect(inbox).toEqual([
              {
                completed_at: expect.any(Date),
                result: {
                  handled: true,
                  invalidation: {
                    domain: 'stock',
                    targetType: 'SKU',
                    targetId: sku,
                    locationId: location_id,
                    sourceVersion: '2',
                  },
                },
              },
            ]);
            expect(
              completed.filter((id) => id === fact.payload.message_id),
            ).toHaveLength(2);
          } finally {
            await sender.close();
          }
        } finally {
          await Promise.allSettled([
            promotions.onModuleDestroy(),
            inventory.close(),
          ]);
        }
      },
      75_000,
    );

    it.skipIf(process.env.G6_H5_R08_REAL_AZURE !== '1')(
      'R08 uses the laboratory broker to preserve the latest Catalog version',
      async () => {
        const namespace = process.env.G6_H5_LAB_NAMESPACE_FQDN ?? '';
        const catalogId = process.env.G6_H5_LAB_CATALOG_CLIENT_ID ?? '';
        const promotionsId = process.env.G6_H5_LAB_PROMOTIONS_CLIENT_ID ?? '';
        const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
        if (
          !/^g6-sb-h5-int-[a-z0-9]{13}\.servicebus\.windows\.net$/.test(
            namespace,
          ) ||
          !uuid.test(catalogId) ||
          !uuid.test(promotionsId) ||
          catalogId.toLowerCase() === promotionsId.toLowerCase()
        ) {
          throw new Error(
            'DEDICATED_H5_LAB_AND_DISTINCT_MANAGED_IDENTITIES_REQUIRED',
          );
        }
        const destination = 'g6.promotions.from.catalog';
        const completed: string[] = [];
        const catalog = new CatalogServiceBus(
          new ServiceBusClient(
            namespace,
            new ManagedIdentityCredential({
              clientId: catalogId,
            }),
          ),
        );
        const promotions = new PromotionsServiceBusEvents(
          {
            namespace,
            eventsEnabled: true,
            eventQueues: [destination],
            managedIdentityClientId: promotionsId,
          },
          new PromotionsAssignedEventDispatcher(
            pool,
            h4EventAdapters,
            assignedH4Contracts,
            true,
          ),
          (config) => {
            const bus = nativePromotionsEventBus(config);
            return {
              close: () => bus.close(),
              receiver: (queue) =>
                trackReceiver(bus.receiver(queue), completed),
            };
          },
        );
        const sku = 'H5-R08-' + randomUUID();
        const productId = randomUUID();
        const latest = catalogDeactivation(sku, productId, 3);
        const stale = catalogDeactivation(sku, productId, 2);
        try {
          await promotions.onApplicationBootstrap();
          for (const envelope of [latest, stale, latest]) {
            await catalog.publish(
              destination,
              envelope,
              AbortSignal.timeout(8000),
            );
          }
          const deadline = Date.now() + 20_000;
          while (completed.length < 3 && Date.now() < deadline)
            await delay(200);
          expect(completed.toSorted()).toEqual(
            [latest.message_id, stale.message_id, latest.message_id].toSorted(),
          );
          const projection = await pool.query(
            'SELECT active, source_version, source_message_id FROM promotions.catalog_projection WHERE reference_type=$1 AND reference_id=$2',
            ['SKU', sku],
          );
          expect(projection.rows).toEqual([
            {
              active: false,
              source_version: '3',
              source_message_id: latest.message_id,
            },
          ]);
          const inbox = await pool.query(
            'SELECT count(*)::int AS n FROM promotions.inbox WHERE message_id::text = ANY($1::text[]) AND completed_at IS NOT NULL',
            [[latest.message_id, stale.message_id]],
          );
          expect(inbox.rows[0]?.n).toBe(2);
        } finally {
          await Promise.allSettled([
            promotions.onModuleDestroy(),
            catalog.close(),
          ]);
        }
      },
      75_000,
    );

    it('persists Catalog SKU deactivation and does not roll back its source version on redelivery', async () => {
      const destination = 'g6.promotions.from.catalog';
      const wire: ServiceBusReceivedMessage[] = [];
      const client = {
        createSender: vi.fn(() => ({
          createMessageBatch: async () => ({
            tryAddMessage: (m: ServiceBusMessage) => {
              wire.push(m as ServiceBusReceivedMessage);
              return true;
            },
          }),
          sendMessages: async () => undefined,
        })),
        close: async () => undefined,
      } as unknown as ServiceBusClient;
      const producer = new CatalogServiceBus(client);
      const sku = 'H5-R08-FIXTURE';
      const product = randomUUID();
      for (const version of [3, 2]) {
        await producer.publish(
          destination,
          catalogDeactivation(sku, product, version),
        );
      }
      expect(wire).toHaveLength(2);
      expect(wire[0].applicationProperties).toBeUndefined();
      let handlers: Parameters<EventReceiver['subscribe']>[0] | undefined;
      const completeMessage = vi.fn(async () => undefined);
      const abandonMessage = vi.fn(async () => undefined);
      const deadLetterMessage = vi.fn(async () => undefined);
      const runtime = new PromotionsServiceBusEvents(
        {
          namespace: 'test-h5.servicebus.windows.net',
          eventsEnabled: true,
          eventQueues: [destination],
        },
        new PromotionsAssignedEventDispatcher(
          pool,
          h4EventAdapters,
          assignedH4Contracts,
          true,
        ),
        () => ({
          receiver: (queue) => {
            expect(queue).toBe(destination);
            return {
              subscribe: (h) => {
                handlers = h;
                return { close: async () => undefined };
              },
              peekMessages: async () => [],
              completeMessage,
              abandonMessage,
              deadLetterMessage,
              close: async () => undefined,
            };
          },
          close: async () => undefined,
        }),
      );
      try {
        await runtime.onApplicationBootstrap();
        for (const delivery of [wire[0], wire[1], wire[0]])
          await handlers!.processMessage(delivery);
        const projection = await pool.query(
          'SELECT active, source_version, source_message_id FROM promotions.catalog_projection WHERE reference_type=$1 AND reference_id=$2',
          ['SKU', sku],
        );
        expect(projection.rows).toEqual([
          {
            active: false,
            source_version: '3',
            source_message_id: wire[0].messageId,
          },
        ]);
        expect(completeMessage).toHaveBeenCalledTimes(3);
        expect(abandonMessage).not.toHaveBeenCalled();
        expect(deadLetterMessage).not.toHaveBeenCalled();
      } finally {
        await runtime.onModuleDestroy();
        await producer.close();
      }
    });

    it('handles the real Inventory envelope and replays it after settlement loss', async () => {
      const rows: OutboxRecord[] = [];
      const record = new OutboxService({
        enqueue: async (_client, fact) => {
          rows.push(fact);
        },
        findPendingForUpdateSkipLocked: async () => [],
        findPending: async () => [],
        markAsPublished: async () => undefined,
      });
      const query: IDatabaseClient['query'] = async () => ({
        rows: [],
        rowCount: 0,
      });
      const sku = 'H5-R13-FIXTURE';
      const location = randomUUID();
      await record.stockChanged(
        { query },
        {
          sku,
          location_id: location,
          on_hand: 12,
          reserved: 2,
          blocked: 1,
          stock_version: 7,
          operationId: randomUUID(),
          correlationId: randomUUID(),
        },
      );
      const fact = rows[0];
      const messageId = fact.payload.message_id;
      let wire: ServiceBusMessage | undefined;
      const batch = {
        tryAddMessage: (m: ServiceBusMessage) => {
          wire = m;
          return true;
        },
      } as Awaited<
        ReturnType<
          import('@azure/service-bus').ServiceBusSender['createMessageBatch']
        >
      >;
      const claim = {
        token: randomUUID(),
        destination: INVENTORY_QUEUES.PROMOTIONS,
        row: { ...fact, id: randomUUID(), status: 'PENDING' as const },
      };
      const finished = vi.fn(async () => true);
      const relay = new InventoryServiceBusRelay(
        { claim: async () => claim, finish: finished },
        new Map([
          [
            claim.destination,
            {
              createMessageBatch: async () => batch,
              sendMessages: async () => undefined,
            },
          ],
        ]),
      );
      expect(await relay.publishOne()).toBe('sent');
      expect(finished).toHaveBeenCalledWith(claim, 'confirmed');
      expect(wire?.messageId).toBe(messageId);

      const inbox = async () =>
        (
          await pool.query(
            'SELECT completed_at, result FROM promotions.inbox WHERE message_id = $1',
            [messageId],
          )
        ).rows;
      let handler: Parameters<EventReceiver['subscribe']>[0] | undefined;
      const completeMessage = vi.fn(async () => {
        expect(await inbox()).toEqual([
          {
            completed_at: expect.any(Date),
            result: {
              handled: true,
              invalidation: {
                domain: 'stock',
                targetType: 'SKU',
                targetId: sku,
                locationId: location,
                sourceVersion: '7',
              },
            },
          },
        ]);
      });
      const abandonMessage = vi.fn(async () => undefined);
      const deadLetterMessage = vi.fn(async () => undefined);
      const createRuntime = () =>
        new PromotionsServiceBusEvents(
          {
            namespace: 'test-h5.servicebus.windows.net',
            eventsEnabled: true,
            eventQueues: [INVENTORY_QUEUES.PROMOTIONS],
          },
          new PromotionsAssignedEventDispatcher(
            pool,
            h4EventAdapters,
            assignedH4Contracts,
            true,
          ),
          () => ({
            receiver: (queue) => {
              expect(queue).toBe(claim.destination);
              return {
                subscribe: (handlers) => {
                  handler = handlers;
                  return { close: async () => undefined };
                },
                peekMessages: async () => [],
                completeMessage,
                abandonMessage,
                deadLetterMessage,
                close: async () => undefined,
              };
            },
            close: async () => undefined,
          }),
        );
      const first = createRuntime();
      let beforeReplay: Awaited<ReturnType<typeof inbox>>;
      try {
        await first.onApplicationBootstrap();
        completeMessage.mockRejectedValueOnce(new Error('LOCK_LOST'));
        await handler!.processMessage(wire as ServiceBusReceivedMessage);
        beforeReplay = await inbox();
        expect(beforeReplay).toMatchObject([
          {
            result: {
              handled: true,
              invalidation: {
                domain: 'stock',
                targetId: sku,
                sourceVersion: '7',
              },
            },
          },
        ]);
      } finally {
        await first.onModuleDestroy();
      }
      const restarted = createRuntime();
      try {
        await restarted.onApplicationBootstrap();
        await handler!.processMessage(wire as ServiceBusReceivedMessage);
        expect(await inbox()).toEqual(beforeReplay);
        expect(completeMessage).toHaveBeenCalledTimes(2);
        expect(abandonMessage).not.toHaveBeenCalled();
        expect(deadLetterMessage).not.toHaveBeenCalled();
      } finally {
        await restarted.onModuleDestroy();
      }
    });
  },
);
