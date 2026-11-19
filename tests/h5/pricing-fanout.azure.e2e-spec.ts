import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ManagedIdentityCredential } from '@azure/identity';
import { ServiceBusClient } from '@azure/service-bus';
import { Pool } from 'pg';
import { AuditDatabase } from '../../apps/price-audit-svc/src/persistence/audit.database.js';
import { AuditRepository } from '../../apps/price-audit-svc/src/persistence/audit.repository.js';
import { AuditServiceBusHandler } from '../../apps/price-audit-svc/src/messaging/service-bus-consumer.js';
import { PricingMutations } from '../../apps/pricing-svc/src/application/pricing-mutations.js';
import type { PricingConfig } from '../../apps/pricing-svc/src/config/environment.js';
import { createPricingPriceChangedFacts } from '../../apps/pricing-svc/src/messaging/pricing-fact.js';
import {
  AUDIT_PILOT_QUEUE,
  PROMOTIONS_PRICE_QUEUE,
  PricingDeliveryStore,
} from '../../apps/pricing-svc/src/messaging/service-bus-deliveries.js';
import { PricingServiceBusRelay } from '../../apps/pricing-svc/src/messaging/service-bus-relay.js';
import { PricingDatabase } from '../../apps/pricing-svc/src/persistence/pricing.database.js';
import { PricingRepository } from '../../apps/pricing-svc/src/persistence/pricing.repository.js';
import { PromotionsAssignedEventDispatcher } from '../../apps/promotions-svc/src/coupons/assigned-event-dispatcher.js';
import { assignedH4Contracts } from '../../apps/promotions-svc/src/coupons/assigned-h4-contract.generated.js';
import { h4EventAdapters } from '../../apps/promotions-svc/src/coupons/h4-event-adapters.js';
import {
  nativePromotionsEventBus,
  PromotionsServiceBusEvents,
} from '../../apps/promotions-svc/src/coupons/service-bus-events.js';
import { prepareInitializationDatabases } from './initialization-lab-postgres.js';

describe.skipIf(!process.env.G6_H5_FANOUT_PG_URL)('Pricing H5 fan-out', () => {
  let lab: Awaited<ReturnType<typeof prepareInitializationDatabases>>;
  let databases: Awaited<ReturnType<typeof lab.preparePriceConsumers>>;

  beforeAll(async () => {
    lab = await prepareInitializationDatabases(
      process.env.G6_H5_FANOUT_PG_URL!,
    );
    databases = await lab.preparePriceConsumers();
  }, 75_000);
  afterAll(async () => lab?.close());

  it('creates independent Price Audit and Promotions persistence', async () => {
    const audit = await databases.audit.pool.query(
      "SELECT to_regclass('price_audit.price_audit_log')::text AS relation",
    );
    const promotions = await databases.promotions.pool.query(
      "SELECT to_regclass('promotions.inbox')::text AS relation",
    );
    expect(audit.rows).toEqual([{ relation: 'price_audit.price_audit_log' }]);
    expect(promotions.rows).toEqual([{ relation: 'promotions.inbox' }]);
  });

  it.skipIf(process.env.G6_H5_FANOUT_REAL_AZURE !== '1')(
    'R16/R17 reconcile independent deliveries and both Inbox records over Azure Service Bus',
    async () => {
      const namespace = process.env.G6_H5_LAB_NAMESPACE_FQDN ?? '';
      const ids = ['PRICING', 'PRICE_AUDIT', 'PROMOTIONS'].map(
        (name) => process.env[`G6_H5_LAB_${name}_CLIENT_ID`] ?? '',
      );
      if (
        !/^g6-sb-h5-int-[a-z0-9]{13}\.servicebus\.windows\.net$/.test(
          namespace,
        ) ||
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
      const pricingBus = client(ids[0]);
      const auditBus = client(ids[1]);
      const auditReceiver = auditBus.createReceiver(AUDIT_PILOT_QUEUE, {
        receiveMode: 'peekLock',
        skipParsingBodyAsJson: true,
      });
      const config: PricingConfig = {
        nodeEnv: 'test',
        port: 3002,
        securityMode: 'G7_AUTHENTICATED',
        publicOperations: [],
        databaseUrl: lab.pricing.runtimeUrl.href,
        databaseSsl: false,
        serviceBus: { namespace, fanoutEnabled: true },
        priceChangedPublishingEnabled: true,
      };
      const pricingDb = new PricingDatabase(config);
      const pricing = new PricingRepository(pricingDb);
      const mutations = new PricingMutations(pricing, config);
      const auditDb = new AuditDatabase({
        nodeEnv: 'test',
        port: 3003,
        securityMode: 'G7_AUTHENTICATED',
        hotRetentionMonths: 24,
        archiveRetentionYears: 5,
        databaseUrl: databases.audit.runtimeUrl.href,
        databaseSsl: false,
      });
      const audit = new AuditRepository(auditDb);
      const promotionsPool = new Pool({
        connectionString: databases.promotions.runtimeUrl.href,
        connectionTimeoutMillis: 2000,
      });
      const promotionSettlements: { id: string; count: number }[] = [];
      const promotions = new PromotionsServiceBusEvents(
        {
          namespace,
          eventsEnabled: true,
          eventQueues: [PROMOTIONS_PRICE_QUEUE],
          managedIdentityClientId: ids[2],
        },
        new PromotionsAssignedEventDispatcher(
          promotionsPool,
          h4EventAdapters,
          assignedH4Contracts,
          true,
        ),
        (options) => {
          const bus = nativePromotionsEventBus(options);
          return {
            close: () => bus.close(),
            receiver: (queue) => {
              const receiver = bus.receiver(queue);
              return {
                peekMessages: receiver.peekMessages.bind(receiver),
                subscribe: receiver.subscribe.bind(receiver),
                abandonMessage: receiver.abandonMessage.bind(receiver),
                deadLetterMessage: receiver.deadLetterMessage.bind(receiver),
                close: receiver.close.bind(receiver),
                completeMessage: async (message) => {
                  if (!promotionSettlements.length)
                    await receiver.abandonMessage(message);
                  else await receiver.completeMessage(message);
                  promotionSettlements.push({
                    id: String(message.messageId),
                    count: message.deliveryCount,
                  });
                },
              };
            },
          };
        },
      );
      const auditRelay = new PricingServiceBusRelay(
        new PricingDeliveryStore(pricing),
        pricingBus.createSender(AUDIT_PILOT_QUEUE),
      );
      const promotionsSender = pricingBus.createSender(PROMOTIONS_PRICE_QUEUE);
      const promotionsStore = new PricingDeliveryStore(
        pricing,
        PROMOTIONS_PRICE_QUEUE,
      );
      const promotionsRelay = new PricingServiceBusRelay(
        promotionsStore,
        promotionsSender,
        PROMOTIONS_PRICE_QUEUE,
      );
      const interruptedPromotionsRelay = new PricingServiceBusRelay(
        promotionsStore,
        {
          createMessageBatch:
            promotionsSender.createMessageBatch.bind(promotionsSender),
          sendMessages: async () => {
            throw new Error('LAB_PROMOTIONS_SEND_INTERRUPTED');
          },
        },
        PROMOTIONS_PRICE_QUEUE,
      );

      try {
        await promotions.onApplicationBootstrap();
        const productId = randomUUID();
        const correlationId = randomUUID();
        const at = new Date();
        await mutations.update(
          { productId },
          null,
          {
            precioRegular: '123.45',
            currency: 'PEN',
            motivoCambio: 'H5_LAB',
            usuarioId: null,
          },
          0n,
          at,
          (before, after) =>
            createPricingPriceChangedFacts(before, after, {
              actor: null,
              correlationId,
              at,
              operation: 'actualizarPrecioBaseProducto',
              productId,
            }),
        );
        const fact = await lab.pricing.pool.query(
          "SELECT message_id FROM pricing.outbox WHERE correlation_id=$1 AND event_name='pricing.price.changed'",
          [correlationId],
        );
        expect(fact.rowCount).toBe(1);
        const id = fact.rows[0].message_id;
        const deliveries = () =>
          lab.pricing.pool.query(
            'SELECT destination, sent_at, last_error FROM pricing.outbox_delivery WHERE message_id=$1 ORDER BY destination',
            [id],
          );
        expect((await deliveries()).rows).toEqual([
          { destination: AUDIT_PILOT_QUEUE, sent_at: null, last_error: null },
          {
            destination: PROMOTIONS_PRICE_QUEUE,
            sent_at: null,
            last_error: null,
          },
        ]);
        expect(await interruptedPromotionsRelay.publishOne()).toBe('pending');
        expect(await auditRelay.publishOne()).toBe('sent');
        expect((await deliveries()).rows).toEqual([
          {
            destination: AUDIT_PILOT_QUEUE,
            sent_at: expect.any(Date),
            last_error: null,
          },
          {
            destination: PROMOTIONS_PRICE_QUEUE,
            sent_at: null,
            last_error: 'SEND_NOT_CONFIRMED',
          },
        ]);
        const readAudit = async () => {
          const [message] = await auditReceiver.receiveMessages(1, {
            maxWaitTimeInMs: 12_000,
            abortSignal: AbortSignal.timeout(15_000),
          });
          expect(message?.messageId).toBe(id);
          expect(message?.correlationId).toBe(correlationId);
          return message;
        };
        const first = await readAudit();
        const auditRows = () =>
          databases.audit.pool.query(
            `SELECT i.message_id, a.product_id, a.precio_nuevo::text AS price
             FROM price_audit.inbox i JOIN price_audit.price_audit_log a ON i.id=a.inbox_id
            WHERE i.message_id=$1`,
            [id],
          );
        const committed = new AuditServiceBusHandler(audit, {
          completeMessage: async (message) => {
            expect((await auditRows()).rows).toEqual([
              { message_id: id, product_id: productId, price: '123.45' },
            ]);
            await auditReceiver.abandonMessage(message);
          },
          abandonMessage: auditReceiver.abandonMessage.bind(auditReceiver),
          deadLetterMessage:
            auditReceiver.deadLetterMessage.bind(auditReceiver),
        });
        expect(await committed.handle(first)).toBe('completed');
        const replay = await readAudit();
        expect(replay.deliveryCount).toBeGreaterThan(first.deliveryCount);
        expect(
          await new AuditServiceBusHandler(audit, auditReceiver).handle(replay),
        ).toBe('completed');
        expect((await auditRows()).rowCount).toBe(1);

        // Advance only this fixture's retry clock. The publisher does not mutate the fact.
        const expedited = await lab.pricing.pool.query(
          'UPDATE pricing.outbox_delivery SET next_attempt_at=clock_timestamp() WHERE message_id=$1 AND destination=$2 AND sent_at IS NULL',
          [id, PROMOTIONS_PRICE_QUEUE],
        );
        expect(expedited.rowCount).toBe(1);
        expect(await promotionsRelay.publishOne()).toBe('sent');
        const deadline = Date.now() + 20_000;
        while (promotionSettlements.length < 2 && Date.now() < deadline)
          await delay(150);
        expect(promotionSettlements.map((message) => message.id)).toEqual([
          id,
          id,
        ]);
        expect(promotionSettlements[1].count).toBeGreaterThan(
          promotionSettlements[0].count,
        );
        const outcome = await databases.promotions.pool.query(
          'SELECT result FROM promotions.inbox WHERE message_id=$1 AND completed_at IS NOT NULL',
          [id],
        );
        expect(outcome.rows).toEqual([
          {
            result: {
              handled: true,
              invalidation: {
                domain: 'price',
                targetType: 'PRODUCTO',
                targetId: productId,
                channelId: null,
                sourceVersion: '1',
              },
            },
          },
        ]);
        expect((await deliveries()).rows).toEqual([
          {
            destination: AUDIT_PILOT_QUEUE,
            sent_at: expect.any(Date),
            last_error: null,
          },
          {
            destination: PROMOTIONS_PRICE_QUEUE,
            sent_at: expect.any(Date),
            last_error: null,
          },
        ]);
      } finally {
        await Promise.allSettled([
          promotions.onModuleDestroy(),
          pricingBus.close(),
          auditBus.close(),
          promotionsPool.end(),
          pricingDb.onApplicationShutdown(),
          auditDb.onApplicationShutdown(),
        ]);
      }
    },
    110_000,
  );
});
