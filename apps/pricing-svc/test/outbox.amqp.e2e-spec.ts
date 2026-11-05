import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PricingDatabase } from '../src/persistence/pricing.database.js';
import { PricingRepository } from '../src/persistence/pricing.repository.js';
import { PricingOutboxRelay } from '../src/messaging/outbox-relay.js';
import { IsolatedPostgres } from './isolated-postgres.js';
import { IsolatedRabbitmq } from './isolated-rabbitmq.js';

describe.skipIf(process.env.PRICING_TEST_AMQP !== '1')(
  'Outbox Pricing con PostgreSQL y RabbitMQ reales aislados',
  () => {
    const postgres = new IsolatedPostgres();
    const broker = new IsolatedRabbitmq();
    let database: PricingDatabase;
    let relay: PricingOutboxRelay;
    async function insert() {
      const id = randomUUID();
      await postgres.admin!.query(
        `INSERT INTO pricing.outbox(message_id,event_name,kind,correlation_id,occurred_at,payload)
      VALUES($1,'pricing.price.changed','event',$2,now(),$3)`,
        [
          id,
          randomUUID(),
          JSON.stringify({
            target_type: 'PRODUCTO',
            product_id: randomUUID(),
            sku: null,
            channel_id: null,
            currency: 'PEN',
            price_type: 'REGULAR',
            previous_price: null,
            new_price: '123.45',
            operation: 'CREACION',
            reason: 'ALTA_PRODUCTO',
            price_version: 1,
            valid_from: new Date().toISOString(),
            batch_id: null,
            actor: { user_id: null, email: null, ip: null },
          }),
        ],
      );
      return id;
    }
    async function insertInitializationResult() {
      const id = randomUUID();
      await postgres.admin!.query(
        `INSERT INTO pricing.outbox(message_id,event_name,kind,schema_version,correlation_id,causation_id,operation_id,occurred_at,payload)
         VALUES($1,'pricing.product.initialization.completed','result',1,$2,$3,$4,now(),$5)`,
        [
          id,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          JSON.stringify({
            product_id: randomUUID(),
            sku_base: 'BASE-1',
            status: 'READY',
            price_version: 1,
            vigencia_id: randomUUID(),
            code: null,
            completed_at: new Date().toISOString(),
          }),
        ],
      );
      return id;
    }
    const stored = async (id: string) =>
      (
        await postgres.admin!.query(
          'SELECT * FROM pricing.outbox WHERE message_id=$1',
          [id],
        )
      ).rows[0];
    async function delivery() {
      const message = await broker.channel!.get('po.auditoria-precios.q', {
        noAck: false,
      });
      if (!message) throw new Error('Falta la entrega AMQP esperada.');
      broker.channel!.ack(message);
      return {
        ...(JSON.parse(message.content.toString('utf8')) as {
          message_id: string;
          data: unknown;
          producer: string;
        }),
        user_id: message.properties.userId,
      };
    }
    beforeAll(async () => {
      await postgres.start();
      await broker.start();
      database = new PricingDatabase({
        nodeEnv: 'test',
        port: 3002,
        databaseUrl: postgres.runtimeUrl,
        databaseSsl: false,
      });
      relay = new PricingOutboxRelay(new PricingRepository(database), {
        nodeEnv: 'test',
        port: 3002,
        databaseUrl: postgres.runtimeUrl,
        databaseSsl: false,
        priceChangedPublishingEnabled: true,
      });
    }, 120000);
    afterAll(async () => {
      await database?.onApplicationShutdown();
      await broker.stop();
      await postgres.stop();
    });
    it('con la compuerta apagada publica resultados y conserva el evento de precio pendiente', async () => {
      const id = await insert();
      const resultId = await insertInitializationResult();
      const disabled = new PricingOutboxRelay(new PricingRepository(database), {
        nodeEnv: 'test',
        port: 3002,
        databaseUrl: postgres.runtimeUrl,
        databaseSsl: false,
      });
      try {
        expect(await disabled.runOnce(broker.url)).toEqual({
          selected: 1,
          published: 1,
        });
        expect((await stored(id)).published_at).toBeNull();
        expect((await stored(resultId)).published_at).not.toBeNull();
        const resultMessage = await broker.channel!.get('po.catalog.q', {
          noAck: false,
        });
        expect(resultMessage).not.toBe(false);
        expect(
          JSON.parse(resultMessage!.content.toString('utf8')),
        ).toMatchObject({
          name: 'pricing.product.initialization.completed',
          kind: 'result',
          producer: 'pricing-svc',
        });
        broker.channel!.ack(resultMessage!);
      } finally {
        await postgres.admin!.query(
          'UPDATE pricing.outbox SET published_at=now() WHERE message_id IN ($1,$2)',
          [id, resultId],
        );
      }
    });
    it('marca publicado solo después de confirm y conserva identidad y payload', async () => {
      const id = await insert();
      expect(await relay.runOnce(broker.url)).toEqual({
        selected: 1,
        published: 1,
      });
      expect(await delivery()).toMatchObject({
        message_id: id,
        producer: 'pricing-svc',
        user_id: 'fixture',
        data: { price_type: 'REGULAR', new_price: '123.45' },
      });
      expect((await stored(id)).published_at).not.toBeNull();
      expect(await relay.runOnce(broker.url)).toEqual({
        selected: 0,
        published: 0,
      });
    });
    it('mandatory sin ruta conserva pendiente y reenvía la misma identidad al recuperar binding', async () => {
      await broker.channel!.unbindQueue(
        'po.auditoria-precios.q',
        'po.eventos.x',
        'pricing.price.changed',
      );
      const id = await insert();
      try {
        expect(await relay.runOnce(broker.url)).toEqual({
          selected: 1,
          published: 0,
        });
        expect(await stored(id)).toMatchObject({
          published_at: null,
          attempts: 1,
          last_error: 'PUBLICACION_NO_CONFIRMADA',
        });
      } finally {
        await broker.channel!.bindQueue(
          'po.auditoria-precios.q',
          'po.eventos.x',
          'pricing.price.changed',
        );
      }
      expect(await relay.runOnce(broker.url)).toEqual({
        selected: 1,
        published: 1,
      });
      expect((await delivery()).message_id).toBe(id);
    });
    it('dos relays usan locks/skip locked sin publicar dos veces la misma fila', async () => {
      const id = await insert();
      const results = await Promise.all([
        relay.runOnce(broker.url),
        relay.runOnce(broker.url),
      ]);
      expect(results.reduce((n, r) => n + r.published, 0)).toBe(1);
      expect((await delivery()).message_id).toBe(id);
      expect(await broker.channel!.get('po.auditoria-precios.q')).toBe(false);
    });
    it('fallo DB después del confirm conserva pendiente y repite message_id, sin prometer exactly-once', async () => {
      const id = await insert();
      await postgres.admin!
        .query(`CREATE FUNCTION pricing.fixture_confirm_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.message_id = '${id}'::uuid AND NEW.published_at IS NOT NULL THEN RAISE EXCEPTION 'Fixture: fallo posterior al confirm'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fixture_confirm_failure BEFORE UPDATE ON pricing.outbox FOR EACH ROW EXECUTE FUNCTION pricing.fixture_confirm_failure();`);
      try {
        await expect(relay.runOnce(broker.url)).rejects.toThrow();
      } finally {
        await postgres.admin!.query(
          'DROP TRIGGER fixture_confirm_failure ON pricing.outbox; DROP FUNCTION pricing.fixture_confirm_failure()',
        );
      }
      expect((await delivery()).message_id).toBe(id);
      expect((await stored(id)).published_at).toBeNull();
      await relay.runOnce(broker.url);
      expect((await delivery()).message_id).toBe(id);
    });
    it('interrupción del broker no marca como publicada una entrega no confirmada', async () => {
      const id = await insert();
      await broker.pause();
      try {
        await expect(relay.runOnce(broker.url)).rejects.toThrow();
      } finally {
        await broker.resume();
      }
      expect((await stored(id)).published_at).toBeNull();
      await relay.runOnce(broker.url);
      expect((await delivery()).message_id).toBe(id);
    }, 30000);
  },
);
