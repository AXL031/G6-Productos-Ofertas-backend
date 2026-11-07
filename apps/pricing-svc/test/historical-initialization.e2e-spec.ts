import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PricingDatabase } from '../src/persistence/pricing.database.js';
import { PricingRepository } from '../src/persistence/pricing.repository.js';
import { PricingProductInitialization } from '../src/messaging/pricing-initialization.js';
import { PricingInboxConsumer } from '../src/messaging/inbox-consumer.js';
import { CatalogSkuDeactivated } from '../src/messaging/catalog-sku-deactivated.js';
import { PricingOutboxRelay } from '../src/messaging/outbox-relay.js';
import { prices, priceValidities } from '../src/persistence/pricing.schema.js';
import { IsolatedPostgres } from './isolated-postgres.js';
import { IsolatedRabbitmq } from './isolated-rabbitmq.js';

const historicalData = JSON.parse(
  readFileSync(
    new URL('./fixtures/historical-initialization.json', import.meta.url),
    'utf8',
  ),
) as Record<string, unknown>;

const command = (productId: string, data: Record<string, unknown> = {}) => ({
  message_id: randomUUID(),
  schema_version: 1,
  occurred_at: '2001-01-01T00:00:00Z',
  correlation_id: randomUUID(),
  causation_id: randomUUID(),
  operation_id: randomUUID(),
  producer: 'catalog-svc',
  kind: 'command',
  name: 'pricing.product.initialization.requested',
  data: {
    ...historicalData,
    product_id: productId,
    sku_base: 'BASE-' + productId,
    ...data,
  },
});

describe.skipIf(process.env.PRICING_TEST_AMQP !== '1')(
  'Adopción histórica Pricing — PostgreSQL/RabbitMQ reales descartables',
  () => {
    const postgres = new IsolatedPostgres();
    const broker = new IsolatedRabbitmq();
    const config = {
      nodeEnv: 'test' as const,
      port: 3002,
      databaseUrl: '',
      databaseSsl: false as const,
      amqpUrl: '',
    };
    let db: PricingDatabase;
    let repository: PricingRepository;
    let initialization: PricingProductInitialization;
    let consumer: PricingInboxConsumer | undefined;
    const consume = (
      message: Omit<ReturnType<typeof command>, 'operation_id'> & {
        operation_id: string;
      },
    ) => initialization.consume(Buffer.from(JSON.stringify(message)));
    const result = async (messageId: string) =>
      (
        await postgres.admin!.query(
          "SELECT * FROM pricing.outbox WHERE causation_id=$1 AND kind='result'",
          [messageId],
        )
      ).rows[0];
    const snapshot = async (productId: string) =>
      (
        await postgres.admin!.query(
          `
    SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM pricing.prices p WHERE p.product_id=$1) AS prices,
    (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM pricing.price_validities v JOIN pricing.prices p ON p.id=v.price_id WHERE p.product_id=$1) AS validities,
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM pricing.scheduled_prices s JOIN pricing.prices p ON p.id=s.price_id WHERE p.product_id=$1) AS schedules`,
          [productId],
        )
      ).rows[0];
    async function seed(
      options: {
        cancelled?: boolean;
        from?: Date;
        until?: Date;
        channel?: string;
        sku?: string;
        currency?: string;
      } = {},
    ) {
      const productId = randomUUID();
      return repository.transaction(async (tx) => {
        const [definition] = await tx
          .insert(prices)
          .values({
            productId: options.sku ? null : productId,
            sku: options.sku ?? null,
            channelId: options.channel ?? null,
            priceVersion: 3n,
          })
          .returning();
        const [validity] = await tx
          .insert(priceValidities)
          .values({
            priceId: definition.id,
            precioRegular: '125.50',
            precioOferta: '120.00',
            currency: options.currency ?? 'PEN',
            validFrom: options.from ?? new Date('2000-01-01Z'),
            validUntil: options.until ?? null,
            priceVersion: 3n,
            motivoCambio: 'CARGA_HISTORICA',
            usuarioId: 'actor-historico',
            isCancelled: options.cancelled ?? false,
          })
          .returning();
        return { productId, definition, validity };
      });
    }
    async function noFacts(operationId: string) {
      const rows = await postgres.admin!.query(
        'SELECT event_name FROM pricing.outbox WHERE operation_id=$1',
        [operationId],
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(
        rows.rows.every((row) =>
          row.event_name.startsWith('pricing.product.initialization.'),
        ),
      ).toBe(true);
    }
    beforeAll(async () => {
      await postgres.start();
      await broker.start();
      config.databaseUrl = postgres.runtimeUrl;
      config.amqpUrl = broker.url;
      db = new PricingDatabase(config);
      repository = new PricingRepository(db);
      initialization = new PricingProductInitialization(repository);
      await broker.channel!.bindQueue(
        'po.catalog.q',
        'po.resultados.x',
        'pricing.product.initialization.rejected',
      );
    }, 120000);
    afterAll(async () => {
      await consumer?.onApplicationShutdown();
      await db?.onApplicationShutdown();
      await broker.stop();
      await postgres.stop();
    }, 30000);

    it('adopta vigencia global real sin precio enviado ni inferencia por motivo, con corte persistido', async () => {
      const stored = await seed();
      const before = await snapshot(stored.productId);
      const request = command(stored.productId);
      const start = Date.now();
      expect(await consume(request)).toBe('APPLIED');
      const saved = await result(request.message_id);
      expect(saved.payload).toMatchObject({
        status: 'READY',
        price_version: 3,
        vigencia_id: stored.validity.id,
        code: null,
      });
      expect(saved).toMatchObject({
        operation_id: request.operation_id,
        correlation_id: request.correlation_id,
        causation_id: request.message_id,
      });
      const accepted = (
        await postgres.admin!.query(
          'SELECT processed_at FROM pricing.inbox WHERE message_id=$1',
          [request.message_id],
        )
      ).rows[0];
      expect(accepted.processed_at.getTime()).toBe(
        Date.parse(saved.payload.completed_at),
      );
      expect(
        (
          await postgres.admin!.query(
            'SELECT processed_at=$2::timestamptz AS exact FROM pricing.inbox WHERE message_id=$1',
            [request.message_id, saved.payload.completed_at],
          )
        ).rows[0].exact,
      ).toBe(true);
      expect(accepted.processed_at.getTime()).toBeGreaterThanOrEqual(start);
      expect(await snapshot(stored.productId)).toEqual(before);
      await noFacts(request.operation_id);
    });
    it.each(['125.5', '125.50'])(
      'valida el importe exacto proporcionado: %s',
      async (amount) => {
        const stored = await seed();
        const request = command(stored.productId, { precio_regular: 125.5 });
        const raw = JSON.stringify(request).replace(
          '"precio_regular":125.5',
          `"precio_regular":${amount}`,
        );
        expect(await initialization.consume(Buffer.from(raw))).toBe('APPLIED');
        await noFacts(request.operation_id);
      },
    );
    it('trata las variantes de mayúsculas del operation_id como una operación', async () => {
      const stored = await seed();
      const first = command(stored.productId);
      first.operation_id = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
      expect(await consume(first)).toBe('APPLIED');
      const replay = {
        ...first,
        message_id: randomUUID(),
        operation_id: first.operation_id.toUpperCase(),
      };
      expect(await consume(replay)).toBe('DUPLICATE');
      expect((await result(replay.message_id)).payload).toEqual(
        (await result(first.message_id)).payload,
      );
      const conflict = {
        ...replay,
        message_id: randomUUID(),
        data: { ...replay.data, moneda: 'USD' },
      };
      expect(await consume(conflict)).toBe('REJECTED');
      expect((await result(conflict.message_id)).payload.code).toBe(
        'OPERATION_ID_CONFLICT',
      );
    });
    it.each(['INVALID', undefined])(
      'no confunde channel_id null con %s',
      async (channel) => {
        const stored = await seed();
        const first = command(stored.productId);
        expect(await consume(first)).toBe('APPLIED');
        const next = {
          ...first,
          message_id: randomUUID(),
          data: { ...first.data, channel_id: channel },
        };
        expect(await consume(next)).toBe('REJECTED');
        expect((await result(next.message_id)).payload.code).toBe(
          'OPERATION_ID_CONFLICT',
        );
      },
    );
    it('compara objetos inválidos sin depender del orden de claves en JSONB', async () => {
      const stored = await seed();
      const first = command(stored.productId, {
        channel_id: { z: 1, a: { segundo: 2, primero: 1 } },
      });
      expect(await consume(first)).toBe('REJECTED');
      const replay = {
        ...first,
        message_id: randomUUID(),
        data: {
          ...first.data,
          channel_id: { a: { primero: 1, segundo: 2 }, z: 1 },
        },
      };
      expect(await consume(replay)).toBe('DUPLICATE');
      expect((await result(replay.message_id)).payload).toEqual(
        (await result(first.message_id)).payload,
      );
    });
    it.each([
      { precio_regular: 125.51 },
      { precio_regular: 0 },
      { precio_regular: null },
      { precio_regular: '125.50' },
      { precio_regular: 125.501 },
      { moneda: 'USD' },
      { moneda: '   ' },
    ])('rechaza incompatibilidad sin sobrescribir: %j', async (data) => {
      const stored = await seed();
      const before = await snapshot(stored.productId);
      const request = command(stored.productId, data);
      expect(await consume(request)).toBe('REJECTED');
      expect((await result(request.message_id)).payload).toMatchObject({
        status: 'REJECTED',
        code: 'HISTORICAL_PRICE_CONFLICT',
        price_version: null,
        vigencia_id: null,
      });
      expect(await snapshot(stored.productId)).toEqual(before);
      await noFacts(request.operation_id);
    });
    it.each([
      { cancelled: true },
      { from: new Date('2099-01-01Z') },
      { until: new Date('2002-01-01Z') },
      { channel: 'MARKETPLACE' },
      { sku: 'SKU-AJENO' },
    ])(
      'no adopta canceladas, fuera de corte, SKU ni canal específico: %j',
      async (options) => {
        const stored = await seed(options);
        const before = await snapshot(stored.productId);
        const request = command(stored.productId);
        expect(await consume(request)).toBe('REJECTED');
        expect((await result(request.message_id)).payload.code).toBe(
          'HISTORICAL_PRICE_CONFLICT',
        );
        expect(await snapshot(stored.productId)).toEqual(before);
        await noFacts(request.operation_id);
      },
    );
    it('cero vigencias/producto exacto: no toma precio de otro producto ni fabrica alta', async () => {
      await seed();
      const request = command(randomUUID());
      expect(await consume(request)).toBe('REJECTED');
      expect(await snapshot(request.data.product_id)).toEqual({
        prices: null,
        validities: null,
        schedules: null,
      });
      await noFacts(request.operation_id);
    });
    it('reproduce que una lectura vacía no impide crear el precio antes del corte', async () => {
      const productId = randomUUID();
      const reader = await postgres.admin!.connect();
      const writer = await postgres.admin!.connect();
      try {
        await reader.query('BEGIN');
        const empty = await reader.query(
          'SELECT id FROM pricing.prices WHERE product_id=$1 AND sku IS NULL AND channel_id IS NULL FOR UPDATE',
          [productId],
        );
        expect(empty.rowCount).toBe(0);
        await writer.query('BEGIN');
        const created = await writer.query(
          'INSERT INTO pricing.prices(product_id,sku,channel_id) VALUES($1,NULL,NULL) RETURNING id',
          [productId],
        );
        await writer.query(
          "INSERT INTO pricing.price_validities(price_id,precio_regular,currency,valid_from,price_version,motivo_cambio) VALUES($1,125.50,'PEN','2000-01-01Z',1,'CARGA_HISTORICA')",
          [created.rows[0].id],
        );
        await writer.query('COMMIT');
        const observed = await reader.query(
          'SELECT clock_timestamp() AS cutoff, EXISTS(SELECT 1 FROM pricing.prices WHERE product_id=$1) AS present',
          [productId],
        );
        expect(observed.rows[0].present).toBe(true);
        await reader.query('ROLLBACK');
      } finally {
        await reader.query('ROLLBACK');
        await writer.query('ROLLBACK');
        reader.release();
        writer.release();
      }
    });
    it('espera el lock del producto ausente sin bloquear otro producto', async () => {
      const productId = randomUUID();
      const reader = await postgres.admin!.connect();
      try {
        await reader.query('BEGIN');
        await reader.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          ['pricing-global-product:' + productId],
        );
        let finished = false;
        const pending = consume(command(productId)).then((value) => {
          finished = true;
          return value;
        });
        expect(await consume(command(randomUUID()))).toBe('REJECTED');
        expect(finished).toBe(false);
        await reader.query('COMMIT');
        expect(await pending).toBe('REJECTED');
      } finally {
        await reader.query('ROLLBACK');
        reader.release();
      }
    });
    it('rechaza múltiples elegibles incluso ante corrupción histórica; conserva todo', async () => {
      const stored = await seed();
      const constraint = (
        await postgres.admin!.query(
          "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='ck_price_validities_no_overlap' AND conrelid='pricing.price_validities'::regclass",
        )
      ).rows[0].definition;
      let extraId: string | undefined;
      await postgres.admin!.query(
        'ALTER TABLE pricing.price_validities DROP CONSTRAINT ck_price_validities_no_overlap',
      );
      try {
        extraId = (
          await postgres.admin!.query(
            `INSERT INTO pricing.price_validities(price_id,precio_regular,currency,valid_from,price_version,motivo_cambio) VALUES($1,125.50,'PEN','2000-01-01Z',2,'CORRUPCION_FIXTURE') RETURNING id`,
            [stored.definition.id],
          )
        ).rows[0].id;
        const before = await snapshot(stored.productId);
        const request = command(stored.productId);
        expect(await consume(request)).toBe('REJECTED');
        expect((await result(request.message_id)).payload.code).toBe(
          'HISTORICAL_PRICE_CONFLICT',
        );
        expect(await snapshot(stored.productId)).toEqual(before);
        await noFacts(request.operation_id);
      } finally {
        if (extraId)
          await postgres.admin!.query(
            'DELETE FROM pricing.price_validities WHERE id=$1',
            [extraId],
          );
        await postgres.admin!.query(
          'ALTER TABLE pricing.price_validities ADD CONSTRAINT ck_price_validities_no_overlap ' +
            constraint,
        );
      }
    });
    it('replays/redelivery reutilizan decisión aunque ya no sea vigente, incluso tras reiniciar el handler', async () => {
      const stored = await seed();
      const first = command(stored.productId);
      expect(await consume(first)).toBe('APPLIED');
      const original = await result(first.message_id);
      // Cambio exclusivo de fixture tras commit para demostrar que replay no selecciona otra vez.
      await postgres.admin!.query(
        'UPDATE pricing.price_validities SET valid_until=clock_timestamp() WHERE id=$1',
        [stored.validity.id],
      );
      const before = await snapshot(stored.productId);
      initialization = new PricingProductInitialization(
        new PricingRepository(db),
      );
      expect(await consume(first)).toBe('APPLIED');
      const replay = {
        ...first,
        message_id: randomUUID(),
        correlation_id: randomUUID(),
      };
      expect(await consume(replay)).toBe('DUPLICATE');
      expect((await result(replay.message_id)).payload).toEqual(
        original.payload,
      );
      expect(await consume(command(stored.productId))).toBe('REJECTED');
      expect(await snapshot(stored.productId)).toEqual(before);
      await noFacts(first.operation_id);
    });
    it('replay de rechazo tampoco reevalúa cuando aparece luego una vigencia compatible', async () => {
      const stored = await seed({ cancelled: true });
      const first = command(stored.productId);
      expect(await consume(first)).toBe('REJECTED');
      const original = await result(first.message_id);
      await postgres.admin!.query(
        'UPDATE pricing.price_validities SET is_cancelled=false WHERE id=$1',
        [stored.validity.id],
      );
      const replay = { ...first, message_id: randomUUID() };
      expect(await consume(replay)).toBe('DUPLICATE');
      expect((await result(replay.message_id)).payload).toEqual(
        original.payload,
      );
      await noFacts(first.operation_id);
    });
    it('serializa intención idéntica concurrente y rechaza reutilización incompatible de operation_id', async () => {
      const stored = await seed();
      const first = command(stored.productId);
      const before = await snapshot(stored.productId);
      const requests = Array.from({ length: 6 }, () => ({
        ...first,
        message_id: randomUUID(),
      }));
      const outcomes = await Promise.all(requests.map(consume));
      expect(outcomes.filter((x) => x === 'APPLIED')).toHaveLength(1);
      const results = await Promise.all(
        requests.map((x) => result(x.message_id)),
      );
      expect(new Set(results.map((x) => JSON.stringify(x.payload))).size).toBe(
        1,
      );
      for (const data of [
        { precio_regular: 125.5 },
        { moneda: 'USD' },
        { modalidad: 'ALTA_PRODUCTO', precio_regular: 125.5 },
        { precio_regular: null },
      ]) {
        const conflict = {
          ...first,
          message_id: randomUUID(),
          data: { ...first.data, ...data },
        };
        expect(await consume(conflict)).toBe('REJECTED');
        expect((await result(conflict.message_id)).payload.code).toBe(
          'OPERATION_ID_CONFLICT',
        );
      }
      const replay = { ...first, message_id: randomUUID() };
      expect(await consume(replay)).toBe('DUPLICATE');
      expect((await result(replay.message_id)).payload).toEqual(
        results[0].payload,
      );
      expect(await snapshot(stored.productId)).toEqual(before);
      await noFacts(first.operation_id);
    });
    it('fija corte después de esperar el lock y devuelve la nueva vigencia real, no la versión futura del agregado', async () => {
      const stored = await seed();
      const request = command(stored.productId);
      const connection = await postgres.admin!.connect();
      await connection.query('BEGIN');
      let pending: Promise<unknown> | undefined;
      try {
        await connection.query(
          'SELECT id FROM pricing.prices WHERE id=$1 FOR UPDATE',
          [stored.definition.id],
        );
        pending = consume(request);
        await vi.waitFor(
          async () =>
            expect(
              (
                await postgres.admin!.query(
                  "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='pricing_app' AND wait_event_type='Lock'",
                )
              ).rows[0].n,
            ).toBeGreaterThan(0),
          { timeout: 5000 },
        );
        const boundary = (
          await connection.query(
            'UPDATE pricing.price_validities SET valid_until=clock_timestamp() WHERE id=$1 RETURNING valid_until',
            [stored.validity.id],
          )
        ).rows[0].valid_until;
        await connection.query(
          'UPDATE pricing.prices SET price_version=4 WHERE id=$1',
          [stored.definition.id],
        );
        const next = (
          await connection.query(
            `INSERT INTO pricing.price_validities(price_id,precio_regular,currency,valid_from,price_version,motivo_cambio) SELECT $1,130,'PEN',valid_until,4,'CAMBIO_FIXTURE_TRAS_ESPERA' FROM pricing.price_validities WHERE id=$2 RETURNING id`,
            [stored.definition.id, stored.validity.id],
          )
        ).rows[0].id;
        await connection.query('COMMIT');
        expect(await pending).toBe('APPLIED');
        const saved = await result(request.message_id);
        expect(saved.payload).toMatchObject({
          price_version: 4,
          vigencia_id: next,
        });
        expect(Date.parse(saved.payload.completed_at)).toBeGreaterThanOrEqual(
          boundary.getTime(),
        );
        await noFacts(request.operation_id);
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
        await pending?.catch(() => undefined);
      }
    });
    it('devuelve versión de la vigencia elegible aunque haya una programación futura más nueva', async () => {
      const stored = await seed();
      await postgres.admin!.query('BEGIN');
      try {
        await postgres.admin!.query(
          "UPDATE pricing.price_validities SET valid_until='2099-01-01Z' WHERE id=$1",
          [stored.validity.id],
        );
        await postgres.admin!.query(
          'UPDATE pricing.prices SET price_version=4 WHERE id=$1',
          [stored.definition.id],
        );
        await postgres.admin!.query(
          `INSERT INTO pricing.price_validities(price_id,precio_regular,currency,valid_from,price_version,motivo_cambio) VALUES($1,150,'PEN','2099-01-01Z',4,'PROGRAMACION_FUTURA_FIXTURE')`,
          [stored.definition.id],
        );
        await postgres.admin!.query('COMMIT');
      } catch (error) {
        await postgres.admin!.query('ROLLBACK');
        throw error;
      }
      const before = await snapshot(stored.productId);
      const request = command(stored.productId);
      expect(await consume(request)).toBe('APPLIED');
      expect((await result(request.message_id)).payload).toMatchObject({
        price_version: 3,
        vigencia_id: stored.validity.id,
      });
      expect(await snapshot(stored.productId)).toEqual(before);
      await noFacts(request.operation_id);
    });
    it('rollback sin Outbox no fija la decisión; reintenta atómicamente', async () => {
      const stored = await seed();
      const request = command(stored.productId);
      await postgres.admin!.query(
        'REVOKE INSERT ON pricing.outbox FROM pricing_app',
      );
      try {
        await expect(consume(request)).rejects.toThrow();
      } finally {
        await postgres.admin!.query(
          'GRANT INSERT ON pricing.outbox TO pricing_app',
        );
      }
      expect(
        (
          await postgres.admin!.query(
            'SELECT count(*)::int AS n FROM pricing.inbox WHERE message_id=$1',
            [request.message_id],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(await consume(request)).toBe('APPLIED');
      await noFacts(request.operation_id);
    });
    it('RabbitMQ real: recupera fallo tras commit/antes de ACK y publica aceptación/rechazo sin hechos monetarios', async () => {
      const stored = await seed();
      const first = command(stored.productId);
      const rejection = command(randomUUID());
      const before = await snapshot(stored.productId);
      const original = initialization.consume.bind(initialization);
      let fail = true;
      const spy = vi
        .spyOn(initialization, 'consume')
        .mockImplementation(async (raw) => {
          const outcome = await original(raw);
          if (fail) {
            fail = false;
            throw new Error('FIXTURE_AFTER_COMMIT');
          }
          return outcome;
        });
      consumer = new PricingInboxConsumer(
        config,
        initialization,
        new CatalogSkuDeactivated(repository),
        repository,
      );
      consumer.onApplicationBootstrap();
      await vi.waitFor(() => expect(consumer!.available).toBe(true), {
        timeout: 15000,
      });
      for (const request of [first, rejection, first])
        broker.channel!.publish(
          'po.comandos.x',
          request.name,
          Buffer.from(JSON.stringify(request)),
          { persistent: true, contentType: 'application/json' },
        );
      await vi.waitFor(
        async () => {
          expect(await result(first.message_id)).toBeDefined();
          expect(await result(rejection.message_id)).toBeDefined();
          expect(spy.mock.calls.length).toBeGreaterThanOrEqual(4);
        },
        { timeout: 15000 },
      );
      await consumer.onApplicationShutdown();
      consumer = undefined;
      spy.mockRestore();
      const relay = new PricingOutboxRelay(repository, config);
      for (let i = 0; i < 10; i++) {
        const progress = await relay.runOnce(broker.url);
        expect(progress.published).toBe(progress.selected);
        if (!progress.selected) break;
      }
      const received: Record<string, unknown>[] = [];
      for (;;) {
        const delivery = await broker.channel!.get('po.catalog.q');
        if (!delivery) break;
        received.push(JSON.parse(delivery.content.toString()));
        expect(delivery.properties.userId).toBe('fixture');
        broker.channel!.ack(delivery);
      }
      const own = received.filter(
        (x) =>
          x.operation_id === first.operation_id ||
          x.operation_id === rejection.operation_id,
      );
      expect(own).toHaveLength(2);
      expect(own.map((x) => x.name).sort()).toEqual([
        'pricing.product.initialization.completed',
        'pricing.product.initialization.rejected',
      ]);
      expect(await broker.channel!.get('po.auditoria-precios.q')).toBe(false);
      expect(await snapshot(stored.productId)).toEqual(before);
      await noFacts(first.operation_id);
      await noFacts(rejection.operation_id);
    }, 30000);
    it('regresión: alta implícita/explícita crea precio y hecho; sin precio rechaza; no infiere recuperación por historia', async () => {
      for (const modalidad of [undefined, 'ALTA_PRODUCTO']) {
        const request = command(randomUUID(), {
          modalidad,
          precio_regular: 49.95,
        });
        expect(await consume(request)).toBe('APPLIED');
        expect((await result(request.message_id)).payload).toMatchObject({
          status: 'READY',
          price_version: 1,
        });
        const explicitReplay = {
          ...request,
          message_id: randomUUID(),
          data: { ...request.data, modalidad: 'ALTA_PRODUCTO' },
        };
        expect(await consume(explicitReplay)).toBe('DUPLICATE');
        expect(
          (
            await postgres.admin!.query(
              "SELECT count(*)::int AS n FROM pricing.outbox WHERE operation_id=$1 AND event_name='pricing.price.changed'",
              [request.operation_id],
            )
          ).rows[0].n,
        ).toBe(1);
      }
      const stored = await seed();
      const before = await snapshot(stored.productId);
      const ordinary = command(stored.productId, {
        modalidad: 'ALTA_PRODUCTO',
        precio_regular: 125.5,
      });
      expect(await consume(ordinary)).toBe('REJECTED');
      expect((await result(ordinary.message_id)).payload.code).toBe(
        'PRODUCT_ALREADY_INITIALIZED',
      );
      const absent = command(randomUUID(), { modalidad: 'ALTA_PRODUCTO' });
      expect(await consume(absent)).toBe('REJECTED');
      expect(await snapshot(stored.productId)).toEqual(before);
    });
  },
);
