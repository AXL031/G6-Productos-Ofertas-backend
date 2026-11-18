import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type {
  ServiceBusMessage,
  ServiceBusMessageBatch,
  ServiceBusReceivedMessage,
} from '@azure/service-bus';
import type { Database } from '../../apps/taxonomy-svc/src/database.js';
import type { DeactivationIntentService } from '../../apps/taxonomy-svc/src/domain/deactivation-intent.service.js';
import { TaxonomyMessageStore } from '../../apps/taxonomy-svc/src/persistence/taxonomy-message.store.js';
import {
  publishTaxonomyDelivery,
  receiveTaxonomyDelivery,
} from '../../apps/taxonomy-svc/src/domain/taxonomy-service-bus.runtime.js';

describe.skipIf(process.env.PROMOTIONS_H5_POSTGRES_TESTS !== '1')(
  'Taxonomy H5 storage and relay with PostgreSQL',
  () => {
    let admin: Pool;
    let runtime: Pool;
    let store: TaxonomyMessageStore;
    beforeAll(async () => {
      const url = new URL(process.env.PROMOTIONS_H5_TEST_DATABASE_URL ?? '');
      if (
        url.hostname !== '127.0.0.1' ||
        !/^\/g6_promotions_h5_test_[a-z0-9]+$/.test(url.pathname)
      )
        throw new Error('DISPOSABLE_LOCAL_DATABASE_REQUIRED');
      admin = new Pool({ connectionString: url.href });
      const existing = await admin.query(
        "SELECT to_regnamespace('taxonomy') AS schema",
      );
      if (existing.rows[0].schema !== null)
        throw new Error('EMPTY_DATABASE_REQUIRED');
      const password = randomUUID();
      await admin.query(
        "CREATE ROLE po_taxonomy_owner NOLOGIN; CREATE ROLE taxonomy_app LOGIN PASSWORD '" +
          password +
          "'; CREATE SCHEMA taxonomy AUTHORIZATION po_taxonomy_owner",
      );
      const src = await fetch(
        'https://raw.githubusercontent.com/Taller-SW-Web/G6-Productos-Ofertas-docs/df0b09c651fab7f8fcdc693211109573f5e39a12/datos/taxonomy/migrations/0001_create_taxonomy.sql',
        { signal: AbortSignal.timeout(15000) },
      );
      if (!src.ok) throw new Error('BLOCKED_CONTRACT');
      await admin.query(
        'BEGIN; SET LOCAL ROLE po_taxonomy_owner; ' +
          (await src.text()) +
          ' COMMIT;',
      );
      const candidate = await readFile(
        'apps/taxonomy-svc/migrations-candidate/h5/0001_outbox_delivery.sql',
        'utf8',
      );
      await admin.query(
        'BEGIN; SET LOCAL ROLE po_taxonomy_owner; ' + candidate + ' COMMIT;',
      );
      url.username = 'taxonomy_app';
      url.password = password;
      runtime = new Pool({
        connectionString: url.href,
        options: '-c g6.taxonomy_messaging=AZURE_SERVICE_BUS',
      });
      const pg = drizzle(runtime);
      const database = {
        read: <T>(fn: (db: NodePgDatabase) => Promise<T>) => fn(pg),
      };
      store = new TaxonomyMessageStore(
        database as Database,
        {} as DeactivationIntentService,
      );
      await store.verifyServiceBusStorage();
    }, 30_000);

    afterAll(async () => {
      await Promise.allSettled([runtime?.end(), admin?.end()]);
    });

    const insert = (
      db: Pick<Pool, 'query'>,
      name = 'taxonomy.category.updated',
    ) => {
      const messageId = randomUUID();
      const correlation = randomUUID();
      const payload = {
        message_id: messageId,
        correlation_id: correlation,
        schema_version: 1,
        occurred_at: new Date().toISOString(),
        producer: 'taxonomy-svc',
        kind: 'event',
        name,
        data: { categoria_id: randomUUID(), version: 1 },
      };
      return db.query(
        'INSERT INTO taxonomy.outbox (message_id,event_name,kind,correlation_id,occurred_at,payload) VALUES ($1,$2,$3,$4,$5,$6) RETURNING message_id,delivery_transport',
        [
          messageId,
          name,
          'event',
          correlation,
          payload.occurred_at,
          JSON.stringify(payload),
        ],
      );
    };

    it('stores new H5 intents with the fact, excludes them from H4, and retries the same ID', async () => {
      const legacy = (await insert(admin)).rows[0];
      const h5 = (await insert(runtime)).rows[0];
      expect(legacy.delivery_transport).toBe('RABBITMQ');
      expect(h5.delivery_transport).toBe('AZURE_SERVICE_BUS');
      const publishH4 = vi.fn(async () => undefined);
      expect(await store.publicarUno(publishH4)).toBe('PUBLICADO');
      expect(publishH4).toHaveBeenCalledWith(
        expect.objectContaining({ message_id: legacy.message_id }),
      );
      expect(await store.publicarUno(publishH4)).toBe('VACIO');
      const captured: ServiceBusMessage[] = [];
      const batch = {
        tryAddMessage: (message: ServiceBusMessage) => {
          captured.push(message);
          return true;
        },
      } as ServiceBusMessageBatch;
      const sender = {
        createMessageBatch: async () => batch,
        sendMessages: vi
          .fn(async () => undefined)
          .mockRejectedValueOnce(new Error('AMBIGUOUS')),
      };
      expect(await publishTaxonomyDelivery(store, sender)).toBe(false);
      await admin.query(
        'UPDATE taxonomy.outbox_delivery SET next_attempt_at=clock_timestamp() WHERE message_id=$1',
        [h5.message_id],
      );
      expect(await publishTaxonomyDelivery(store, sender)).toBe(true);
      expect(captured.map((m) => m.messageId)).toEqual([
        h5.message_id,
        h5.message_id,
      ]);
      const result = await admin.query(
        'SELECT sent_at, attempts FROM taxonomy.outbox_delivery',
      );
      expect(result.rows).toEqual([{ sent_at: expect.any(Date), attempts: 2 }]);
      await expect(insert(runtime, 'unknown.event')).rejects.toThrow(
        'Unsupported Taxonomy H5 route',
      );
    });

    it('uses the existing checked-result handler before settling a matching Azure delivery', async () => {
      const result = {
        message_id: randomUUID(),
        correlation_id: randomUUID(),
        operation_id: randomUUID(),
        schema_version: 1,
        occurred_at: new Date().toISOString(),
        producer: 'catalog-svc',
        kind: 'result',
        name: 'catalog.master.deactivation.checked',
        data: {
          entity_type: 'CATEGORY',
          entity_id: randomUUID(),
          version: 2,
          result: 'CLEAR',
        },
      };
      const delivery = {
        body: Buffer.from(JSON.stringify(result)),
        contentType: 'application/json',
        subject: result.name,
        messageId: result.message_id,
        correlationId: result.correlation_id,
      } as ServiceBusReceivedMessage;
      const consumir = vi.fn(async () => undefined);
      const receiver = {
        completeMessage: vi.fn(async () => undefined),
        abandonMessage: vi.fn(async () => undefined),
        deadLetterMessage: vi.fn(async () => undefined),
      };
      await receiveTaxonomyDelivery({ consumir }, receiver, delivery);
      expect(consumir).toHaveBeenCalledWith(result);
      expect(receiver.completeMessage).toHaveBeenCalledWith(delivery);
      expect(
        receiver.completeMessage.mock.invocationCallOrder[0],
      ).toBeGreaterThan(consumir.mock.invocationCallOrder[0]);
      await receiveTaxonomyDelivery({ consumir }, receiver, {
        ...delivery,
        correlationId: randomUUID(),
      });
      expect(receiver.deadLetterMessage).toHaveBeenCalledOnce();
      expect(consumir).toHaveBeenCalledOnce();
    });
  },
);
