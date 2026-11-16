import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Database } from '../src/database.js';
import { outbox } from '../src/catalog.schema.js';
import type { CatalogEnvelope } from '../src/catalog-messages.js';
import {
  enqueueCatalogDeliveries,
  relayCatalogDelivery,
} from '../src/catalog-service-bus-relay.js';

describe.runIf(process.env.CATALOG_H4_NATIVE_POSTGRES === '1')(
  'H5 independent deliveries on disposable PostgreSQL',
  () => {
    const database = new Database();
    beforeAll(() => {
      if (
        process.env.PGDATABASE !== 'h4_catalog_isolated' ||
        process.env.PGHOST !== 'localhost' ||
        process.env.G6_CONNECT_HOST !== '127.0.0.1'
      ) {
        throw new Error('Expected the H4 isolated loopback database');
      }
    });
    afterAll(() => database.onModuleDestroy());

    it('keeps stable identity on ambiguous confirmation and lets other destinations advance', async () => {
      const timestamp = new Date().toISOString();
      const event: CatalogEnvelope = {
        message_id: randomUUID(),
        schema_version: 1,
        occurred_at: timestamp,
        correlation_id: randomUUID(),
        causation_id: null,
        operation_id: null,
        producer: 'catalog-svc',
        kind: 'event',
        name: 'catalog.product.deactivated',
        data: {
          product_id: randomUUID(),
          product_version: 7,
          changed_at: timestamp,
        },
      };
      await database.transaction(async (tx) => {
        await tx.insert(outbox).values({
          message_id: event.message_id,
          event_name: event.name,
          kind: event.kind,
          correlation_id: event.correlation_id,
          occurred_at: new Date(timestamp),
          payload: event.data,
        });
        await enqueueCatalogDeliveries(tx, event);
        await enqueueCatalogDeliveries(tx, event);
      });
      const publish = vi.fn().mockRejectedValueOnce(new Error('ambiguous'));
      const bus = { publish };
      expect(await relayCatalogDelivery(database, bus)).toBe('RETRY');
      expect(await relayCatalogDelivery(database, bus)).toBe('CONFIRMED');
      expect(publish.mock.calls[1]?.[0]).not.toBe(publish.mock.calls[0]?.[0]);
      expect(await relayCatalogDelivery(database, bus)).toBe('EMPTY');
      await database.transaction((tx) =>
        tx.execute(sql`
        UPDATE catalog.outbox_delivery SET available_at = now()
        WHERE message_id = ${event.message_id} AND published_at IS NULL
      `),
      );
      expect(await relayCatalogDelivery(database, bus)).toBe('CONFIRMED');
      expect(publish.mock.calls[2]?.slice(0, 2)).toEqual([
        publish.mock.calls[0]?.[0],
        event,
      ]);
      expect(await relayCatalogDelivery(database, bus)).toBe('EMPTY');
    });
  },
);
