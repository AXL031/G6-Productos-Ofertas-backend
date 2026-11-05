import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PricingDatabase } from '../src/persistence/pricing.database.js';
import {
  prices,
  priceValidities,
  scheduledPrices,
} from '../src/persistence/pricing.schema.js';
import { PricingRepository } from '../src/persistence/pricing.repository.js';
import { PricingProductInitialization } from '../src/messaging/pricing-initialization.js';
import { CatalogSkuDeactivated } from '../src/messaging/catalog-sku-deactivated.js';
import { PricingInboxConsumer } from '../src/messaging/inbox-consumer.js';
import { IsolatedPostgres } from './isolated-postgres.js';
import { IsolatedRabbitmq } from './isolated-rabbitmq.js';
import { setTimeout as delay } from 'node:timers/promises';

describe.skipIf(process.env.PRICING_TEST_AMQP !== '1')(
  'Pricing AMQP inbox contra PostgreSQL y RabbitMQ aislados',
  () => {
    const postgres = new IsolatedPostgres();
    const broker = new IsolatedRabbitmq();
    const config = {
      nodeEnv: 'test' as const,
      port: 3002,
      databaseUrl: '',
      databaseSsl: false,
      amqpUrl: '',
    };
    let database: PricingDatabase;
    let consumer: PricingInboxConsumer;
    let repository: PricingRepository;

    async function waitFor(check: () => Promise<boolean>, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await check()) return;
        await delay(50);
      }
      throw new Error('Se agotó el tiempo esperando disposición Inbox.');
    }

    async function send(exchange: string, route: string, message: unknown) {
      const accepted = broker.channel!.publish(
        exchange,
        route,
        Buffer.from(JSON.stringify(message)),
        { persistent: true, contentType: 'application/json' },
      );
      expect(accepted).toBe(true);
    }

    beforeAll(async () => {
      await postgres.start();
      await broker.start();
      config.databaseUrl = postgres.runtimeUrl;
      config.amqpUrl = broker.url;
      database = new PricingDatabase(config);
      repository = new PricingRepository(database);
      consumer = new PricingInboxConsumer(
        config,
        new PricingProductInitialization(repository),
        new CatalogSkuDeactivated(repository),
        repository,
      );
      consumer.onApplicationBootstrap();
      await waitFor(async () => consumer.available);
    }, 120000);

    afterAll(async () => {
      await consumer?.onApplicationShutdown();
      await database?.onApplicationShutdown();
      await broker.stop();
      await postgres.stop();
    }, 30000);

    it('recibe comando, confirma solo tras commit y reproduce el mismo resultado durable', async () => {
      const productId = randomUUID();
      const operationId = randomUUID();
      const messageId = randomUUID();
      const command = {
        message_id: messageId,
        schema_version: 1,
        occurred_at: new Date().toISOString(),
        correlation_id: randomUUID(),
        causation_id: null,
        operation_id: operationId,
        producer: 'catalog-svc',
        kind: 'command',
        name: 'pricing.product.initialization.requested',
        data: {
          product_id: productId,
          sku_base: 'BASE-' + productId,
          precio_regular: 49.95,
          moneda: 'PEN',
          channel_id: null,
          motivo_cambio: 'ALTA_PRODUCTO',
        },
      };
      await send(
        'po.comandos.x',
        'pricing.product.initialization.requested',
        command,
      );
      await waitFor(async () => {
        const found = await postgres.admin!.query(
          `SELECT count(*)::int AS count FROM pricing.inbox WHERE message_id=$1 AND handler='pricing.product.initialization.v1'`,
          [messageId],
        );
        return found.rows[0].count === 1;
      });
      await send(
        'po.comandos.x',
        'pricing.product.initialization.requested',
        command,
      );
      await delay(200);
      const counts = await postgres.admin!.query(
        `SELECT (SELECT count(*)::int FROM pricing.prices WHERE product_id=$1 AND sku IS NULL) AS prices,
                (SELECT count(*)::int FROM pricing.outbox WHERE operation_id=$2) AS outbox,
                (SELECT count(*)::int FROM pricing.inbox WHERE message_id=$3 AND handler='pricing.product.initialization.v1') AS inbox`,
        [productId, operationId, messageId],
      );
      expect(counts.rows[0]).toEqual({ prices: 1, outbox: 2, inbox: 1 });
      const result = await postgres.admin!.query(
        `SELECT event_name, kind, payload FROM pricing.outbox WHERE operation_id=$1 AND kind='result'`,
        [operationId],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        event_name: 'pricing.product.initialization.completed',
        kind: 'result',
        payload: { product_id: productId, status: 'READY', price_version: 1 },
      });
    });

    it('rechaza de forma durable un envelope inválido pero identificable antes del ACK', async () => {
      const messageId = randomUUID();
      const command = {
        message_id: messageId,
        schema_version: 99,
        occurred_at: new Date().toISOString(),
        correlation_id: randomUUID(),
        operation_id: randomUUID(),
        producer: 'catalog-svc',
        kind: 'command',
        name: 'pricing.product.initialization.requested',
        data: {},
      };
      await send(
        'po.comandos.x',
        'pricing.product.initialization.requested',
        command,
      );
      await waitFor(async () => {
        const found = await postgres.admin!.query(
          `SELECT result FROM pricing.inbox WHERE message_id=$1 AND handler='pricing.product.initialization.v1'`,
          [messageId],
        );
        return found.rows[0]?.result === 'REJECTED_INVALID_ENVELOPE';
      });
      expect(consumer.available).toBe(true);
    });

    it('recibe baja SKU, cancela solo su programación futura y persiste una única disposición', async () => {
      const productId = randomUUID();
      const sku = 'AMQP-SKU-' + randomUUID();
      const now = new Date('2034-01-01T00:00:00Z');
      const validFrom = new Date('2035-01-01T00:00:00Z');
      const { definition, validity } = await repository.transaction(
        async (tx) => {
          const [definition] = await tx
            .insert(prices)
            .values({ sku, productId: null, channelId: null })
            .returning();
          const [validity] = await tx
            .insert(priceValidities)
            .values({
              priceId: definition.id,
              precioRegular: '19.90',
              precioOferta: null,
              currency: 'PEN',
              validFrom,
              validUntil: null,
              priceVersion: 1n,
              motivoCambio: 'FUTURA',
              usuarioId: null,
            })
            .returning();
          return { definition, validity };
        },
      );
      const [schedule] = await database.db
        .insert(scheduledPrices)
        .values({
          priceId: definition.id,
          validityId: validity.id,
          productId,
          correlationId: randomUUID(),
          tipoPrecio: 'REGULAR',
          importe: '19.90',
        })
        .returning();
      const messageId = randomUUID();
      const event = {
        message_id: messageId,
        schema_version: 1,
        occurred_at: now.toISOString(),
        correlation_id: randomUUID(),
        causation_id: null,
        operation_id: randomUUID(),
        producer: 'catalog-svc',
        kind: 'event',
        name: 'catalog.sku.deactivated',
        data: {
          sku,
          product_id: productId,
          sku_version: 1,
          changed_at: now.toISOString(),
        },
      };
      await send('po.eventos.x', 'catalog.sku.deactivated', event);
      await waitFor(async () => {
        const row = await postgres.admin!.query(
          `SELECT status FROM pricing.scheduled_prices WHERE id=$1`,
          [schedule.id],
        );
        return row.rows[0]?.status === 'CANCELLED';
      });
      const persisted = await postgres.admin!.query(
        `SELECT s.status, v.is_cancelled, (SELECT count(*)::int FROM pricing.inbox WHERE message_id=$1 AND handler='pricing.catalog-sku-deactivated.v1') AS accepted
         FROM pricing.scheduled_prices s JOIN pricing.price_validities v ON v.id=s.validity_id WHERE s.id=$2`,
        [messageId, schedule.id],
      );
      expect(persisted.rows[0]).toEqual({
        status: 'CANCELLED',
        is_cancelled: true,
        accepted: 1,
      });
    });

    it('registra y confirma Bulk como BLOQUEADO_CONTRATO sin inventar resultado', async () => {
      const messageId = randomUUID();
      const command = {
        message_id: messageId,
        schema_version: 1,
        occurred_at: new Date().toISOString(),
        correlation_id: randomUUID(),
        causation_id: null,
        operation_id: randomUUID(),
        producer: 'bulk-svc',
        kind: 'command',
        name: 'pricing.bulk.price.apply.requested',
        data: {},
      };
      await send(
        'po.comandos.x',
        'pricing.bulk.price.apply.requested',
        command,
      );
      await waitFor(async () => {
        const found = await postgres.admin!.query(
          `SELECT result FROM pricing.inbox WHERE message_id=$1 AND handler='pricing.bulk.price.apply.v1'`,
          [messageId],
        );
        return found.rows[0]?.result === 'BLOCKED_CONTRACT';
      });
      const fakeResults = await postgres.admin!.query(
        `SELECT count(*)::int AS count FROM pricing.outbox WHERE operation_id=$1`,
        [command.operation_id],
      );
      expect(fakeResults.rows[0].count).toBe(0);
    });
  },
);
