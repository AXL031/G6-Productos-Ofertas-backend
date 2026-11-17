import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  ServiceBusMessage,
  ServiceBusMessageBatch,
  ServiceBusReceivedMessage,
} from '@azure/service-bus';
import { IsolatedPostgres } from '../../../apps/pricing-svc/test/isolated-postgres.js';
import { IsolatedAuditPostgres } from '../../../apps/price-audit-svc/test/isolated-postgres.js';
import { PricingDatabase } from '../../../apps/pricing-svc/src/persistence/pricing.database.js';
import { PricingRepository } from '../../../apps/pricing-svc/src/persistence/pricing.repository.js';
import { PricingMutations } from '../../../apps/pricing-svc/src/application/pricing-mutations.js';
import { createPricingPriceChangedFacts } from '../../../apps/pricing-svc/src/messaging/pricing-fact.js';
import { PricingDeliveryStore } from '../../../apps/pricing-svc/src/messaging/service-bus-deliveries.js';
import { PricingServiceBusRelay } from '../../../apps/pricing-svc/src/messaging/service-bus-relay.js';
import { AuditDatabase } from '../../../apps/price-audit-svc/src/persistence/audit.database.js';
import { AuditRepository } from '../../../apps/price-audit-svc/src/persistence/audit.repository.js';
import { AuditServiceBusHandler } from '../../../apps/price-audit-svc/src/messaging/service-bus-consumer.js';
import type { PricingConfig } from '../../../apps/pricing-svc/src/config/environment.js';

// Integration orchestration lives outside apps: no runtime service imports another service.
// SQL is real and disposable. The sender/settlement here are explicit test doubles, NOT Azure evidence.
describe.skipIf(process.env.G6_SERVICE_BUS_POSTGRES_TESTS !== '1')(
  'H5 pilot: real PostgreSQL, explicit broker double',
  () => {
    const pricing = new IsolatedPostgres(),
      audit = new IsolatedAuditPostgres();
    let pricingDb: PricingDatabase,
      auditDb: AuditDatabase,
      store: PricingDeliveryStore;
    let mutations: PricingMutations, repository: AuditRepository;

    beforeAll(async () => {
      await pricing.start();
      await audit.start();
      const ddl = await readFile(
        new URL(
          '../../../apps/pricing-svc/migrations-candidate/h5/0001_outbox_delivery.sql',
          import.meta.url,
        ),
        'utf8',
      );
      await pricing.admin!.query(
        `BEGIN; SET LOCAL ROLE po_pricing_owner; ${ddl} COMMIT;`,
      );
      const config: PricingConfig = {
        nodeEnv: 'test',
        port: 3002,
        securityMode: 'G7_AUTHENTICATED',
        publicOperations: [],
        databaseUrl: pricing.runtimeUrl,
        databaseSsl: false,
        serviceBus: { namespace: 'g6-pilot-test.servicebus.windows.net' },
        priceChangedPublishingEnabled: true,
      };
      pricingDb = new PricingDatabase(config);
      const pricingRepository = new PricingRepository(pricingDb);
      mutations = new PricingMutations(pricingRepository, config);
      store = new PricingDeliveryStore(pricingRepository);
      auditDb = new AuditDatabase({
        nodeEnv: 'test',
        port: 3003,
        securityMode: 'G7_AUTHENTICATED',
        hotRetentionMonths: 24,
        archiveRetentionYears: 5,
        databaseUrl: audit.runtimeUrl,
        databaseSsl: false,
      });
      repository = new AuditRepository(auditDb);
    }, 120_000);

    afterEach(async () => {
      // Only this test's disposable database; keep cases independent without touching shared infrastructure.
      await pricing.admin?.query(
        'UPDATE pricing.outbox_delivery SET sent_at=now(),lease_token=NULL,lease_until=NULL,last_error=NULL',
      );
    });
    afterAll(async () => {
      await Promise.allSettled([
        pricingDb?.onApplicationShutdown(),
        auditDb?.onApplicationShutdown(),
      ]);
      await Promise.allSettled([pricing.stop(), audit.stop()]);
    });

    async function create(productId = randomUUID()) {
      const now = new Date(),
        correlationId = randomUUID();
      await mutations.update(
        { productId },
        null,
        {
          precioRegular: '123.45',
          currency: 'PEN',
          motivoCambio: 'H5_PILOT',
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
      const row = (
        await pricing.admin!.query<{ message_id: string }>(
          "SELECT message_id FROM pricing.outbox WHERE payload->>'product_id'=$1",
          [productId],
        )
      ).rows[0];
      return row.message_id;
    }
    async function delivery(id: string) {
      return (
        await pricing.admin!.query(
          'SELECT * FROM pricing.outbox_delivery WHERE message_id=$1',
          [id],
        )
      ).rows[0];
    }
    function transport() {
      const messages: ServiceBusMessage[] = [];
      let current: ServiceBusMessage | undefined;
      const sender = {
        createMessageBatch: async (): Promise<ServiceBusMessageBatch> => ({
          count: 1,
          sizeInBytes: 1000,
          maxSizeInBytes: 256 * 1024,
          tryAddMessage: (message) => {
            current = message as ServiceBusMessage;
            return true;
          },
          _generateMessage: () => Buffer.alloc(0),
          _messageSpanContexts: [],
        }),
        sendMessages: vi.fn(async () => {
          if (!current) throw new Error('empty batch');
          messages.push(current);
        }),
      };
      const receiver = {
        completeMessage: vi.fn(async () => undefined),
        abandonMessage: vi.fn(async () => undefined),
        deadLetterMessage: vi.fn(async () => undefined),
      };
      return {
        messages,
        sender,
        receiver,
        relay: new PricingServiceBusRelay(store, sender),
        handler: new AuditServiceBusHandler(repository, receiver),
        received: (index = 0): ServiceBusReceivedMessage => ({
          ...messages[index],
          state: 'active',
          _rawAmqpMessage: {},
        }),
      };
    }

    it('commits a real business change with its Outbox and delivery; confirms per destination without publishing H4', async () => {
      const id = await create(),
        f = transport();
      expect((await delivery(id)).sent_at).toBeNull();
      expect(await f.relay.publishOne()).toBe('sent');
      expect((await delivery(id)).sent_at).not.toBeNull();
      expect(
        (
          await pricing.admin!.query(
            'SELECT published_at FROM pricing.outbox WHERE message_id=$1',
            [id],
          )
        ).rows[0].published_at,
      ).toBeNull();
      f.receiver.completeMessage.mockImplementationOnce(async () => {
        const committed = await audit.admin!.query(
          'SELECT count(*)::int AS count FROM price_audit.inbox WHERE message_id=$1',
          [id],
        );
        expect(committed.rows[0].count).toBe(1);
      });
      expect(await f.handler.handle(f.received())).toBe('completed');
      expect(await f.handler.handle(f.received())).toBe('completed');
      const records = await audit.admin!.query(
        'SELECT count(*)::int AS count FROM price_audit.price_audit_log a JOIN price_audit.inbox i ON a.inbox_id=i.id WHERE i.message_id=$1',
        [id],
      );
      expect(records.rows[0].count).toBe(1);
    });
    it('rolls back business and Outbox when delivery cannot be persisted', async () => {
      const productId = randomUUID();
      await pricing.admin!.query(
        'REVOKE INSERT ON pricing.outbox_delivery FROM pricing_app',
      );
      try {
        await expect(create(productId)).rejects.toThrow();
        expect(
          (
            await pricing.admin!.query(
              'SELECT count(*)::int AS count FROM pricing.prices WHERE product_id=$1',
              [productId],
            )
          ).rows[0].count,
        ).toBe(0);
        expect(
          (
            await pricing.admin!.query(
              "SELECT count(*)::int AS count FROM pricing.outbox WHERE payload->>'product_id'=$1",
              [productId],
            )
          ).rows[0].count,
        ).toBe(0);
      } finally {
        await pricing.admin!.query(
          'GRANT INSERT ON pricing.outbox_delivery TO pricing_app',
        );
      }
    });
    it('keeps an ambiguous send pending and retries the original ID without duplicate audit', async () => {
      const id = await create(),
        f = transport();
      f.sender.sendMessages.mockImplementationOnce(async () => {
        // An accepted message whose acknowledgement was lost.
        const claimed = (
          await pricing.admin!.query(
            'SELECT o.* FROM pricing.outbox o WHERE message_id=$1',
            [id],
          )
        ).rows[0];
        f.messages.push({
          body: JSON.stringify({
            message_id: id,
            correlation_id: claimed.correlation_id,
            operation_id: claimed.operation_id,
            causation_id: null,
            name: claimed.event_name,
            schema_version: 1,
            producer: 'pricing-svc',
            kind: 'event',
            occurred_at: claimed.occurred_at.toISOString(),
            data: claimed.payload,
          }),
          messageId: id,
          correlationId: claimed.correlation_id,
          contentType: 'application/json',
          subject: 'pricing.price.changed',
          applicationProperties: {
            producer: 'pricing-svc',
            schema_version: 1,
            route_version: 1,
          },
        });
        throw new Error('acceptance confirmation lost');
      });
      expect(await f.relay.publishOne()).toBe('pending');
      expect((await delivery(id)).last_error).toBe('SEND_NOT_CONFIRMED');
      await f.handler.handle(f.received());
      await pricing.admin!.query(
        "UPDATE pricing.outbox_delivery SET next_attempt_at=now()-interval '1 second' WHERE message_id=$1",
        [id],
      );
      expect(await f.relay.publishOne()).toBe('sent');
      expect(f.messages.map((message) => message.messageId)).toEqual([id, id]);
      await f.handler.handle(f.received(1));
      expect(
        (
          await audit.admin!.query(
            'SELECT count(*)::int AS count FROM price_audit.inbox WHERE message_id=$1',
            [id],
          )
        ).rows[0].count,
      ).toBe(1);
    });
    it('recovers a crash after audit commit but before settlement', async () => {
      const id = await create(),
        f = transport();
      await f.relay.publishOne();
      f.receiver.completeMessage.mockRejectedValueOnce(
        new Error('lock lost after commit'),
      );
      await expect(f.handler.handle(f.received())).rejects.toThrow();
      await f.handler.handle(f.received());
      expect(
        (
          await audit.admin!.query(
            'SELECT count(*)::int AS count FROM price_audit.price_audit_log a JOIN price_audit.inbox i ON i.id=a.inbox_id WHERE i.message_id=$1',
            [id],
          )
        ).rows[0].count,
      ).toBe(1);
    });
    it('rejects reuse of a message ID with different content without changing the original audit', async () => {
      const id = await create(),
        f = transport();
      await f.relay.publishOne();
      await f.handler.handle(f.received());
      const changed = f.received();
      const payload = JSON.parse(String(changed.body));
      payload.data.new_price = '123.46';
      changed.body = JSON.stringify(payload);
      expect(await f.handler.handle(changed)).toBe('dead-lettered');
      expect(f.receiver.completeMessage).toHaveBeenCalledTimes(1);
      expect(f.receiver.deadLetterMessage).toHaveBeenCalledTimes(1);
      const rows = (
        await audit.admin!.query(
          'SELECT a.precio_nuevo FROM price_audit.price_audit_log a JOIN price_audit.inbox i ON i.id=a.inbox_id WHERE i.message_id=$1',
          [id],
        )
      ).rows;
      expect(rows).toHaveLength(1);
      expect(String(rows[0].precio_nuevo)).toBe('123.45');
    });
    it('lets only one concurrent relay claim an available delivery', async () => {
      await create();
      const claims = await Promise.all([store.claim(), store.claim()]);
      expect(claims.filter(Boolean)).toHaveLength(1);
    });
    it('recovers expired claims and fences out the previous worker', async () => {
      const id = await create();
      const first = (await store.claim())!;
      await pricing.admin!.query(
        "UPDATE pricing.outbox_delivery SET lease_until=now()-interval '1 second' WHERE message_id=$1",
        [id],
      );
      const second = (await store.claim())!;
      expect(second.token).not.toBe(first.token);
      expect(await store.finish(first, true)).toBe(false);
      expect(await store.finish(second, true)).toBe(true);
      expect((await delivery(id)).attempts).toBe(2);
    });
    it('does not keep a SQL row lock while awaiting broker IO', async () => {
      const id = await create(),
        f = transport();
      f.sender.sendMessages.mockImplementationOnce(async () => {
        const client = await pricing.admin!.connect();
        try {
          await client.query('BEGIN');
          await client.query("SET LOCAL lock_timeout='100ms'");
          await client.query(
            "UPDATE pricing.outbox_delivery SET last_error='TEST_IO_PROBE' WHERE message_id=$1",
            [id],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      });
      expect(await f.relay.publishOne()).toBe('sent');
    });
  },
);
