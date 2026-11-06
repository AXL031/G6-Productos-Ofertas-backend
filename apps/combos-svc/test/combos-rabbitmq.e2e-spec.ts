import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';
import { Test } from '@nestjs/testing';
import amqp, { type ChannelModel } from 'amqplib';
import type { Channel } from 'amqplib';
import request from 'supertest';
import { CombosSvcController } from '../src/combos-svc.controller.js';
import { CombosEventConsumer } from '../src/messaging/combos-event-consumer.js';
import {
  ComboTokenVerifier,
  SimulatedComboTokenVerifier,
} from '../src/http/combos-auth.js';
import { CombosDatabase } from '../src/persistence/combos.database.js';
import { CombosRepository } from '../src/persistence/combos.repository.js';
import { CombosSvcService } from '../src/combos-svc.service.js';

const exchange = 'po.eventos.x';
const queue = 'po.combos.q';
const routes = [
  'catalog.product.deactivated',
  'catalog.sku.deactivated',
  'inventory.stock.changed',
];
const execFileAsync = promisify(execFile);

describe('Combos RabbitMQ + PostgreSQL isolated integration', () => {
  let connection: ChannelModel;
  let publisher: Awaited<ReturnType<ChannelModel['createChannel']>>;
  let database: CombosDatabase;
  let repository: CombosRepository;
  let consumer: CombosEventConsumer;
  let catalogServer: Server;
  let catalogUnavailable = false;
  let catalogRequests = 0;
  let comboId: string;
  let itemIds: string[];

  const publish = async (
    name: string,
    data: Record<string, unknown>,
    options: {
      messageId?: string;
      invalid?: boolean;
      occurredAt?: string;
      correlationId?: string;
    } = {},
  ) => {
    const messageId = options.messageId ?? randomUUID();
    const envelope = {
      message_id: messageId,
      schema_version: name === 'inventory.stock.changed' ? 2 : 1,
      occurred_at: options.occurredAt ?? new Date().toISOString(),
      correlation_id: options.correlationId ?? 'combos-rabbit-test',
      causation_id: null,
      operation_id: null,
      producer: name.startsWith('catalog.') ? 'catalog-svc' : 'inventory-svc',
      kind: 'event',
      name,
      data,
      ...(options.invalid ? { unexpected: true } : {}),
    };
    publisher.publish(exchange, name, Buffer.from(JSON.stringify(envelope)), {
      persistent: true,
      contentType: 'application/json',
      type: name,
      messageId,
      correlationId: envelope.correlation_id,
    });
    return messageId;
  };

  async function waitForInbox(
    messageId: string,
    timeoutMs = 5000,
    handler?: string,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const count = await database.query((client) =>
        client.query(
          `SELECT count(*)::int AS count FROM combos.inbox
             WHERE message_id=$1 AND ($2::text IS NULL OR handler=$2)`,
          [messageId, handler ?? null],
        ),
      );
      if (count.rows[0]?.count === 1) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`INBOX_TIMEOUT:${messageId}`);
  }

  beforeAll(async () => {
    if (
      process.env.COMBOS_TEST_EPHEMERAL !== '1' ||
      process.env.COMBOS_TEST_DATABASE_URL !== 'harness-owned'
    )
      throw new Error('COMBOS_RABBITMQ_HARNESS_REQUIRED');
    if (!process.env.COMBOS_TEST_RABBITMQ_URL?.startsWith('amqp://'))
      throw new Error('COMBOS_RABBITMQ_FIXTURE_REQUIRED');
    catalogServer = createServer((request, response) => {
      catalogRequests += 1;
      if (catalogUnavailable) {
        response.writeHead(503, {
          'content-type': 'application/problem+json',
        });
        response.end('{"code":"CATALOG_UNAVAILABLE"}');
        return;
      }
      const sku = decodeURIComponent(
        new URL(request.url ?? '/', 'http://localhost').pathname
          .split('/')
          .at(-2) ?? '',
      );
      const productId = sku === 'SKU-RMQ' ? 'product-1' : 'product-2';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          sku,
          productId,
          isVariant: false,
          active: sku !== 'SKU-RMQ',
          eligible: sku !== 'SKU-RMQ',
        }),
      );
    });
    await new Promise<void>((resolve) =>
      catalogServer.listen(0, '127.0.0.1', resolve),
    );
    const catalogAddress = catalogServer.address();
    if (!catalogAddress || typeof catalogAddress === 'string')
      throw new Error('CATALOG_FIXTURE_FAILED');
    process.env.COMBOS_CATALOG_URL = `http://127.0.0.1:${catalogAddress.port}`;
    process.env.COMBOS_CATALOG_SERVICE_BEARER = 'isolated-test-token';
    process.env.SECURITY_ISSUER = 'http://127.0.0.1:1/test-issuer';
    process.env.SECURITY_DISCOVERY_URL =
      'http://127.0.0.1:1/test-issuer/.well-known/openid-configuration';
    process.env.SECURITY_JWKS_URL = 'http://127.0.0.1:1/test-issuer/jwks';
    process.env.COMBOS_AMQP_ENABLED = 'true';
    process.env.COMBOS_AMQP_URL = process.env.COMBOS_TEST_RABBITMQ_URL;
    connection = await amqp.connect(process.env.COMBOS_TEST_RABBITMQ_URL!);
    publisher = await connection.createChannel();
    await publisher.assertExchange(exchange, 'topic', { durable: true });
    await publisher.assertQueue(queue, { durable: true });
    for (const route of routes)
      await publisher.bindQueue(queue, exchange, route);
    database = new CombosDatabase();
    repository = new CombosRepository(database);
    const tls = await database.query((client) =>
      client.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()'),
    );
    expect(tls.rows[0]?.ssl).toBe(true);
    const fixture = await database.query(async (client) => {
      await client.query('BEGIN');
      try {
        const combo = await client.query(
          `INSERT INTO combos.combos(name, combo_price, currency)
           VALUES ('Rabbit integration fixture', 5, 'PEN') RETURNING id`,
        );
        const id = String(combo.rows[0]?.id);
        const items = await client.query(
          `INSERT INTO combos.combo_items(combo_id, sku, quantity)
           VALUES ($1, 'SKU-RMQ', 1), ($1, 'SKU-OTHER', 1) RETURNING id`,
          [id],
        );
        await client.query('COMMIT');
        return { id, items: items.rows.map((row) => String(row.id)) };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
    comboId = fixture.id;
    itemIds = fixture.items;
    await database.query((client) =>
      client.query(
        `INSERT INTO combos.component_projection(combo_item_id, catalog_deactivated, projected_available)
         VALUES ($1, false, 7), ($2, false, 8)`,
        itemIds,
      ),
    );
    consumer = new CombosEventConsumer(repository);
    await consumer.onModuleInit();
    expect(consumer.readinessStatus()).toBe('ready');
    await expect(
      new CombosSvcService(database, repository).readiness(
        consumer.readinessStatus(),
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      dependencies: { postgres: 'ok', rabbitmq: 'ok' },
    });
  }, 30000);

  afterAll(async () => {
    await consumer?.onModuleDestroy();
    await new Promise<void>((resolve) => catalogServer?.close(() => resolve()));
    await publisher?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
    if (comboId && database) {
      await database.query((client) =>
        client.query('DELETE FROM combos.combos WHERE id=$1', [comboId]),
      );
      await database.onModuleDestroy();
    }
    delete process.env.COMBOS_AMQP_ENABLED;
    delete process.env.COMBOS_AMQP_URL;
    delete process.env.COMBOS_CATALOG_URL;
    delete process.env.COMBOS_CATALOG_SERVICE_BEARER;
    delete process.env.SECURITY_ISSUER;
    delete process.env.SECURITY_DISCOVERY_URL;
    delete process.env.SECURITY_JWKS_URL;
  }, 15000);

  it('durably rejects invalid messages before ACK and ACKs a valid event only after commit', async () => {
    const invalidId = await publish(
      'catalog.sku.deactivated',
      {
        sku: 'SKU-RMQ',
        product_id: 'product-1',
        sku_version: 1,
        changed_at: new Date().toISOString(),
      },
      { invalid: true },
    );
    await waitForInbox(invalidId);
    const invalid = await database.query((client) =>
      client.query('SELECT result FROM combos.inbox WHERE message_id=$1', [
        invalidId,
      ]),
    );
    expect(invalid.rows[0]?.result).toBe('REJECTED_INVALID_EVENT');

    const eventId = await publish('catalog.sku.deactivated', {
      sku: 'SKU-RMQ',
      product_id: 'product-1',
      sku_version: 2,
      changed_at: new Date().toISOString(),
    });
    await waitForInbox(eventId);
    const projection = await database.query((client) =>
      client.query(
        'SELECT catalog_deactivated FROM combos.component_projection WHERE combo_item_id=$1',
        [itemIds[0]],
      ),
    );
    expect(projection.rows[0]?.catalog_deactivated).toBe(true);
  }, 10000);

  it('durably rejects malformed JSON when a transport message_id is available', async () => {
    const messageId = randomUUID();
    publisher.publish(exchange, 'catalog.sku.deactivated', Buffer.from('{'), {
      persistent: true,
      contentType: 'application/json',
      type: 'catalog.sku.deactivated',
      messageId,
      correlationId: 'combos-rabbit-test',
    });
    await waitForInbox(messageId);
    const result = await database.query((client) =>
      client.query('SELECT result FROM combos.inbox WHERE message_id=$1', [
        messageId,
      ]),
    );
    expect(result.rows[0]?.result).toBe('REJECTED_INVALID_EVENT');
  }, 10000);

  it('persists impossible ISO dates with a generated Inbox correlation when AMQP correlation is empty', async () => {
    const messageId = await publish(
      'catalog.sku.deactivated',
      {
        sku: 'SKU-IMPOSSIBLE-DATE',
        product_id: 'product-1',
        sku_version: 1,
        changed_at: '2026-02-30T12:00:00.000Z',
      },
      {
        occurredAt: '2026-02-30T12:00:00.000Z',
        correlationId: '',
      },
    );
    await waitForInbox(messageId);
    const result = await database.query((client) =>
      client.query(
        'SELECT result, correlation_id FROM combos.inbox WHERE message_id=$1',
        [messageId],
      ),
    );
    expect(result.rows[0]?.result).toBe('REJECTED_INVALID_EVENT');
    expect(result.rows[0]?.correlation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  }, 10000);

  it('deduplicates replay by message_id and handler across consumer restart', async () => {
    const stockSnapshot = {
      sku: 'SKU-RMQ',
      location_id: randomUUID(),
      on_hand: 9,
      reserved: 1,
      blocked: 1,
      available: 7,
      estado: 'DISPONIBLE',
      stock_version: 5,
      updated_at: new Date().toISOString(),
    };
    const occurredAt = new Date().toISOString();
    const eventId = await publish('inventory.stock.changed', stockSnapshot, {
      occurredAt,
    });
    await waitForInbox(eventId);
    consumer = await consumer
      .onModuleDestroy()
      .then(() => new CombosEventConsumer(repository));
    await consumer.onModuleInit();
    await publish('inventory.stock.changed', stockSnapshot, {
      messageId: eventId,
      occurredAt,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const rows = await database.query((client) =>
      client.query(
        `SELECT count(*)::int AS count FROM combos.inbox
         WHERE message_id=$1 AND handler='combos.inventory.stock.changed'`,
        [eventId],
      ),
    );
    expect(rows.rows[0]?.count).toBe(1);
    const conflicts = await database.query((client) =>
      client.query(
        `SELECT count(*)::int AS count FROM combos.inbox
           WHERE message_id=$1 AND handler='combos.invalid-event'`,
        [eventId],
      ),
    );
    expect(conflicts.rows[0]?.count).toBe(0);
    const publicAvailability = await new CombosSvcService(
      database,
      repository,
    ).availability(comboId);
    expect(publicAvailability).toMatchObject({
      verificable: false,
      cantidadInformativa: null,
    });
  }, 10000);

  it('rejects a reused message_id with a different payload instead of treating it as a valid duplicate', async () => {
    const eventId = randomUUID();
    const occurredAt = new Date().toISOString();
    const first = await publish(
      'catalog.sku.deactivated',
      {
        sku: 'SKU-CONFLICT',
        product_id: 'product-2',
        sku_version: 1,
        changed_at: new Date().toISOString(),
      },
      { messageId: eventId, occurredAt },
    );
    await waitForInbox(first);
    const conflict = await publish(
      'catalog.sku.deactivated',
      {
        sku: 'SKU-CONFLICT',
        product_id: 'product-2',
        sku_version: 2,
        changed_at: new Date().toISOString(),
      },
      { messageId: eventId, occurredAt },
    );
    await waitForInbox(conflict, 5000, 'combos.invalid-event');
    const invalid = await database.query((client) =>
      client.query(
        `SELECT result, payload->>'disposition' AS disposition FROM combos.inbox
         WHERE message_id=$1 AND handler='combos.invalid-event'`,
        [eventId],
      ),
    );
    expect(invalid.rows[0]).toMatchObject({
      result: 'REJECTED_INVALID_EVENT',
      disposition: 'REJECTED_MESSAGE_ID_CONFLICT',
    });
  }, 10000);

  it('maps product_id through Catalog context, including inactive SKUs, before durable ACK', async () => {
    const changedAt = new Date().toISOString();
    const occurredAt = new Date().toISOString();
    const data = {
      product_id: 'product-1',
      product_version: 9,
      changed_at: changedAt,
    };
    const eventId = await publish(
      'catalog.product.deactivated',
      {
        ...data,
      },
      { occurredAt },
    );
    await waitForInbox(eventId);
    const result = await database.query((client) =>
      client.query('SELECT result FROM combos.inbox WHERE message_id=$1', [
        eventId,
      ]),
    );
    expect(result.rows[0]?.result).toBe('PROCESSED');
    const projection = await database.query((client) =>
      client.query(
        `SELECT p.catalog_deactivated FROM combos.component_projection p
         JOIN combos.combo_items i ON i.id = p.combo_item_id
         WHERE i.combo_id = $1 ORDER BY i.sku`,
        [comboId],
      ),
    );
    expect(projection.rows.map((row) => row.catalog_deactivated)).toEqual([
      false,
      true,
    ]);

    const requestsBeforeReplay = catalogRequests;
    catalogUnavailable = true;
    await publish('catalog.product.deactivated', data, {
      messageId: eventId,
      occurredAt,
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(catalogRequests).toBe(requestsBeforeReplay);
    expect(consumer.readinessStatus()).toBe('ready');
    const duplicates = await database.query((client) =>
      client.query(
        `SELECT count(*)::int AS count FROM combos.inbox
           WHERE message_id=$1 AND handler='combos.catalog.product.deactivated'`,
        [eventId],
      ),
    );
    expect(duplicates.rows[0]?.count).toBe(1);
    await publish(
      'catalog.product.deactivated',
      { ...data, product_version: 10 },
      { messageId: eventId, occurredAt },
    );
    await waitForInbox(eventId, 5000, 'combos.invalid-event');
    const conflict = await database.query((client) =>
      client.query(
        `SELECT payload->>'disposition' AS disposition FROM combos.inbox
           WHERE message_id=$1 AND handler='combos.invalid-event'`,
        [eventId],
      ),
    );
    expect(conflict.rows[0]?.disposition).toBe('REJECTED_MESSAGE_ID_CONFLICT');
    expect(catalogRequests).toBe(requestsBeforeReplay);
    catalogUnavailable = false;
  }, 10000);

  it('rechecks product SKU candidates under the write lock after concurrent creation', async () => {
    let mappingStarted!: () => void;
    let finishMapping!: () => void;
    const mappingEntered = new Promise<void>((resolve) => {
      mappingStarted = resolve;
    });
    const mappingRelease = new Promise<void>((resolve) => {
      finishMapping = resolve;
    });
    const eventId = randomUUID();
    const changedAt = new Date().toISOString();
    let resolverCalls = 0;
    const processing = repository.processEvent({
      messageId: eventId,
      handler: 'combos.catalog.product.deactivated',
      eventName: 'catalog.product.deactivated',
      correlationId: 'race-test',
      operationId: null,
      payload: {
        message_id: eventId,
        schema_version: 1,
        occurred_at: changedAt,
        correlation_id: 'race-test',
        producer: 'catalog-svc',
        kind: 'event',
        name: 'catalog.product.deactivated',
        data: {
          product_id: 'product-race',
          product_version: 1,
          changed_at: changedAt,
        },
      },
      disposition: 'PROCESSED',
      changedAt,
      resolveProductSkus: async () => {
        resolverCalls += 1;
        if (resolverCalls > 1) return ['SKU-RACE'];
        mappingStarted();
        await mappingRelease;
        return [];
      },
    });
    await mappingEntered;
    const create = repository.create({
      name: 'Concurrent product fixture',
      description: null,
      price: '1.00',
      currency: 'PEN',
      components: [
        {
          sku: 'SKU-RACE',
          quantity: 1,
          productId: 'product-race',
          catalogObservedAt: changedAt,
        },
        {
          sku: 'SKU-RACE-OTHER',
          quantity: 1,
          productId: 'product-other',
          catalogObservedAt: changedAt,
        },
      ],
    });
    await expect(create).resolves.toBeTruthy();
    finishMapping();
    await expect(processing).resolves.toBe('PROCESSED');
    const rows = await database.query((client) =>
      client.query(
        `SELECT i.sku, p.catalog_deactivated FROM combos.combo_items i
           JOIN combos.component_projection p ON p.combo_item_id=i.id
           WHERE i.sku = ANY($1::text[]) ORDER BY i.sku`,
        [['SKU-RACE', 'SKU-RACE-OTHER']],
      ),
    );
    expect(rows.rows).toEqual([
      { sku: 'SKU-RACE', catalog_deactivated: true },
      { sku: 'SKU-RACE-OTHER', catalog_deactivated: false },
    ]);
    expect(resolverCalls).toBe(2);
  }, 10000);

  it('keeps product deactivation recoverable through Catalog outage and bounded pause', async () => {
    catalogUnavailable = true;
    const eventId = await publish('catalog.product.deactivated', {
      product_id: 'product-2',
      product_version: 10,
      changed_at: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const beforeRestart = await database.query((client) =>
      client.query(
        'SELECT count(*)::int AS count FROM combos.inbox WHERE message_id=$1',
        [eventId],
      ),
    );
    expect(beforeRestart.rows[0]?.count).toBe(0);
    await consumer.onModuleDestroy();
    catalogUnavailable = false;
    consumer = new CombosEventConsumer(repository);
    await consumer.onModuleInit();
    await waitForInbox(eventId);
    const afterRestart = await database.query((client) =>
      client.query('SELECT result FROM combos.inbox WHERE message_id=$1', [
        eventId,
      ]),
    );
    expect(afterRestart.rows[0]?.result).toBe('PROCESSED');
  }, 15000);

  it('bounds RabbitMQ connection recovery attempts when the broker is unavailable', async () => {
    const original = process.env.COMBOS_AMQP_URL;
    process.env.COMBOS_AMQP_URL = 'amqp://127.0.0.1:1/g6-productos-ofertas';
    const unavailable = new CombosEventConsumer(repository);
    const started = Date.now();
    await unavailable.onModuleInit();
    expect(Date.now() - started).toBeLessThan(8000);
    expect(unavailable.readinessStatus()).toBe('not_ready');
    await unavailable.onModuleDestroy();
    process.env.COMBOS_AMQP_URL = original;
  }, 10000);

  it('reports not ready after a later broker disconnection and after bounded pause', async () => {
    const container = process.env.COMBOS_TEST_RABBITMQ_CONTAINER;
    if (!container) throw new Error('RABBITMQ_TEST_CONTAINER_REQUIRED');
    const service = new CombosSvcService(database, repository);
    await execFileAsync('docker', [
      'exec',
      '--user',
      'rabbitmq',
      container,
      'rabbitmqctl',
      'stop_app',
    ]);
    try {
      const disconnectedDeadline = Date.now() + 8000;
      while (
        consumer.readinessStatus() === 'ready' &&
        Date.now() < disconnectedDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(consumer.readinessStatus()).toBe('not_ready');
      await expect(
        service.readiness(consumer.readinessStatus()),
      ).resolves.toMatchObject({
        status: 'error',
        dependencies: { postgres: 'ok', rabbitmq: 'error' },
      });
    } finally {
      await execFileAsync('docker', [
        'exec',
        '--user',
        'rabbitmq',
        container,
        'rabbitmqctl',
        'start_app',
      ]);
    }

    const brokerDeadline = Date.now() + 15000;
    let brokerReady = false;
    while (Date.now() < brokerDeadline) {
      try {
        await execFileAsync('docker', [
          'exec',
          '--user',
          'rabbitmq',
          container,
          'rabbitmq-diagnostics',
          '-q',
          'check_running',
        ]);
        brokerReady = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(brokerReady).toBe(true);
    expect(consumer.readinessStatus()).toBe('not_ready');

    await consumer.onModuleDestroy();
    consumer = new CombosEventConsumer(repository);
    await consumer.onModuleInit();
    await connection.close().catch(() => undefined);
    connection = await amqp.connect(process.env.COMBOS_TEST_RABBITMQ_URL!);
    publisher = await connection.createChannel();
    expect(consumer.readinessStatus()).toBe('ready');
  }, 30000);

  it('leaves an uncommitted delivery unacknowledged on PostgreSQL failure for redelivery after restart', async () => {
    await database.query((client) =>
      client.query(`
        CREATE FUNCTION combos.it_fail_stock_projection() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'fixture rollback'; END $$;
        CREATE TRIGGER it_fail_stock_projection BEFORE UPDATE ON combos.component_projection
        FOR EACH ROW EXECUTE FUNCTION combos.it_fail_stock_projection();
      `),
    );
    const eventId = await publish('inventory.stock.changed', {
      sku: 'SKU-RMQ',
      location_id: randomUUID(),
      on_hand: 9,
      reserved: 1,
      blocked: 1,
      available: 7,
      estado: 'DISPONIBLE',
      stock_version: 6,
      updated_at: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(consumer.readinessStatus()).toBe('not_ready');
    const before = await database.query((client) =>
      client.query(
        'SELECT count(*)::int AS count FROM combos.inbox WHERE message_id=$1',
        [eventId],
      ),
    );
    expect(before.rows[0]?.count).toBe(0);
    await database.query((client) =>
      client.query(`DROP TRIGGER it_fail_stock_projection ON combos.component_projection;
                    DROP FUNCTION combos.it_fail_stock_projection();`),
    );
    await consumer.onModuleDestroy();
    consumer = new CombosEventConsumer(repository);
    await consumer.onModuleInit();
    await waitForInbox(eventId);
    const projection = await database.query((client) =>
      client.query(
        'SELECT projected_available FROM combos.component_projection WHERE combo_item_id=$1',
        [itemIds[0]],
      ),
    );
    expect(projection.rows[0]?.projected_available).toBeNull();
  }, 12000);

  it('pauses without ACK when malformed delivery has no transport message_id', async () => {
    const body = {
      message_id: randomUUID(),
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      correlation_id: 'missing-id',
      producer: 'catalog-svc',
      kind: 'event',
      name: 'catalog.sku.deactivated',
      data: {
        sku: 'SKU-RMQ',
        product_id: 'product-1',
        sku_version: 20,
        changed_at: new Date().toISOString(),
      },
    };
    publisher.publish(
      exchange,
      'catalog.sku.deactivated',
      Buffer.from(JSON.stringify(body)),
      {
        persistent: true,
        contentType: 'application/json',
        type: 'catalog.sku.deactivated',
        correlationId: 'missing-id',
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await consumer.onModuleDestroy();
    const queueState = await publisher.checkQueue(queue);
    expect(queueState.messageCount).toBe(1);
    const redelivery = await publisher.get(queue, { noAck: false });
    expect(redelivery).toBeTruthy();
    if (redelivery) publisher.ack(redelivery);
    consumer = new CombosEventConsumer(repository);
  }, 10000);

  it('marks readiness not ready on broker cancellation without cancelling twice', async () => {
    consumer = new CombosEventConsumer(repository);
    await consumer.onModuleInit();
    expect(consumer.readinessStatus()).toBe('ready');
    const channel = Reflect.get(consumer, 'channel') as Channel | null;
    if (!channel) throw new Error('CONSUMER_CHANNEL_REQUIRED');
    const cancelSpy = vi.spyOn(channel, 'cancel');
    const service = new CombosSvcService(database, repository);
    const module = await Test.createTestingModule({
      controllers: [CombosSvcController],
      providers: [
        { provide: CombosSvcService, useValue: service },
        { provide: CombosEventConsumer, useValue: consumer },
        { provide: ComboTokenVerifier, useValue: { verify: vi.fn() } },
        { provide: SimulatedComboTokenVerifier, useValue: { verify: vi.fn() } },
      ],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      await publisher.deleteQueue(queue);
      const deadline = Date.now() + 2000;
      while (consumer.readinessStatus() === 'ready' && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(consumer.readinessStatus()).toBe('not_ready');
      await request(app.getHttpServer())
        .get('/ready')
        .expect(503)
        .expect({
          status: 'error',
          service: 'combos-svc',
          dependencies: { postgres: 'ok', rabbitmq: 'error' },
        });
      expect(cancelSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
      cancelSpy.mockRestore();
    }
  }, 10000);
});
