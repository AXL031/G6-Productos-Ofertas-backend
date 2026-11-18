import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  ServiceBusMessage,
  ServiceBusMessageBatch,
  ServiceBusReceivedMessage,
} from '@azure/service-bus';
import {
  envelope,
  parseCatalogMessage,
} from '../../apps/catalog-svc/src/catalog-messages.js';
import { IsolatedPostgres } from '../../apps/pricing-svc/test/isolated-postgres.js';
import type { PricingConfig } from '../../apps/pricing-svc/src/config/environment.js';
import { PricingDatabase } from '../../apps/pricing-svc/src/persistence/pricing.database.js';
import { PricingRepository } from '../../apps/pricing-svc/src/persistence/pricing.repository.js';
import { PricingMutations } from '../../apps/pricing-svc/src/application/pricing-mutations.js';
import { createPricingPriceChangedFacts } from '../../apps/pricing-svc/src/messaging/pricing-fact.js';
import { PricingProductInitialization } from '../../apps/pricing-svc/src/messaging/pricing-initialization.js';
import { CatalogSkuDeactivated } from '../../apps/pricing-svc/src/messaging/catalog-sku-deactivated.js';
import { PricingCatalogServiceBusHandler } from '../../apps/pricing-svc/src/messaging/service-bus-catalog.js';
import { PricingServiceBusRelay } from '../../apps/pricing-svc/src/messaging/service-bus-relay.js';
import {
  AUDIT_PILOT_QUEUE,
  CATALOG_PRICING_QUEUE,
  PROMOTIONS_PRICE_QUEUE,
  PricingDeliveryStore,
} from '../../apps/pricing-svc/src/messaging/service-bus-deliveries.js';

describe.skipIf(process.env.G6_SERVICE_BUS_POSTGRES_TESTS !== '1')(
  'Pricing H5 initialization and price fan-out',
  () => {
    const pg = new IsolatedPostgres();
    let database: PricingDatabase;
    let mutations: PricingMutations;
    let pricing: PricingRepository;
    let initialization: PricingProductInitialization;

    beforeAll(async () => {
      await pg.start();
      for (const migration of [
        '0001_outbox_delivery.sql',
        '0002_price_changed_promotions.sql',
        '0003_catalog_initialization_results.sql',
      ]) {
        const ddl = await readFile(
          new URL(
            '../../apps/pricing-svc/migrations-candidate/h5/' + migration,
            import.meta.url,
          ),
          'utf8',
        );
        await pg.admin!.query(
          'BEGIN; SET LOCAL ROLE po_pricing_owner; ' + ddl + ' COMMIT;',
        );
      }
      const config: PricingConfig = {
        nodeEnv: 'test',
        port: 3002,
        securityMode: 'G7_AUTHENTICATED',
        publicOperations: [],
        databaseUrl: pg.runtimeUrl,
        databaseSsl: false,
        serviceBus: {
          namespace: 'test-h5.servicebus.windows.net',
          fanoutEnabled: true,
          catalogEnabled: true,
        },
        priceChangedPublishingEnabled: true,
      };
      database = new PricingDatabase(config);
      pricing = new PricingRepository(database);
      mutations = new PricingMutations(pricing, config);
      initialization = new PricingProductInitialization(pricing, config);
    }, 120_000);

    afterAll(async () => {
      try {
        await database?.onApplicationShutdown();
      } finally {
        await pg.stop();
      }
    });

    it('commits a single business fact with both deliveries and reconciles them independently', async () => {
      const productId = randomUUID();
      const correlationId = randomUUID();
      const now = new Date();
      await mutations.update(
        { productId },
        null,
        {
          precioRegular: '123.45',
          currency: 'PEN',
          motivoCambio: 'H5_TEST',
          usuarioId: null,
        },
        0n,
        now,
        (before, after) =>
          createPricingPriceChangedFacts(before, after, {
            actor: null,
            correlationId,
            at: now,
            operation: 'actualizarPrecioBaseProducto',
            productId,
          }),
      );
      const audit = new PricingDeliveryStore(pricing);
      const promotions = new PricingDeliveryStore(
        pricing,
        PROMOTIONS_PRICE_QUEUE,
      );
      const [a, p] = await Promise.all([audit.claim(), promotions.claim()]);
      expect(a).toBeDefined();
      expect(p).toBeDefined();
      expect(a!.destination).toBe(AUDIT_PILOT_QUEUE);
      expect(p!.destination).toBe(PROMOTIONS_PRICE_QUEUE);
      expect(a!.row.messageId).toBe(p!.row.messageId);
      expect(a!.row.correlationId).toBe(correlationId);
      expect(await promotions.finish(p!, false)).toBe(true);
      expect(await audit.finish(a!, true)).toBe(true);
      const rows = (
        await pg.admin!.query(
          'SELECT destination,sent_at,last_error FROM pricing.outbox_delivery WHERE message_id=$1 ORDER BY destination',
          [a!.row.messageId],
        )
      ).rows;
      expect(rows).toEqual([
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
    });

    it('commits one correlated R15 result after accepting and replaying R07', async () => {
      const product = randomUUID();
      const sku = 'H5-PRICE-R07';
      const command = envelope(
        'pricing.product.initialization.requested',
        {
          product_id: product,
          sku_base: sku,
          precio_regular: 25.3,
          moneda: 'PEN',
          channel_id: null,
          motivo_cambio: 'ALTA_PRODUCTO',
        },
        randomUUID(),
        randomUUID(),
      );
      const wire = {
        body: Buffer.from(JSON.stringify(command)),
        contentType: 'application/json',
        subject: command.name,
        messageId: command.message_id,
        correlationId: command.correlation_id,
      } as ServiceBusReceivedMessage;
      const receiver = {
        completeMessage: vi.fn(async () => undefined),
        deadLetterMessage: vi.fn(async () => undefined),
        abandonMessage: vi.fn(async () => undefined),
      };
      const handler = new PricingCatalogServiceBusHandler(
        initialization,
        new CatalogSkuDeactivated(pricing),
        receiver,
      );
      await handler.handle({ ...wire, correlationId: randomUUID() });
      expect(receiver.deadLetterMessage).toHaveBeenCalledOnce();
      await handler.handle(wire);
      await handler.handle(wire);
      expect(receiver.completeMessage).toHaveBeenCalledTimes(2);
      expect(receiver.abandonMessage).not.toHaveBeenCalled();
      const captured: ServiceBusMessage[] = [];
      const batch = {
        tryAddMessage: (message: ServiceBusMessage) => {
          captured.push(message);
          return true;
        },
      } as ServiceBusMessageBatch;
      const relay = new PricingServiceBusRelay(
        new PricingDeliveryStore(pricing, CATALOG_PRICING_QUEUE),
        {
          createMessageBatch: async () => batch,
          sendMessages: async () => undefined,
        },
        CATALOG_PRICING_QUEUE,
      );
      expect(await relay.publishOne()).toBe('sent');
      expect(await relay.publishOne()).toBe('empty');
      expect(captured).toHaveLength(1);
      const result = parseCatalogMessage(JSON.parse(String(captured[0].body)));
      expect(result).toMatchObject({
        name: 'pricing.product.initialization.completed',
        operation_id: command.operation_id,
        causation_id: command.message_id,
        correlation_id: command.correlation_id,
        data: { product_id: product, sku_base: sku, status: 'READY' },
      });
    });
  },
);
