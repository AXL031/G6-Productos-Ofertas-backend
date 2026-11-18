import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { IsolatedPostgres } from '../../apps/pricing-svc/test/isolated-postgres.js';
import type { PricingConfig } from '../../apps/pricing-svc/src/config/environment.js';
import { PricingDatabase } from '../../apps/pricing-svc/src/persistence/pricing.database.js';
import { PricingRepository } from '../../apps/pricing-svc/src/persistence/pricing.repository.js';
import { PricingMutations } from '../../apps/pricing-svc/src/application/pricing-mutations.js';
import { createPricingPriceChangedFacts } from '../../apps/pricing-svc/src/messaging/pricing-fact.js';
import {
  AUDIT_PILOT_QUEUE,
  PROMOTIONS_PRICE_QUEUE,
  PricingDeliveryStore,
} from '../../apps/pricing-svc/src/messaging/service-bus-deliveries.js';

describe.skipIf(process.env.G6_SERVICE_BUS_POSTGRES_TESTS !== '1')(
  'Pricing H5 R16 and R17 durable fan-out',
  () => {
    const pg = new IsolatedPostgres();
    let database: PricingDatabase;
    let mutations: PricingMutations;
    let pricing: PricingRepository;

    beforeAll(async () => {
      await pg.start();
      for (const migration of [
        '0001_outbox_delivery.sql',
        '0002_price_changed_promotions.sql',
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
        },
        priceChangedPublishingEnabled: true,
      };
      database = new PricingDatabase(config);
      pricing = new PricingRepository(database);
      mutations = new PricingMutations(pricing, config);
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
  },
);
