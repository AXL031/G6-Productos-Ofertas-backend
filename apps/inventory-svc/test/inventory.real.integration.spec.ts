import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import amqp from 'amqplib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { InventorySvcModule } from '../src/inventory-svc.module.js';
import { InventoryAuthGuard } from '../src/auth/inventory-auth.guard.js';
import { ProblemDetailsFilter } from '../src/errors/problem-details.filter.js';
import {
  createCryptographicJwt,
  TEST_ISSUER,
  TEST_PUBLIC_KEY,
} from './crypto-test-token.helper.js';
import { DatabaseService } from '../src/database/database.service.js';
import { IdempotencyService } from '../src/idempotency/idempotency.service.js';
import { KardexService } from '../src/kardex/kardex.service.js';
import { OutboxService } from '../src/outbox/outbox.service.js';
import { OutboxPublisherService } from '../src/outbox/outbox-publisher.service.js';
import { ReservationExpirationService } from '../src/reservations/reservation-expiration.service.js';
import { ReservationsService } from '../src/reservations/reservations.service.js';
import { InventoryWorkersService } from '../src/workers/inventory-workers.service.js';
import { InventoryCommandService } from '../src/inbox/inventory-command.service.js';
import { InventoryConsumerService } from '../src/inbox/inventory-consumer.service.js';
import { AbsoluteStockAdjustmentService } from '../src/bulk/absolute-stock-adjustment.service.js';
import { OfflineReconciliationService } from '../src/conciliacion/offline-reconciliation.service.js';
import type { ConciliacionOfflineRequest } from '../src/types/inventory.dto.js';
import { DrizzleInboxRepository } from '../src/repositories/drizzle/drizzle-inbox.repository.js';
import { DrizzleCommercialRoutesRepository } from '../src/repositories/drizzle/drizzle-commercial-routes.repository.js';
import { DrizzleKardexRepository } from '../src/repositories/drizzle/drizzle-kardex.repository.js';
import { DrizzleLocationsRepository } from '../src/repositories/drizzle/drizzle-locations.repository.js';
import { DrizzleOperationsRepository } from '../src/repositories/drizzle/drizzle-operations.repository.js';
import { DrizzleOutboxRepository } from '../src/repositories/drizzle/drizzle-outbox.repository.js';
import { DrizzleReservationsRepository } from '../src/repositories/drizzle/drizzle-reservations.repository.js';
import { DrizzleStockBalanceRepository } from '../src/repositories/drizzle/drizzle-stock-balance.repository.js';
import { DrizzleSkuLifecycleRepository } from '../src/repositories/drizzle/drizzle-sku-lifecycle.repository.js';
import { DisponibilidadService } from '../src/disponibilidad/disponibilidad.service.js';
import { catalogPr185SkuDeactivatedEvent } from './catalog-pr185.fixture.js';

const enabled = Boolean(process.env.INVENTORY_REAL_INTEGRATION === '1');
const suite = enabled ? describe : describe.skip;
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousRabbitMqUrl = process.env.RABBITMQ_URL;

suite('inventory-svc integración real PostgreSQL + RabbitMQ', () => {
  const database = new DatabaseService();
  const reservationsRepo = new DrizzleReservationsRepository(database);
  const stockRepo = new DrizzleStockBalanceRepository(database);
  const commercialRoutesRepo = new DrizzleCommercialRoutesRepository(database);
  const availability = new DisponibilidadService(
    stockRepo,
    commercialRoutesRepo,
    new DrizzleSkuLifecycleRepository(database),
  );
  const operationsRepo = new DrizzleOperationsRepository(database);
  const outboxRepo = new DrizzleOutboxRepository(database);
  const outboxService = new OutboxService(outboxRepo);
  const reservations = new ReservationsService(
    database,
    new IdempotencyService(),
    new KardexService(new DrizzleKardexRepository(database)),
    outboxService,
    reservationsRepo,
    stockRepo,
    operationsRepo,
    new DrizzleLocationsRepository(database),
    commercialRoutesRepo,
  );
  const expiration = new ReservationExpirationService(
    database,
    reservations,
    reservationsRepo,
  );
  let broker: amqp.ChannelModel;
  let brokerChannel: amqp.Channel;
  let locationId: string;
  const exchangeEvents = 'po.eventos.x';
  const exchangeResults = 'po.resultados.x';
  const exchangeCommands = 'po.commands.x';
  const initializationKey = 'inventory.sku.initialization.requested';
  const queue = `inventory-it-${randomUUID()}`;
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  const dockerLabel = `inventory.integration.run=${runId}`;
  const networkName = `inventory-it-net-${runId}`;
  const pgContainer = `inventory-it-pg-${runId}`;
  const rabbitContainer = `inventory-it-rabbit-${runId}`;
  let pgUrl: string;
  let rabbitUrl: string;
  let tlsPostgresUrl: string;
  let tlsDirectory: string;
  let trustedCaPath: string;
  let untrustedCaPath: string;

  function docker(args: string[], input?: string): string {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
    }).trim();
  }

  function cleanupOwnedResources(): void {
    for (const container of [pgContainer, rabbitContainer]) {
      try {
        const labels = JSON.parse(
          docker(['inspect', '--format', '{{json .Config.Labels}}', container]),
        ) as Record<string, string>;
        if (labels['inventory.integration.run'] === runId) {
          docker(['rm', '-f', '-v', container]);
        }
      } catch {
        // El recurso no llegó a crearse o ya fue retirado.
      }
    }
    try {
      const labels = JSON.parse(
        docker([
          'network',
          'inspect',
          '--format',
          '{{json .Labels}}',
          networkName,
        ]),
      ) as Record<string, string>;
      if (labels['inventory.integration.run'] === runId) {
        docker(['network', 'rm', networkName]);
      }
    } catch {
      // La red no llegó a crearse o Docker ya la retiró.
    }
  }

  function diagnoseOwnedResources(secrets: string[]): void {
    for (const container of [pgContainer, rabbitContainer]) {
      try {
        const labels = JSON.parse(
          docker(['inspect', '--format', '{{json .Config.Labels}}', container]),
        ) as Record<string, string>;
        if (labels['inventory.integration.run'] !== runId) continue;
        const state = docker([
          'inspect',
          '--format',
          '{{.State.Status}} exit={{.State.ExitCode}}',
          container,
        ]);
        const logs = docker(['logs', '--tail', '40', container]);
        const safeLogs = logs
          .split('\n')
          .map((line) => {
            if (/Error when reading.*\.erlang\.cookie.*eacces/i.test(line)) {
              return 'ERLANG_COOKIE_READ_PERMISSION_DENIED';
            }
            if (/cookie.*must be accessible by owner only/i.test(line)) {
              return 'ERLANG_COOKIE_FILE_PERMISSIONS_INVALID';
            }
            if (
              /password|cookie|credential|secret|amqps?:\/\/|postgres(?:ql)?:\/\//i.test(
                line,
              )
            )
              return '[REDACTED]';
            return secrets.reduce(
              (safe, secret) => safe.replaceAll(secret, '[REDACTED]'),
              line,
            );
          })
          .join('\n');
        console.error(
          `[inventory integration] ${container}: ${state}\n${safeLogs}`,
        );
      } catch {
        console.error(
          '[inventory integration] No se pudo consultar el recurso efímero propio.',
        );
      }
    }
  }

  beforeAll(async () => {
    const password = randomBytes(24).toString('hex');
    const rabbitPassword = randomBytes(24).toString('hex');
    try {
      tlsDirectory = mkdtempSync(join(tmpdir(), 'inventory-pg-tls-'));
      trustedCaPath = join(tlsDirectory, 'ca.crt');
      untrustedCaPath = join(tlsDirectory, 'untrusted-ca.crt');
      const openssl =
        process.platform === 'win32' &&
        existsSync('C:/Program Files/Git/usr/bin/openssl.exe')
          ? 'C:/Program Files/Git/usr/bin/openssl.exe'
          : 'openssl';
      const opensslRun = (args: string[]) =>
        execFileSync(openssl, args, { stdio: 'ignore' });
      opensslRun([
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(tlsDirectory, 'ca.key'),
        '-out',
        trustedCaPath,
        '-days',
        '2',
        '-subj',
        '/CN=InventoryIntegrationCA',
      ]);
      opensslRun([
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(tlsDirectory, 'server.key'),
        '-out',
        join(tlsDirectory, 'server.csr'),
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ]);
      opensslRun([
        'x509',
        '-req',
        '-in',
        join(tlsDirectory, 'server.csr'),
        '-CA',
        trustedCaPath,
        '-CAkey',
        join(tlsDirectory, 'ca.key'),
        '-CAcreateserial',
        '-out',
        join(tlsDirectory, 'server.crt'),
        '-days',
        '2',
        '-copy_extensions',
        'copy',
      ]);
      opensslRun([
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(tlsDirectory, 'untrusted-ca.key'),
        '-out',
        untrustedCaPath,
        '-days',
        '2',
        '-subj',
        '/CN=UntrustedInventoryCA',
      ]);
      docker(['network', 'create', '--label', dockerLabel, networkName]);
      docker([
        'run',
        '-d',
        '--name',
        pgContainer,
        '--label',
        dockerLabel,
        '--network',
        networkName,
        '-p',
        '127.0.0.1::5432',
        '-e',
        'POSTGRES_USER=inventory_test',
        '-e',
        `POSTGRES_PASSWORD=${password}`,
        '-e',
        'POSTGRES_DB=inventory_it',
        'postgres:17-alpine',
      ]);
      docker([
        'run',
        '-d',
        '--name',
        rabbitContainer,
        '--label',
        dockerLabel,
        '--network',
        networkName,
        '-p',
        '127.0.0.1::5672',
        '-e',
        'RABBITMQ_DEFAULT_USER=inventory_test',
        '-e',
        `RABBITMQ_DEFAULT_PASS=${rabbitPassword}`,
        '-e',
        'RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS=+S 2:2 +SDcpu 1 +SDio 1',
        '-e',
        'RABBITMQ_CTL_ERL_ARGS=+S 1:1 +SDcpu 1 +SDio 1',
        'rabbitmq:3.13-management-alpine',
      ]);
      let pgPort = docker(['port', pgContainer, '5432/tcp']).split(':').at(-1);
      const rabbitPort = docker(['port', rabbitContainer, '5672/tcp'])
        .split(':')
        .at(-1);
      if (!pgPort || !rabbitPort)
        throw new Error('Docker no asignó puertos loopback.');
      pgUrl = `postgresql://inventory_test:${password}@127.0.0.1:${pgPort}/inventory_it?sslmode=disable`;
      tlsPostgresUrl = `postgresql://inventory_test:${password}@127.0.0.1:${pgPort}/inventory_it`;
      rabbitUrl = `amqp://inventory_test:${rabbitPassword}@127.0.0.1:${rabbitPort}/`;

      await waitForContainer(
        rabbitContainer,
        'rabbitmq-diagnostics -q check_running',
        'rabbitmq',
      );
      await waitForContainer(
        pgContainer,
        'pg_isready -h 127.0.0.1 -U inventory_test -d inventory_it',
      );
      for (const file of ['server.crt', 'server.key']) {
        docker([
          'cp',
          join(tlsDirectory, file),
          `${pgContainer}:/tmp/inventory-${file}`,
        ]);
      }
      docker([
        'exec',
        pgContainer,
        'sh',
        '-c',
        'chown postgres:postgres /tmp/inventory-server.key /tmp/inventory-server.crt && chmod 600 /tmp/inventory-server.key',
      ]);
      docker([
        'exec',
        pgContainer,
        'psql',
        '-U',
        'inventory_test',
        '-d',
        'inventory_it',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        "ALTER SYSTEM SET ssl = 'on'",
        '-c',
        "ALTER SYSTEM SET ssl_cert_file = '/tmp/inventory-server.crt'",
        '-c',
        "ALTER SYSTEM SET ssl_key_file = '/tmp/inventory-server.key'",
      ]);
      docker(['restart', pgContainer]);
      await waitForContainer(
        pgContainer,
        'pg_isready -h 127.0.0.1 -U inventory_test -d inventory_it',
      );
      pgPort = docker(['port', pgContainer, '5432/tcp']).split(':').at(-1);
      if (!pgPort)
        throw new Error('Docker perdió el puerto asignado a PostgreSQL.');
      pgUrl = `postgresql://inventory_test:${password}@127.0.0.1:${pgPort}/inventory_it?sslmode=disable`;
      tlsPostgresUrl = `postgresql://inventory_test:${password}@127.0.0.1:${pgPort}/inventory_it`;
      const docsRoot = process.env.G6_DOCS_ROOT
        ? pathToFileURL(
            resolve(process.env.G6_DOCS_ROOT, 'datos/inventory-svc') + '/',
          )
        : new URL('../../../../docs/datos/inventory-svc/', import.meta.url);
      const initial = await readFile(
        new URL('migration.sql', docsRoot),
        'utf8',
      );
      const incremental = await readFile(
        new URL(
          'migrations/0002_order_id_operaciones_disponibilidad.sql',
          docsRoot,
        ),
        'utf8',
      );
      const inventoryCandidateMigration = await readFile(
        new URL(
          '../migrations/20261104_0001_lifecycle_offline_reconciliation.sql',
          import.meta.url,
        ),
        'utf8',
      );
      docker(
        [
          'exec',
          '-i',
          pgContainer,
          'psql',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          'inventory_test',
          '-d',
          'inventory_it',
        ],
        initial,
      );
      docker(
        [
          'exec',
          '-i',
          pgContainer,
          'psql',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          'inventory_test',
          '-d',
          'inventory_it',
        ],
        `BEGIN;\n${incremental}\nCOMMIT;`,
      );
      docker(
        [
          'exec',
          '-i',
          pgContainer,
          'psql',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          'inventory_test',
          '-d',
          'inventory_it',
        ],
        inventoryCandidateMigration,
      );
      docker(
        [
          'exec',
          '-i',
          pgContainer,
          'psql',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          'inventory_test',
          '-d',
          'inventory_it',
        ],
        inventoryCandidateMigration,
      );
      docker([
        'exec',
        '--user',
        'rabbitmq',
        rabbitContainer,
        'rabbitmqctl',
        'add_vhost',
        '/inventory-it',
      ]);
      docker([
        'exec',
        '--user',
        'rabbitmq',
        rabbitContainer,
        'rabbitmqctl',
        'set_permissions',
        '-p',
        '/inventory-it',
        'inventory_test',
        '.*',
        '.*',
        '.*',
      ]);
      rabbitUrl = `amqp://inventory_test:${rabbitPassword}@127.0.0.1:${rabbitPort}/%2Finventory-it`;
      process.env.DATABASE_URL = pgUrl;
      process.env.RABBITMQ_URL = rabbitUrl;
      await database.onModuleInit();
      broker = await amqp.connect(rabbitUrl);
      brokerChannel = await broker.createChannel();
    } catch (error) {
      diagnoseOwnedResources([password, rabbitPassword]);
      cleanupOwnedResources();
      if (tlsDirectory) rmSync(tlsDirectory, { recursive: true, force: true });
      throw error;
    }
    await brokerChannel.assertExchange(exchangeEvents, 'topic', {
      durable: true,
    });
    await brokerChannel.assertExchange(exchangeResults, 'topic', {
      durable: true,
    });
    // Topología exclusiva del vhost efímero; no configura retry/DLX productivo.
    await brokerChannel.assertExchange(exchangeCommands, 'topic', {
      durable: true,
    });
    await brokerChannel.assertQueue('po.inventario.q', {
      durable: true,
      arguments: { 'x-queue-type': 'quorum' },
    });
    await brokerChannel.bindQueue(
      'po.inventario.q',
      exchangeCommands,
      initializationKey,
    );
    await brokerChannel.assertQueue(queue, {
      durable: false,
      exclusive: true,
      autoDelete: true,
    });
    await brokerChannel.bindQueue(queue, exchangeEvents, 'inventory.#');
    await brokerChannel.bindQueue(queue, exchangeResults, 'inventory.#');
    const location = await database.query<{ id: string }>(
      `INSERT INTO inventory.locations(code,name,type) VALUES ($1,$2,'TIENDA') RETURNING id`,
      [`it-${randomUUID()}`, 'Inventory integration'],
    );
    locationId = location.rows[0].id;
    process.env.INVENTORY_WORKER_INTERVAL_MS = '250';
    process.env.INVENTORY_WORKER_BATCH_SIZE = '10';
    process.env.RESERVATION_TTL_SECONDS = '30';
  }, 120_000);

  afterAll(async () => {
    await brokerChannel?.close().catch(() => undefined);
    await broker?.close().catch(() => undefined);
    await database.onModuleDestroy();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousRabbitMqUrl === undefined) delete process.env.RABBITMQ_URL;
    else process.env.RABBITMQ_URL = previousRabbitMqUrl;
    cleanupOwnedResources();
  }, 30_000);

  async function withProductionPostgresTls(
    databaseUrl: string,
    caPath: string,
    expectReady: boolean,
  ): Promise<void> {
    const keys = [
      'NODE_ENV',
      'DATABASE_URL',
      'PGHOST',
      'PGPORT',
      'PGDATABASE',
      'PGUSER',
      'PGPASSWORD',
      'PGSSLMODE',
      'PGSSLROOTCERT',
    ] as const;
    const saved = Object.fromEntries(
      keys.map((key) => [key, process.env[key]]),
    );
    const service = new DatabaseService();
    try {
      for (const key of keys) delete process.env[key];
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = databaseUrl;
      process.env.PGSSLMODE = 'verify-full';
      process.env.PGSSLROOTCERT = caPath;
      if (expectReady) {
        await service.onModuleInit();
        expect((await service.isHealthy()).healthy).toBe(true);
      } else {
        await expect(service.onModuleInit()).rejects.toThrow(
          /PostgreSQL o el esquema requerido/,
        );
        expect((await service.isHealthy()).healthy).toBe(false);
      }
    } finally {
      await service.onModuleDestroy();
      for (const key of keys) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('conecta al PostgreSQL local desechable con TLS, CA válida y hostname verificado', async () => {
    await withProductionPostgresTls(tlsPostgresUrl, trustedCaPath, true);
  }, 15_000);

  it('rechaza certificado firmado por una CA no confiable', async () => {
    await withProductionPostgresTls(tlsPostgresUrl, untrustedCaPath, false);
  }, 15_000);

  it('rechaza certificado confiable presentado para un hostname distinto', async () => {
    const wrongHostnameUrl = tlsPostgresUrl.replace(
      '@127.0.0.1:',
      '@localhost:',
    );
    await withProductionPostgresTls(wrongHostnameUrl, trustedCaPath, false);
  }, 15_000);

  async function seedStock(sku = `sku-${randomUUID()}`, qty = 20) {
    await database.query(
      `INSERT INTO inventory.stock_balance(sku_id,location_id,on_hand,reserved,blocked) VALUES($1,$2,$3,0,0)`,
      [sku, locationId, qty],
    );
    return sku;
  }

  async function reserve(sku: string, qty = 2, order = `PED-${randomUUID()}`) {
    const accepted = await reservations.solicitarReserva(
      {
        order_id: order,
        operation_id: randomUUID(),
        channel_id: 'MARKETPLACE',
        lines: [{ sku, quantity: qty, location_id: locationId }],
      },
      undefined,
      `idem-${randomUUID()}`,
      'modulo-ventas',
    );
    const row = await database.query<{ reservation_id: string }>(
      `SELECT reservation_id FROM inventory.reservations WHERE operation_id=$1`,
      [accepted.operation_id],
    );
    return { accepted, reservationId: row.rows[0].reservation_id, order };
  }

  function absoluteAdjustmentService(
    output = outboxService,
  ): AbsoluteStockAdjustmentService {
    return new AbsoluteStockAdjustmentService(
      database,
      new IdempotencyService(),
      new KardexService(new DrizzleKardexRepository(database)),
      output,
      operationsRepo,
      stockRepo,
    );
  }

  function offlineReconciliationService(
    output = outboxService,
  ): OfflineReconciliationService {
    return new OfflineReconciliationService(
      database,
      new IdempotencyService(),
      new KardexService(new DrizzleKardexRepository(database)),
      output,
      operationsRepo,
      stockRepo,
    );
  }

  function realCommandService(): InventoryCommandService {
    return new InventoryCommandService(
      database,
      new IdempotencyService(),
      outboxService,
      new DrizzleInboxRepository(database),
      operationsRepo,
      new DrizzleLocationsRepository(database),
      stockRepo,
    );
  }

  async function publishRecord(
    eventType: string,
    kind: 'event' | 'result' = 'event',
  ) {
    const eventId = randomUUID();
    const messageId = randomUUID();
    await database.transaction((tx) =>
      outboxRepo.enqueue(tx, {
        event_id: eventId,
        event_type: eventType,
        aggregate_type: 'integration-test',
        aggregate_id: eventId,
        payload: { message_id: messageId, kind, name: eventType, test: true },
      }),
    );
    const row = await database.query<{ id: string }>(
      `SELECT id FROM inventory.outbox WHERE event_id=$1`,
      [eventId],
    );
    return { eventId, messageId, id: row.rows[0].id };
  }

  it('HTTP real persiste reserva/consumo en PostgreSQL y entrega el resultado por RabbitMQ', async () => {
    const previousIssuer = process.env.G7_JWT_ISSUER;
    const previousDemo = process.env.INVENTORY_DEMO_NO_AUTH_ENABLED;
    let app: INestApplication | undefined;
    process.env.G7_JWT_ISSUER = TEST_ISSUER;
    process.env.INVENTORY_DEMO_NO_AUTH_ENABLED = 'false';
    InventoryAuthGuard.setTrustedPublicKey(TEST_PUBLIC_KEY);
    try {
      const module = await Test.createTestingModule({
        imports: [InventorySvcModule],
      })
        // Solo detenemos el scheduler: la DB, repositorios y publicación son reales.
        .overrideProvider(InventoryWorkersService)
        .useValue({})
        .compile();
      app = module.createNestApplication();
      app.useGlobalFilters(new ProblemDetailsFilter());
      await app.listen(0, '127.0.0.1');
      const origin = await app.getUrl();
      await request(origin)
        .get('/health')
        .expect(200)
        .expect({ status: 'ok', service: 'inventory-svc' });
      await request(origin)
        .get('/health/readiness')
        .expect(200)
        .expect({ status: 'ready', service: 'inventory-svc' });
      const token = createCryptographicJwt({ clientId: 'modulo-ventas' });
      const sku = await seedStock();
      const orderId = `PED-HTTP-${randomUUID()}`;
      const operationId = randomUUID();
      const correlation = randomUUID();
      await request(origin)
        .post('/api/v1/inventario/reservas')
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', operationId)
        .set('X-Correlation-Id', correlation)
        .send({
          operation_id: operationId,
          order_id: orderId,
          channel_id: 'MARKETPLACE',
          lines: [{ sku, quantity: 3, location_id: locationId }],
        })
        .expect(202);
      const durable = await request(origin)
        .get(`/api/v1/inventario/operaciones/${operationId}`)
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(durable.body).toMatchObject({
        status: 'COMPLETED',
        order_id: orderId,
      });
      const confirm = { operation_id: randomUUID(), order_id: orderId };
      const confirmPath = `/api/v1/inventario/reservas/${durable.body.reservation_id}/confirmar`;
      const first = await request(origin)
        .post(confirmPath)
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', confirm.operation_id)
        .set('X-Correlation-Id', correlation)
        .send(confirm)
        .expect(202);
      const retry = await request(origin)
        .post(confirmPath)
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', confirm.operation_id)
        .set('X-Correlation-Id', randomUUID())
        .send(confirm)
        .expect(202);
      expect(retry.body).toEqual(first.body);
      expect((await stockRepo.findBySkus([sku], locationId))[0]).toMatchObject({
        on_hand: 17,
        reserved: 0,
      });
      const kardex = await database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM inventory.kardex WHERE operation_id=$1 AND operation_type='CONSUMO'`,
        [confirm.operation_id],
      );
      expect(kardex.rows[0].count).toBe('1');
      await new OutboxPublisherService(database, outboxRepo).dispatchPending(
        10,
      );
      let consumedResult = false;
      for (;;) {
        const message = await brokerChannel.get(queue);
        if (!message) break;
        const payload = JSON.parse(message.content.toString('utf8'));
        if (
          payload.operation_id === confirm.operation_id &&
          payload.name === 'inventory.consumption.completed'
        ) {
          expect(payload).toMatchObject({
            correlation_id: correlation,
            data: {
              order_id: orderId,
              reservation_id: durable.body.reservation_id,
            },
          });
          consumedResult = true;
        }
        brokerChannel.ack(message);
      }
      expect(consumedResult).toBe(true);
    } finally {
      await app?.close();
      InventoryAuthGuard.setTrustedPublicKey(null);
      if (previousIssuer === undefined) delete process.env.G7_JWT_ISSUER;
      else process.env.G7_JWT_ISSUER = previousIssuer;
      if (previousDemo === undefined)
        delete process.env.INVENTORY_DEMO_NO_AUTH_ENABLED;
      else process.env.INVENTORY_DEMO_NO_AUTH_ENABLED = previousDemo;
    }
  }, 30_000);

  it('ejecuta Drizzle y acredita UPDATE RETURNING para cero y una fila', async () => {
    const sku = await seedStock();
    const existing = await database.transaction((tx) =>
      stockRepo.updateStock(tx, sku, locationId, {
        reserved: 1,
        stock_version: 1,
      }),
    );
    const missing = await database.transaction((tx) =>
      stockRepo.updateStock(tx, `missing-${randomUUID()}`, locationId, {
        reserved: 1,
        stock_version: 1,
      }),
    );
    const rows = await stockRepo.findBySkus([sku], locationId);
    expect(existing).toBe(1);
    expect(missing).toBe(0);
    expect(rows[0].reserved).toBe(1);

    const reservationId = randomUUID();
    const reservationInsert = await database.query<{ id: string }>(
      `INSERT INTO inventory.reservations(reservation_id,expires_at,idempotency_key,order_id) VALUES($1,now()+interval '1 minute',$2,$3) RETURNING id`,
      [reservationId, `status-${randomUUID()}`, `PED-${randomUUID()}`],
    );
    expect(
      await database.transaction((tx) =>
        reservationsRepo.updateStatus(
          tx,
          reservationInsert.rows[0].id,
          'LIBERADA',
        ),
      ),
    ).toBe(1);
    expect(
      await database.transaction((tx) =>
        reservationsRepo.updateStatus(tx, randomUUID(), 'LIBERADA'),
      ),
    ).toBe(0);
  });

  it('hace rollback completo ante falla SQL intermedia tras saldo y outbox', async () => {
    const sku = await seedStock();
    const rollbackReservationId = randomUUID();
    const rollbackKey = `rollback-${randomUUID()}`;
    const initialOutbox = await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM inventory.outbox',
    );
    await expect(
      database.transaction(async (tx) => {
        const affected = await stockRepo.updateStock(tx, sku, locationId, {
          reserved: 3,
          stock_version: 1,
        });
        expect(affected).toBe(1);
        await outboxRepo.enqueue(tx, {
          event_id: randomUUID(),
          event_type: 'inventory.test.rollback',
          aggregate_type: 'test',
          aggregate_id: sku,
          payload: { message_id: randomUUID(), kind: 'event' },
        });
        const inserted = await reservationsRepo.create(tx, {
          reservation_id: rollbackReservationId,
          status: 'ACTIVA',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          idempotency_key: rollbackKey,
          intention: 'reservar',
        });
        await reservationsRepo.updateStatus(tx, inserted, 'LIBERADA');
        await new DrizzleKardexRepository(database).createMovement(tx, {
          sku_id: sku,
          location_id: locationId,
          operation_type: 'LIBERACION',
          reservation_id: rollbackReservationId,
          quantity: -1,
          on_hand_before: 20,
          on_hand_after: 20,
          reserved_before: 1,
          reserved_after: 0,
          blocked_before: 0,
          blocked_after: 0,
          stock_version: 1,
        });
        await tx.query(
          'INSERT INTO inventory.table_does_not_exist(id) VALUES ($1)',
          [randomUUID()],
        );
      }),
    ).rejects.toThrow();
    const stock = await stockRepo.findBySkus([sku], locationId);
    const afterOutbox = await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM inventory.outbox',
    );
    const rollbackReservation = await database.query<{
      status: string;
      kardex: string;
    }>(
      `SELECT r.status,(SELECT count(*)::text FROM inventory.kardex k WHERE k.reservation_id=r.reservation_id) AS kardex FROM inventory.reservations r WHERE r.reservation_id=$1`,
      [rollbackReservationId],
    );
    const rollbackKardex = await database.query(
      `SELECT id FROM inventory.kardex WHERE reservation_id=$1`,
      [rollbackReservationId],
    );
    expect(stock[0].reserved).toBe(0);
    expect(stock[0].stock_version).toBe(0);
    expect(afterOutbox.rows[0].count).toBe(initialOutbox.rows[0].count);
    expect(rollbackReservation.rowCount).toBe(0);
    expect(rollbackKardex.rowCount).toBe(0);
  });

  it('rechaza order_id incorrecto en confirmar/liberar sin efectos secundarios', async () => {
    for (const action of ['confirm', 'release'] as const) {
      const sku = await seedStock();
      const { reservationId, order } = await reserve(sku);
      const before = await database.query(
        `SELECT r.status,b.on_hand,b.reserved,(SELECT count(*) FROM inventory.kardex WHERE reservation_id=r.reservation_id) AS kardex,(SELECT count(*) FROM inventory.outbox WHERE aggregate_id=r.reservation_id::text) AS outbox FROM inventory.reservations r JOIN inventory.reservation_lines l ON l.reservation_id=r.id JOIN inventory.stock_balance b ON b.sku_id=l.sku_id AND b.location_id=l.location_id WHERE r.reservation_id=$1`,
        [reservationId],
      );
      const wrong = { order_id: `${order}-wrong`, operation_id: randomUUID() };
      const invoke =
        action === 'confirm'
          ? reservations.confirmarReserva(
              reservationId,
              wrong,
              undefined,
              `idem-${randomUUID()}`,
              'modulo-ventas',
            )
          : reservations.liberarReserva(
              reservationId,
              { ...wrong, reason: 'ANULACION' },
              undefined,
              `idem-${randomUUID()}`,
              'modulo-ventas',
            );
      await expect(invoke).rejects.toThrow();
      const after = await database.query(
        `SELECT r.status,b.on_hand,b.reserved,(SELECT count(*) FROM inventory.kardex WHERE reservation_id=r.reservation_id) AS kardex,(SELECT count(*) FROM inventory.outbox WHERE aggregate_id=r.reservation_id::text) AS outbox FROM inventory.reservations r JOIN inventory.reservation_lines l ON l.reservation_id=r.id JOIN inventory.stock_balance b ON b.sku_id=l.sku_id AND b.location_id=l.location_id WHERE r.reservation_id=$1`,
        [reservationId],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    }
  });

  it('confirma o libera concurrentemente una misma reserva solo una vez', async () => {
    for (const action of ['confirm', 'release'] as const) {
      const sku = await seedStock();
      const { reservationId, order } = await reserve(sku, 2);
      const invoke = () =>
        action === 'confirm'
          ? reservations.confirmarReserva(
              reservationId,
              { order_id: order, operation_id: randomUUID() },
              undefined,
              `idem-${randomUUID()}`,
              'modulo-ventas',
            )
          : reservations.liberarReserva(
              reservationId,
              {
                order_id: order,
                operation_id: randomUUID(),
                reason: 'ANULACION',
              },
              undefined,
              `idem-${randomUUID()}`,
              'modulo-ventas',
            );
      const results = await Promise.allSettled([invoke(), invoke()]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const row = await database.query<{
        status: string;
        on_hand: number;
        reserved: number;
      }>(
        `SELECT r.status,b.on_hand,b.reserved FROM inventory.reservations r JOIN inventory.reservation_lines l ON l.reservation_id=r.id JOIN inventory.stock_balance b ON b.sku_id=l.sku_id AND b.location_id=l.location_id WHERE r.reservation_id=$1`,
        [reservationId],
      );
      expect(row.rows[0].status).toBe(
        action === 'confirm' ? 'CONSUMIDA' : 'LIBERADA',
      );
      expect(row.rows[0].on_hand).toBe(action === 'confirm' ? 18 : 20);
      expect(row.rows[0].reserved).toBe(0);
    }
  });

  it('serializa reservas concurrentes e idempotencia concurrente en PostgreSQL', async () => {
    const sku = await seedStock(`concurrent-stock-${randomUUID()}`, 5);
    const req = () => ({
      order_id: `PED-${randomUUID()}`,
      operation_id: randomUUID(),
      channel_id: 'MARKETPLACE' as const,
      lines: [{ sku, quantity: 4, location_id: locationId }],
    });
    const results = await Promise.all(
      [req(), req()].map((dto) =>
        reservations.solicitarReserva(
          dto,
          undefined,
          `idem-${randomUUID()}`,
          'modulo-ventas',
        ),
      ),
    );
    const balance = await stockRepo.findBySkus([sku], locationId);
    expect(balance[0].reserved).toBe(4);
    expect(
      await database.query(
        `SELECT id FROM inventory.reservations WHERE reservation_id IN (SELECT reservation_id FROM inventory.inventory_operations WHERE operation_id = ANY($1::uuid[]))`,
        [results.map((r) => r.operation_id)],
      ),
    ).toMatchObject({ rowCount: 1 });

    const idemSku = await seedStock(`idempotent-stock-${randomUUID()}`, 100);
    const idemDto = {
      order_id: `PED-${randomUUID()}`,
      operation_id: randomUUID(),
      channel_id: 'MARKETPLACE' as const,
      lines: [{ sku: idemSku, quantity: 1, location_id: locationId }],
    };
    const key = `idem-${randomUUID()}`;
    const replay = await Promise.all([
      reservations.solicitarReserva(idemDto, undefined, key, 'modulo-ventas'),
      reservations.solicitarReserva(idemDto, undefined, key, 'modulo-ventas'),
    ]);
    expect(replay.map((r) => r.operation_id)).toEqual([
      idemDto.operation_id,
      idemDto.operation_id,
    ]);
    expect(replay[1]).toEqual(replay[0]);
    expect(
      await reservations.solicitarReserva(
        idemDto,
        undefined,
        key,
        'modulo-ventas',
      ),
    ).toEqual(replay[0]);
    const ops = await database.query(
      `SELECT id FROM inventory.inventory_operations WHERE operation_id=$1`,
      [idemDto.operation_id],
    );
    expect(ops.rowCount).toBe(1);

    const rejectedSku = await seedStock(`rejected-stock-${randomUUID()}`, 1);
    const rejectedDto = {
      order_id: `PED-${randomUUID()}`,
      operation_id: randomUUID(),
      channel_id: 'MARKETPLACE' as const,
      lines: [{ sku: rejectedSku, quantity: 2, location_id: locationId }],
    };
    const rejectedKey = `idem-${randomUUID()}`;
    const acceptedCommand = await reservations.solicitarReserva(
      rejectedDto,
      undefined,
      rejectedKey,
      'modulo-ventas',
    );
    expect(acceptedCommand.status).toBe('ACCEPTED');
    expect(
      await reservations.solicitarReserva(
        rejectedDto,
        undefined,
        rejectedKey,
        'modulo-ventas',
      ),
    ).toEqual(acceptedCommand);
    const rejectedOperation = await database.query<{
      status: string;
      result_code: string;
      result_payload: unknown;
    }>(
      `SELECT status,result_code,result_payload FROM inventory.inventory_operations WHERE operation_id=$1`,
      [rejectedDto.operation_id],
    );
    expect(rejectedOperation.rows[0]).toMatchObject({
      status: 'RECHAZADO',
      result_code: 'STOCK_INSUFICIENTE',
      result_payload: acceptedCommand,
    });
  });

  it('reproduce exactamente el replay concurrente durable al confirmar y liberar', async () => {
    for (const action of ['confirm', 'release'] as const) {
      const sku = await seedStock();
      const { reservationId, order } = await reserve(sku, 2);
      const request = {
        order_id: order,
        operation_id: randomUUID(),
        ...(action === 'release' ? { reason: 'ANULACION' as const } : {}),
      };
      const key = `idem-${randomUUID()}`;
      const invoke = () =>
        action === 'confirm'
          ? reservations.confirmarReserva(
              reservationId,
              request,
              undefined,
              key,
              'modulo-ventas',
            )
          : reservations.liberarReserva(
              reservationId,
              { ...request, reason: 'ANULACION' },
              undefined,
              key,
              'modulo-ventas',
            );
      const [first, replay] = await Promise.all([invoke(), invoke()]);
      expect(replay).toEqual(first);
      expect(await invoke()).toEqual(first);
      const persisted = await database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM inventory.inventory_operations WHERE operation_id=$1`,
        [request.operation_id],
      );
      expect(persisted.rows[0].count).toBe('1');
    }
  });

  it('expira automáticamente desde el worker Nest sin endpoint ni llamada manual', async () => {
    const sku = await seedStock();
    const { reservationId } = await reserve(sku, 3);
    await database.query(
      `UPDATE inventory.reservations SET expires_at=now()-interval '1 second' WHERE reservation_id=$1`,
      [reservationId],
    );
    const publisher = new OutboxPublisherService(database, outboxRepo);
    const workers = new InventoryWorkersService(expiration, publisher);
    workers.onModuleInit();
    try {
      await viWaitFor(async () => {
        const result = await database.query<{ status: string }>(
          `SELECT status FROM inventory.reservations WHERE reservation_id=$1`,
          [reservationId],
        );
        expect(result.rows[0].status).toBe('EXPIRADA');
      }, 10_000);
    } finally {
      await workers.onModuleDestroy();
    }
    const final = await database.query<{
      on_hand: number;
      reserved: number;
      kardex: string;
      events: string;
    }>(
      `SELECT b.on_hand,b.reserved,(SELECT count(*)::text FROM inventory.kardex WHERE reservation_id=r.reservation_id AND operation_type='EXPIRACION') AS kardex,(SELECT count(*)::text FROM inventory.outbox WHERE aggregate_id=r.reservation_id::text AND event_type='inventory.reservation.expired') AS events FROM inventory.reservations r JOIN inventory.reservation_lines l ON l.reservation_id=r.id JOIN inventory.stock_balance b ON b.sku_id=l.sku_id AND b.location_id=l.location_id WHERE r.reservation_id=$1`,
      [reservationId],
    );
    expect(final.rows[0]).toMatchObject({
      on_hand: 20,
      reserved: 0,
      kardex: '1',
      events: '1',
    });
  });

  it('serializa confirmar/liberar y expiración con una sola transición y efectos', async () => {
    for (const action of ['confirm', 'release'] as const) {
      const sku = await seedStock();
      const { reservationId, order } = await reserve(sku, 3);
      const lockHolder = new pg.Client({
        connectionString: process.env.DATABASE_URL,
      });
      const originalUpdateStatus =
        reservationsRepo.updateStatus.bind(reservationsRepo);
      let expiredTransitions = 0;
      reservationsRepo.updateStatus = async (client, reservationPk, status) => {
        if (status === 'EXPIRADA') expiredTransitions++;
        return originalUpdateStatus(client, reservationPk, status);
      };
      await lockHolder.connect();
      try {
        await lockHolder.query('BEGIN');
        await lockHolder.query(
          `SELECT id FROM inventory.reservations WHERE reservation_id=$1 FOR UPDATE`,
          [reservationId],
        );
        const operation =
          action === 'confirm'
            ? reservations.confirmarReserva(
                reservationId,
                { order_id: order, operation_id: randomUUID() },
                undefined,
                `idem-${randomUUID()}`,
                'modulo-ventas',
              )
            : reservations.liberarReserva(
                reservationId,
                {
                  order_id: order,
                  operation_id: randomUUID(),
                  reason: 'PAGO_NO_COMPLETADO',
                },
                undefined,
                `idem-${randomUUID()}`,
                'modulo-ventas',
              );
        await viWaitFor(async () => {
          const waiting = await database.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE '%FROM inventory.reservations%' AND query ILIKE '%FOR UPDATE%'`,
          );
          expect(Number(waiting.rows[0].count)).toBeGreaterThan(0);
        }, 5000);
        await lockHolder.query(
          `UPDATE inventory.reservations SET expires_at=now()-interval '1 second' WHERE reservation_id=$1`,
          [reservationId],
        );
        // Al vencer durante la espera del lock, el flujo de negocio debe
        // expirar dentro de su transacción antes de devolver el error.
        await lockHolder.query('COMMIT');
        const expirationRun = expiration.expirarReservasVencidas(10);
        await expect(operation).rejects.toThrow();
        await expirationRun;
      } finally {
        await lockHolder.query('ROLLBACK').catch(() => undefined);
        await lockHolder.end();
        reservationsRepo.updateStatus = originalUpdateStatus;
      }
      const state = await database.query<{
        status: string;
        on_hand: number;
        reserved: number;
        expired_movements: string;
        released_movements: string;
        released_events: string;
        expired_events: string;
      }>(
        `SELECT r.status,b.on_hand,b.reserved,(SELECT count(*)::text FROM inventory.kardex WHERE reservation_id=r.reservation_id AND operation_type='EXPIRACION') AS expired_movements,(SELECT count(*)::text FROM inventory.kardex WHERE reservation_id=r.reservation_id AND operation_type='LIBERACION') AS released_movements,(SELECT count(*)::text FROM inventory.outbox WHERE aggregate_id=r.reservation_id::text AND event_type='inventory.reservation.released') AS released_events,(SELECT count(*)::text FROM inventory.outbox WHERE aggregate_id=r.reservation_id::text AND event_type='inventory.reservation.expired') AS expired_events FROM inventory.reservations r JOIN inventory.reservation_lines l ON l.reservation_id=r.id JOIN inventory.stock_balance b ON b.sku_id=l.sku_id AND b.location_id=l.location_id WHERE r.reservation_id=$1`,
        [reservationId],
      );
      expect(state.rows[0]).toMatchObject({
        status: 'EXPIRADA',
        on_hand: 20,
        reserved: 0,
        expired_movements: '1',
        released_movements: '0',
        released_events: '0',
        expired_events: '1',
      });
      expect(expiredTransitions).toBe(1);
    }
  });

  it('usa publisher confirm, marca solo mensaje enrutado y deja basic.return como PENDING', async () => {
    await database.query('DELETE FROM inventory.outbox');
    const publisher = new OutboxPublisherService(database, outboxRepo);
    const routed = await publishRecord('inventory.integration.routed');
    const unrouted = await publishRecord(
      `integration.unrouted.${randomUUID()}`,
    );
    const result = await publisher.dispatchPending(100);
    expect(result.dispatched).toBeGreaterThanOrEqual(1);
    const statuses = await database.query<{ id: string; status: string }>(
      `SELECT id,status FROM inventory.outbox WHERE id=ANY($1::uuid[])`,
      [[routed.id, unrouted.id]],
    );
    expect(statuses.rows.find((r) => r.id === routed.id)?.status).toBe(
      'PUBLISHED',
    );
    expect(statuses.rows.find((r) => r.id === unrouted.id)?.status).toBe(
      'PENDING',
    );
    await database.query(`DELETE FROM inventory.outbox WHERE id=$1`, [
      unrouted.id,
    ]);
    const message = await brokerChannel.get(queue);
    expect(message && message.properties.messageId).toBeTruthy();
    if (message) brokerChannel.ack(message);
  });

  it('coordina dos dispatchers y recupera el evento pendiente tras indisponibilidad del broker', async () => {
    await database.query('DELETE FROM inventory.outbox');
    const a = await publishRecord('inventory.integration.concurrent.a');
    const b = await publishRecord('inventory.integration.concurrent.b');
    const one = new OutboxPublisherService(database, outboxRepo);
    const two = new OutboxPublisherService(database, outboxRepo);
    const [ra, rb] = await Promise.all([
      one.dispatchPending(1),
      two.dispatchPending(1),
    ]);
    const concurrentStatuses = await database.query<{
      id: string;
      status: string;
    }>(`SELECT id,status FROM inventory.outbox WHERE id=ANY($1::uuid[])`, [
      [a.id, b.id],
    ]);
    expect(
      concurrentStatuses.rows.every((row) => row.status === 'PUBLISHED'),
    ).toBe(true);
    expect(ra.dispatched + rb.dispatched).toBe(2);

    const pending = await publishRecord('inventory.integration.recovery');
    const ownedLabels = docker([
      'inspect',
      '--format',
      '{{json .Config.Labels}}',
      rabbitContainer,
    ]);
    expect(JSON.parse(ownedLabels)['inventory.integration.run']).toBe(runId);
    // Pausa únicamente el broker efímero mientras el dispatcher intenta
    // conectarse; el proceso/volumen de RabbitMQ permanece bajo este test.
    await brokerChannel.close();
    await broker.close();
    docker(['pause', rabbitContainer]);
    try {
      const downResult = await new OutboxPublisherService(
        database,
        outboxRepo,
      ).dispatchPending(10);
      expect(downResult.skipped).toBe(true);
      expect(
        (
          await database.query<{ status: string }>(
            `SELECT status FROM inventory.outbox WHERE id=$1`,
            [pending.id],
          )
        ).rows[0].status,
      ).toBe('PENDING');
    } finally {
      docker(['unpause', rabbitContainer]);
    }

    // El dispatcher de aplicación se recrea y retoma la fila durable tras
    // recuperarse el broker; RabbitMQ sigue siendo el recurso efímero propio.
    broker = await amqp.connect(rabbitUrl);
    brokerChannel = await broker.createChannel();
    await brokerChannel.assertQueue(queue, {
      durable: false,
      exclusive: true,
      autoDelete: true,
    });
    await brokerChannel.bindQueue(queue, exchangeEvents, 'inventory.#');
    await brokerChannel.bindQueue(queue, exchangeResults, 'inventory.#');
    const recovered = await new OutboxPublisherService(
      database,
      outboxRepo,
    ).dispatchPending(10);
    expect(recovered.dispatched).toBeGreaterThanOrEqual(1);
    expect(
      (
        await database.query<{ status: string }>(
          `SELECT status FROM inventory.outbox WHERE id=$1`,
          [pending.id],
        )
      ).rows[0].status,
    ).toBe('PUBLISHED');
    let recoveredMessageId: string | undefined;
    for (;;) {
      const message = await brokerChannel.get(queue);
      if (!message) break;
      if (message.properties.messageId === pending.messageId) {
        recoveredMessageId = message.properties.messageId;
      }
      brokerChannel.ack(message);
    }
    expect(recoveredMessageId).toBe(pending.messageId);
    expect([a.id, b.id]).toHaveLength(2);
  }, 30_000);

  it('simula caída tras confirmación antes de UPDATE y reintenta con el mismo message_id', async () => {
    await database.query('DELETE FROM inventory.outbox');
    const pending = await publishRecord('inventory.integration.crash');
    const crashingRepo = Object.create(outboxRepo) as DrizzleOutboxRepository;
    crashingRepo.markAsPublished = async (id, client) => {
      if (id === pending.id) {
        await client!.query(
          'INSERT INTO inventory.table_does_not_exist(id) VALUES ($1)',
          [randomUUID()],
        );
        return;
      }
      await outboxRepo.markAsPublished(id, client);
    };
    const failed = await new OutboxPublisherService(
      database,
      crashingRepo,
    ).dispatchPending(10);
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    expect(
      (
        await database.query<{ status: string }>(
          `SELECT status FROM inventory.outbox WHERE id=$1`,
          [pending.id],
        )
      ).rows[0].status,
    ).toBe('PENDING');
    let firstDelivery = false;
    for (;;) {
      const msg = await brokerChannel.get(queue);
      if (!msg) break;
      if (msg.properties.messageId === pending.messageId) firstDelivery = true;
      brokerChannel.ack(msg);
    }
    expect(firstDelivery).toBe(true);
    await database.query(
      `UPDATE inventory.outbox SET created_at=now()-interval '1 day' WHERE id=$1`,
      [pending.id],
    );
    const healthy = await new OutboxPublisherService(
      database,
      outboxRepo,
    ).dispatchPending(1);
    expect(healthy.dispatched).toBe(1);
    await new OutboxPublisherService(database, outboxRepo).dispatchPending(10);
    let found = false;
    for (;;) {
      const msg = await brokerChannel.get(queue);
      if (!msg) break;
      if (msg.properties.messageId === pending.messageId) found = true;
      brokerChannel.ack(msg);
    }
    expect(found).toBe(true);
  });

  describe('Consumer real — ACK durable, deduplicación y recuperación (#102/#103)', () => {
    function initializationCommand(
      defaultLocation: string | null = locationId,
    ) {
      return {
        message_id: randomUUID(),
        operation_id: randomUUID(),
        correlation_id: randomUUID(),
        schema_version: 2,
        occurred_at: new Date().toISOString(),
        producer: 'catalog-svc',
        kind: 'command',
        name: initializationKey,
        data: {
          sku: `sku-consumer-${randomUUID()}`,
          product_id: `product-${randomUUID()}`,
          default_location_id: defaultLocation,
        },
      };
    }

    function realConsumer() {
      return new InventoryConsumerService(
        new InventoryCommandService(
          database,
          new IdempotencyService(),
          outboxService,
          new DrizzleInboxRepository(database),
          operationsRepo,
          new DrizzleLocationsRepository(database),
          stockRepo,
        ),
      );
    }

    async function publishCommand(
      writer: amqp.ConfirmChannel,
      content: Buffer,
      messageId: string,
    ): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        writer.publish(
          exchangeCommands,
          initializationKey,
          content,
          { persistent: true, mandatory: true, messageId },
          (error: Error | null) => (error ? reject(error) : resolve()),
        );
      });
    }

    it('consume, confirma duplicados y rechazos durables sin duplicar saldo ni operación', async () => {
      const consumer = realConsumer();
      const writer = await broker.createConfirmChannel();
      const first = initializationCommand();
      const replay = { ...first, message_id: randomUUID() };
      const rejected = initializationCommand(randomUUID());
      const withoutLocation = initializationCommand(null);
      try {
        expect(
          (await brokerChannel.checkQueue('po.inventario.q')).messageCount,
        ).toBe(0);
        await consumer.start();
        expect(consumer.getMetrics().connected).toBe(true);
        for (const [index, command] of [
          first,
          first,
          replay,
          rejected,
          withoutLocation,
        ].entries()) {
          await publishCommand(
            writer,
            Buffer.from(JSON.stringify(command)),
            command.message_id,
          );
          await viWaitFor(async () => {
            expect(consumer.getMetrics().acknowledged).toBe(index + 1);
          }, 5000);
        }
        expect(consumer.getMetrics()).toMatchObject({
          received: 5,
          acknowledged: 5,
          duplicates: 1,
          rejected: 1,
          failures: 0,
          paused: false,
        });
        const inbox = await database.query<{
          message_id: string;
          status: string;
        }>(
          `SELECT message_id,status FROM inventory.inbox WHERE message_id=ANY($1::uuid[])`,
          [
            [
              first.message_id,
              replay.message_id,
              rejected.message_id,
              withoutLocation.message_id,
            ],
          ],
        );
        expect(inbox.rows).toHaveLength(4);
        expect(inbox.rows.every((row) => row.status === 'PROCESSED')).toBe(
          true,
        );
        const operations = await database.query<{
          operation_id: string;
          status: string;
          result_code: string | null;
        }>(
          `SELECT operation_id,status,result_code FROM inventory.inventory_operations WHERE operation_id=ANY($1::uuid[])`,
          [
            [
              first.operation_id,
              rejected.operation_id,
              withoutLocation.operation_id,
            ],
          ],
        );
        expect(operations.rows).toHaveLength(3);
        expect(operations.rows).toContainEqual({
          operation_id: first.operation_id,
          status: 'APLICADO',
          result_code: null,
        });
        expect(operations.rows).toContainEqual({
          operation_id: rejected.operation_id,
          status: 'RECHAZADO',
          result_code: 'UBICACION_NO_ENCONTRADA',
        });
        expect(operations.rows).toContainEqual({
          operation_id: withoutLocation.operation_id,
          status: 'APLICADO',
          result_code: null,
        });
        expect(
          await stockRepo.findBySkus([first.data.sku], locationId),
        ).toMatchObject([
          { on_hand: 0, reserved: 0, blocked: 0, stock_version: 0 },
        ]);
        expect(await stockRepo.findBySkus([rejected.data.sku])).toHaveLength(0);
        expect(
          await stockRepo.findBySkus([withoutLocation.data.sku]),
        ).toHaveLength(0);
        const events = await database.query<{
          event_type: string;
          count: string;
        }>(
          `SELECT event_type,count(*)::text AS count FROM inventory.outbox WHERE aggregate_id=$1 GROUP BY event_type`,
          [first.data.sku],
        );
        expect(events.rows).toHaveLength(2);
        expect(events.rows).toContainEqual({
          event_type: 'inventory.stock.changed',
          count: '1',
        });
        expect(events.rows).toContainEqual({
          event_type: 'inventory.sku.initialization.completed',
          count: '2',
        });
      } finally {
        await consumer.onModuleDestroy();
        await writer.close();
      }
      // Tras cerrar el canal, ningún mensaje confirmado debe reaparecer.
      // El cierre de la conexión y la baja en la cola se observan por canales
      // distintos; esperar ambas condiciones sin relajar ninguna aserción.
      await viWaitFor(async () => {
        expect(await brokerChannel.checkQueue('po.inventario.q')).toMatchObject(
          {
            messageCount: 0,
            consumerCount: 0,
          },
        );
      }, 5000);
    }, 30_000);

    it('retiene JSON inválido sin ACK y reanuda solo tras retirar el fixture defectuoso', async () => {
      const consumer = realConsumer();
      const writer = await broker.createConfirmChannel();
      const invalidId = randomUUID();
      const invalid = Buffer.from('fixture-sintetico-json-invalido');
      try {
        expect(
          (await brokerChannel.checkQueue('po.inventario.q')).messageCount,
        ).toBe(0);
        await consumer.start();
        await publishCommand(writer, invalid, invalidId);
        await viWaitFor(async () => {
          expect(consumer.getMetrics()).toMatchObject({
            paused: true,
            pauseReason: 'INVALID_MESSAGE',
            acknowledged: 0,
            failures: 1,
          });
          expect(
            await brokerChannel.checkQueue('po.inventario.q'),
          ).toMatchObject({
            consumerCount: 0,
            messageCount: 1,
          });
        }, 5000);
        const pending = await brokerChannel.get('po.inventario.q', {
          noAck: false,
        });
        expect(pending).not.toBe(false);
        if (!pending) throw new Error('El broker perdió el fixture sin ACK');
        expect(pending.properties.messageId).toBe(invalidId);
        expect(pending.fields.redelivered).toBe(true);
        expect(pending.content.equals(invalid)).toBe(true);
        const persisted = await database.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM inventory.inbox WHERE message_id=$1`,
          [invalidId],
        );
        expect(persisted.rows[0].count).toBe('0');
        // Retirada explícita del fixture corrupto en el vhost propio; no es una
        // política de descarte, retry o recuperación para mensajes productivos.
        brokerChannel.ack(pending);
        await consumer.resume();
        const next = initializationCommand();
        await publishCommand(
          writer,
          Buffer.from(JSON.stringify(next)),
          next.message_id,
        );
        await viWaitFor(async () => {
          expect(consumer.getMetrics()).toMatchObject({
            received: 2,
            acknowledged: 1,
            paused: false,
            failures: 1,
          });
        }, 5000);
        expect(
          await stockRepo.findBySkus([next.data.sku], locationId),
        ).toHaveLength(1);
      } finally {
        await consumer.onModuleDestroy();
        await writer.close();
      }
      await viWaitFor(async () => {
        expect(await brokerChannel.checkQueue('po.inventario.q')).toMatchObject(
          {
            messageCount: 0,
            consumerCount: 0,
          },
        );
      }, 5000);
    }, 30_000);
  });

  describe('Motores nuevos — integración real PostgreSQL/RabbitMQ', () => {
    it('ajuste absoluto aplica, deduplica, rechaza versiones/targets y serializa concurrencia', async () => {
      const sku = await seedStock(`sku-absolute-${randomUUID()}`, 20);
      await database.query(
        `UPDATE inventory.stock_balance SET reserved=3, blocked=2 WHERE sku_id=$1 AND location_id=$2`,
        [sku, locationId],
      );
      const input = {
        operation_id: randomUUID(),
        sku,
        location_id: locationId,
        expected_stock_version: 0,
        target_on_hand: 18,
      };
      const service = absoluteAdjustmentService();
      const applied = await service.apply(input);
      expect(applied).toMatchObject({
        status: 'APPLIED',
        on_hand: 18,
        reserved: 3,
        blocked: 2,
        available: 13,
        stock_version: 1,
      });
      expect(await service.apply(input)).toEqual(applied);

      const stale = await service.apply({
        ...input,
        operation_id: randomUUID(),
        target_on_hand: 17,
      });
      expect(stale).toMatchObject({
        status: 'REJECTED',
        code: 'VERSION_STALE',
      });
      const underCommitted = await service.apply({
        ...input,
        operation_id: randomUUID(),
        expected_stock_version: 1,
        target_on_hand: 4,
      });
      expect(underCommitted).toMatchObject({
        status: 'REJECTED',
        code: 'TARGET_BELOW_COMMITTED_UNITS',
      });

      const concurrent = await Promise.all([
        service.apply({
          ...input,
          operation_id: randomUUID(),
          expected_stock_version: 1,
          target_on_hand: 16,
        }),
        service.apply({
          ...input,
          operation_id: randomUUID(),
          expected_stock_version: 1,
          target_on_hand: 17,
        }),
      ]);
      expect(
        concurrent.filter((result) => result.status === 'APPLIED'),
      ).toHaveLength(1);
      expect(
        concurrent.filter((result) => result.code === 'VERSION_STALE'),
      ).toHaveLength(1);
      const durable = await database.query<{
        on_hand: number;
        reserved: number;
        blocked: number;
        available: number;
        stock_version: number;
        kardex: number;
        outbox: number;
      }>(
        `SELECT b.on_hand,b.reserved,b.blocked,b.available,b.stock_version::int AS stock_version,
                (SELECT count(*)::int FROM inventory.kardex k WHERE k.sku_id=b.sku_id AND k.location_id=b.location_id AND k.operation_type='AJUSTE_ABSOLUTO') AS kardex,
                (SELECT count(*)::int FROM inventory.outbox o WHERE o.event_type='inventory.stock.changed' AND o.payload->'data'->>'sku'=b.sku_id) AS outbox
           FROM inventory.stock_balance b WHERE b.sku_id=$1 AND b.location_id=$2`,
        [sku, locationId],
      );
      expect(durable.rows[0]).toMatchObject({
        reserved: 3,
        blocked: 2,
        stock_version: 2,
        kardex: 2,
        outbox: 2,
      });
    }, 20_000);

    it('ajuste absoluto revierte stock, operación, Kardex y Outbox ante fallo', async () => {
      const sku = await seedStock(`sku-absolute-rollback-${randomUUID()}`, 8);
      const failOutbox = Object.create(outboxService) as OutboxService;
      failOutbox.stockChanged = async () => {
        throw new Error('fallo controlado antes del commit');
      };
      const operationId = randomUUID();
      const service = absoluteAdjustmentService(failOutbox);
      await expect(
        service.apply({
          operation_id: operationId,
          sku,
          location_id: locationId,
          expected_stock_version: 0,
          target_on_hand: 5,
        }),
      ).rejects.toThrow('fallo controlado');
      const result = await database.query<{
        on_hand: number;
        stock_version: number;
      }>(
        `SELECT on_hand,stock_version::int AS stock_version FROM inventory.stock_balance WHERE sku_id=$1 AND location_id=$2`,
        [sku, locationId],
      );
      expect(result.rows[0]).toEqual({ on_hand: 8, stock_version: 0 });
      for (const table of [
        'inventory.inventory_operations',
        'inventory.kardex',
      ]) {
        const found = await database.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM ${table} WHERE operation_id=$1`,
          [operationId],
        );
        expect(found.rows[0].count).toBe(0);
      }
    });

    it('conciliación offline protege reservas/bloqueos, aplica parcial y deduplica por venta', async () => {
      const sku = await seedStock(`sku-offline-${randomUUID()}`, 12);
      await database.query(
        `UPDATE inventory.stock_balance SET reserved=3,blocked=2 WHERE sku_id=$1 AND location_id=$2`,
        [sku, locationId],
      );
      const context = {
        client_id: 'modulo-ventas' as const,
        actor_ref: 'VENTAS-IT-ACTOR',
        store_ref: 'VENTAS-IT-STORE',
        location_id: locationId,
        authorized: true as const,
      };
      const request: ConciliacionOfflineRequest = {
        operation_id: randomUUID(),
        order_id: `order-offline-${randomUUID()}`,
        offline_sale_id: `sale-${randomUUID()}`,
        channel_id: 'RETAIL',
        occurred_at: new Date().toISOString(),
        lines: [{ sku, quantity: 10, location_id: locationId }],
      };
      const service = offlineReconciliationService();
      const [first, concurrentReplay] = await Promise.all([
        service.reconcileResolvedSale('modulo-ventas', request, context),
        service.reconcileResolvedSale('modulo-ventas', request, context),
      ]);
      expect(first).toMatchObject({
        status: 'REQUIRES_REVIEW',
        lines: [
          {
            requested_quantity: 10,
            applied_quantity: 7,
            unresolved_quantity: 3,
            on_hand: 5,
            reserved: 3,
            blocked: 2,
          },
        ],
      });
      expect(concurrentReplay).toEqual(first);
      const otherOperationReplay = await service.reconcileResolvedSale(
        'modulo-ventas',
        { ...request, operation_id: randomUUID() },
        context,
      );
      expect(otherOperationReplay).toEqual(first);
      await expect(
        service.reconcileResolvedSale(
          'modulo-ventas',
          {
            ...request,
            lines: [{ sku, quantity: 9, location_id: locationId }],
          },
          context,
        ),
      ).rejects.toThrow(/otro contenido/);
      const physical = await database.query<{
        on_hand: number;
        reserved: number;
        blocked: number;
        kardex: number;
        sales: number;
      }>(
        `SELECT b.on_hand,b.reserved,b.blocked,
                (SELECT count(*)::int FROM inventory.kardex WHERE operation_id=$3 AND operation_type='CONCILIACION_OFFLINE') AS kardex,
                (SELECT count(*)::int FROM inventory.offline_sale_reconciliations WHERE offline_sale_id=$4) AS sales
           FROM inventory.stock_balance b WHERE b.sku_id=$1 AND b.location_id=$2`,
        [sku, locationId, request.operation_id, request.offline_sale_id],
      );
      expect(physical.rows[0]).toEqual({
        on_hand: 5,
        reserved: 3,
        blocked: 2,
        kardex: 1,
        sales: 1,
      });
    }, 20_000);

    it('conciliación sin saldo informa revisión y rollback integral preserva evidencia durable', async () => {
      const context = {
        client_id: 'modulo-ventas' as const,
        actor_ref: 'VENTAS-IT-ACTOR',
        store_ref: 'VENTAS-IT-STORE',
        location_id: locationId,
        authorized: true as const,
      };
      const noBalance: ConciliacionOfflineRequest = {
        operation_id: randomUUID(),
        order_id: `order-${randomUUID()}`,
        offline_sale_id: `sale-${randomUUID()}`,
        channel_id: 'RETAIL',
        occurred_at: new Date().toISOString(),
        lines: [
          {
            sku: `sku-missing-${randomUUID()}`,
            quantity: 2,
            location_id: locationId,
          },
        ],
      };
      const service = offlineReconciliationService();
      const result = await service.reconcileResolvedSale(
        'modulo-ventas',
        noBalance,
        context,
      );
      expect(result).toMatchObject({
        status: 'REQUIRES_REVIEW',
        lines: [{ applied_quantity: 0, unresolved_quantity: 2 }],
      });
      expect(
        await database
          .query(`SELECT id FROM inventory.kardex WHERE operation_id=$1`, [
            noBalance.operation_id,
          ])
          .then((res) => res.rowCount),
      ).toBe(0);
      await expect(
        service.reconcileResolvedSale(
          'modulo-ventas',
          {
            ...noBalance,
            offline_sale_id: `sale-${randomUUID()}`,
            lines: [
              {
                ...noBalance.lines[0],
                location_id: '00000000-0000-4000-8000-000000000000',
              },
            ],
          },
          { ...context, location_id: '00000000-0000-4000-8000-000000000000' },
        ),
      ).rejects.toThrow(/Ubicación resuelta no activa/);

      const sku = await seedStock(`sku-offline-rollback-${randomUUID()}`, 8);
      const rollbackRequest: ConciliacionOfflineRequest = {
        ...noBalance,
        operation_id: randomUUID(),
        order_id: `order-${randomUUID()}`,
        offline_sale_id: `sale-${randomUUID()}`,
        lines: [{ sku, quantity: 2, location_id: locationId }],
      };
      const failingOutbox = Object.create(outboxService) as OutboxService;
      failingOutbox.stockChanged = async () => {
        throw new Error('fallo outbox conciliación');
      };
      await expect(
        offlineReconciliationService(failingOutbox).reconcileResolvedSale(
          'modulo-ventas',
          rollbackRequest,
          context,
        ),
      ).rejects.toThrow('fallo outbox conciliación');
      const stock = await database.query<{ on_hand: number }>(
        `SELECT on_hand FROM inventory.stock_balance WHERE sku_id=$1 AND location_id=$2`,
        [sku, locationId],
      );
      expect(stock.rows[0].on_hand).toBe(8);
      expect(
        (
          await database.query(
            `SELECT offline_sale_id FROM inventory.offline_sale_reconciliations WHERE offline_sale_id=$1`,
            [rollbackRequest.offline_sale_id],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await database.query(
            `SELECT operation_id FROM inventory.inventory_operations WHERE operation_id=$1`,
            [rollbackRequest.operation_id],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await database.query(
            `SELECT id FROM inventory.kardex WHERE operation_id=$1`,
            [rollbackRequest.operation_id],
          )
        ).rowCount,
      ).toBe(0);
    }, 20_000);

    it('evento Catalog tipado versiona lifecycle, no toca stock y preserva reservas previas', async () => {
      const sku = await seedStock(`sku-deactivate-${randomUUID()}`, 20);
      const existingReservation = await reserve(sku, 2);
      const command = realCommandService();
      const changedAt = new Date().toISOString();
      const productId = randomUUID();
      const event = catalogPr185SkuDeactivatedEvent({
        sku,
        productId,
        skuVersion: 3,
        changedAt,
      });
      await database.query(
        `INSERT INTO inventory.commercial_fulfillment_routes(channel_id,mode,fulfillment_ref,location_id)
         VALUES('MARKETPLACE','ENVIO_DOMICILIO',$1,$2)`,
        [`sku-deactivate-${randomUUID()}`, locationId],
      );
      const previousGate =
        process.env.INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED;
      process.env.INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED = 'true';
      try {
        expect(
          await availability.consultarDisponibilidadComercial(
            [sku],
            'MARKETPLACE',
          ),
        ).toEqual({ items: [{ sku, status: 'DISPONIBLE' }] });
        expect(await command.process(event)).toEqual({ duplicate: false });
        expect(await command.process(event)).toEqual({ duplicate: true });
        const oldVersion = {
          ...event,
          message_id: randomUUID(),
          operation_id: randomUUID(),
          data: {
            ...event.data,
            sku_version: 2,
            changed_at: new Date(Date.now() - 1000).toISOString(),
          },
        };
        expect(await command.process(oldVersion)).toEqual({ duplicate: false });
        const lifecycle = await database.query<{
          sku_version: number;
          active: boolean;
        }>(
          `SELECT sku_version,active FROM inventory.sku_lifecycle WHERE sku_id=$1`,
          [sku],
        );
        expect(lifecycle.rows[0]).toEqual({ sku_version: 3, active: false });
        expect(
          await availability.consultarDisponibilidadComercial(
            [sku],
            'MARKETPLACE',
          ),
        ).toEqual({ items: [{ sku, status: 'INDETERMINADO' }] });
        await expect(
          command.process({
            ...event,
            message_id: randomUUID(),
            operation_id: randomUUID(),
            data: {
              ...event.data,
              changed_at: new Date(Date.now() + 1000).toISOString(),
            },
          }),
        ).rejects.toMatchObject({ reason: 'INVALID_MESSAGE' });
        const legacyMessageId = randomUUID();
        await expect(
          command.process({
            ...event,
            message_id: legacyMessageId,
            operation_id: randomUUID(),
            data: {
              product_id: productId,
              variant_id: randomUUID(),
              sku,
            },
          }),
        ).rejects.toMatchObject({ reason: 'INVALID_MESSAGE' });
        expect(
          (
            await database.query(
              `SELECT message_id FROM inventory.inbox WHERE message_id=$1`,
              [legacyMessageId],
            )
          ).rowCount,
        ).toBe(0);
        const attemptId = randomUUID();
        await reservations.solicitarReserva(
          {
            order_id: `PED-INACTIVE-${randomUUID()}`,
            operation_id: attemptId,
            channel_id: 'MARKETPLACE',
            lines: [{ sku, quantity: 1, location_id: locationId }],
          },
          undefined,
          `idem-${randomUUID()}`,
          'modulo-ventas',
        );
        expect(
          (
            await database.query<{ result_code: string }>(
              `SELECT result_code FROM inventory.inventory_operations WHERE operation_id=$1`,
              [attemptId],
            )
          ).rows[0].result_code,
        ).toBe('SKU_INACTIVO');
        const current = await database.query<{
          on_hand: number;
          reserved: number;
        }>(
          `SELECT on_hand,reserved FROM inventory.stock_balance WHERE sku_id=$1 AND location_id=$2`,
          [sku, locationId],
        );
        expect(current.rows[0]).toEqual({ on_hand: 20, reserved: 2 });
        await reservations.confirmarReserva(
          existingReservation.reservationId,
          { order_id: existingReservation.order, operation_id: randomUUID() },
          undefined,
          `idem-${randomUUID()}`,
          'modulo-ventas',
        );
        expect(
          (
            await database.query<{ on_hand: number; reserved: number }>(
              `SELECT on_hand,reserved FROM inventory.stock_balance WHERE sku_id=$1 AND location_id=$2`,
              [sku, locationId],
            )
          ).rows[0],
        ).toEqual({ on_hand: 18, reserved: 0 });
      } finally {
        if (previousGate === undefined)
          delete process.env.INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED;
        else
          process.env.INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED = previousGate;
      }
    }, 20_000);

    it('serializa reserva contra baja y revierte una entrega cuyo commit de Inbox falla', async () => {
      const sku = await seedStock(`sku-deactivate-race-${randomUUID()}`, 9);
      const event = {
        message_id: randomUUID(),
        operation_id: randomUUID(),
        correlation_id: randomUUID(),
        occurred_at: new Date().toISOString(),
        schema_version: 1,
        kind: 'event',
        producer: 'catalog-svc',
        name: 'catalog.sku.deactivated',
        data: {
          sku,
          product_id: randomUUID(),
          sku_version: 2,
          changed_at: new Date().toISOString(),
        },
      };
      const gate = process.env.INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED;
      process.env.INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED = 'true';
      try {
        const failingInbox = Object.create(
          new DrizzleInboxRepository(database),
        ) as DrizzleInboxRepository;
        failingInbox.markProcessed = async () => {
          throw new Error('fallo de commit Inbox');
        };
        const failingCommand = new InventoryCommandService(
          database,
          new IdempotencyService(),
          outboxService,
          failingInbox,
          operationsRepo,
          new DrizzleLocationsRepository(database),
          stockRepo,
        );
        await expect(failingCommand.process(event)).rejects.toThrow(
          'fallo de commit Inbox',
        );
        expect(
          (
            await database.query(
              `SELECT sku_id FROM inventory.sku_lifecycle WHERE sku_id=$1`,
              [sku],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await database.query(
              `SELECT message_id FROM inventory.inbox WHERE message_id=$1`,
              [event.message_id],
            )
          ).rowCount,
        ).toBe(0);

        const reserveOperationId = randomUUID();
        await Promise.all([
          realCommandService().process(event),
          reservations.solicitarReserva(
            {
              order_id: `PED-DEACTIVATE-RACE-${randomUUID()}`,
              operation_id: reserveOperationId,
              channel_id: 'MARKETPLACE',
              lines: [{ sku, quantity: 2, location_id: locationId }],
            },
            undefined,
            `idem-${randomUUID()}`,
            'modulo-ventas',
          ),
        ]);
        expect(
          (
            await database.query<{ active: boolean; sku_version: number }>(
              `SELECT active,sku_version FROM inventory.sku_lifecycle WHERE sku_id=$1`,
              [sku],
            )
          ).rows[0],
        ).toEqual({ active: false, sku_version: 2 });
        const result = await database.query<{
          status: string;
          result_code: string | null;
        }>(
          `SELECT status,result_code FROM inventory.inventory_operations WHERE operation_id=$1`,
          [reserveOperationId],
        );
        expect(['APLICADO', 'RECHAZADO']).toContain(result.rows[0].status);
        if (result.rows[0].status === 'RECHAZADO') {
          expect(result.rows[0].result_code).toBe('SKU_INACTIVO');
        }
        const balance = await database.query<{
          on_hand: number;
          reserved: number;
        }>(
          `SELECT on_hand,reserved FROM inventory.stock_balance WHERE sku_id=$1 AND location_id=$2`,
          [sku, locationId],
        );
        expect(balance.rows[0].on_hand).toBe(9);
        expect([0, 2]).toContain(balance.rows[0].reserved);
      } finally {
        if (gate === undefined)
          delete process.env.INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED;
        else process.env.INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED = gate;
      }
    }, 20_000);

    it('gate AMQP de baja conserva mensaje sin ACK y reanuda tras habilitación', async () => {
      const sku = await seedStock(`sku-gated-${randomUUID()}`, 5);
      const event = catalogPr185SkuDeactivatedEvent({
        sku,
        productId: randomUUID(),
        skuVersion: 2,
        changedAt: new Date().toISOString(),
      });
      const gate = process.env.INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED;
      const consumer = new InventoryConsumerService(realCommandService());
      const writer = await broker.createConfirmChannel();
      await brokerChannel.bindQueue(
        'po.inventario.q',
        exchangeCommands,
        'catalog.sku.deactivated',
      );
      process.env.INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED = 'false';
      try {
        await consumer.start();
        writer.publish(
          exchangeCommands,
          'catalog.sku.deactivated',
          Buffer.from(JSON.stringify(event)),
          {
            persistent: true,
            mandatory: true,
            messageId: event.message_id,
          },
        );
        await viWaitFor(async () => {
          expect(consumer.getMetrics().paused).toBe(true);
        }, 5000);
        expect(consumer.getMetrics().acknowledged).toBe(0);
        expect(
          (await brokerChannel.checkQueue('po.inventario.q')).messageCount,
        ).toBe(1);
        process.env.INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED = 'true';
        await consumer.resume();
        await viWaitFor(async () => {
          expect(consumer.getMetrics().acknowledged).toBe(1);
        }, 5000);
        expect(
          (
            await database.query(
              `SELECT sku_id FROM inventory.sku_lifecycle WHERE sku_id=$1`,
              [sku],
            )
          ).rowCount,
        ).toBe(1);

        writer.publish(
          exchangeCommands,
          'catalog.sku.deactivated',
          Buffer.from(JSON.stringify(event)),
          { persistent: true, mandatory: true, messageId: event.message_id },
        );
        await viWaitFor(async () => {
          expect(consumer.getMetrics().acknowledged).toBe(2);
        }, 5000);
        expect(consumer.getMetrics().duplicates).toBe(1);
        expect(
          (
            await database.query(
              `SELECT message_id FROM inventory.inbox WHERE message_id=$1`,
              [event.message_id],
            )
          ).rowCount,
        ).toBe(1);
        expect(
          (
            await database.query(
              `SELECT sku_id FROM inventory.sku_lifecycle WHERE sku_id=$1`,
              [sku],
            )
          ).rowCount,
        ).toBe(1);

        const stale = catalogPr185SkuDeactivatedEvent({
          sku,
          productId: event.data.product_id,
          skuVersion: 1,
          changedAt: new Date(
            Date.parse(event.data.changed_at) - 1000,
          ).toISOString(),
        });
        writer.publish(
          exchangeCommands,
          'catalog.sku.deactivated',
          Buffer.from(JSON.stringify(stale)),
          { persistent: true, mandatory: true, messageId: stale.message_id },
        );
        await viWaitFor(async () => {
          expect(consumer.getMetrics().acknowledged).toBe(3);
        }, 5000);
        expect(
          (
            await database.query<{ active: boolean; sku_version: number }>(
              `SELECT active,sku_version FROM inventory.sku_lifecycle WHERE sku_id=$1`,
              [sku],
            )
          ).rows[0],
        ).toEqual({ active: false, sku_version: 2 });
      } finally {
        await consumer.onModuleDestroy();
        await writer.close().catch(() => undefined);
        await brokerChannel.unbindQueue(
          'po.inventario.q',
          exchangeCommands,
          'catalog.sku.deactivated',
        );
        if (gate === undefined)
          delete process.env.INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED;
        else process.env.INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED = gate;
      }
    }, 20_000);
  });

  describe('BACK-02 — reconciliación del modelo físico y permisos en PostgreSQL aislado', () => {
    const MODEL_TABLES = [
      'locations',
      'stock_balance',
      'reservations',
      'reservation_lines',
      'inventory_operations',
      'kardex',
      'incidencias',
      'traslados',
      'traslado_recepciones',
      'stock_threshold_override',
      'inventory_config',
      'dashboard_projection',
      'outbox',
      'inbox',
      'commercial_fulfillment_routes',
      'sku_lifecycle',
      'offline_sale_reconciliations',
    ];

    it('materializa las 17 tablas del modelo solo dentro del schema inventory', async () => {
      const res = await database.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'inventory'`,
      );
      const names = res.rows.map((row) => row.tablename);
      for (const table of MODEL_TABLES) {
        expect(names, `falta inventory.${table}`).toContain(table);
      }

      const elsewhere = await database.query<{ schemaname: string }>(
        `SELECT schemaname FROM pg_tables
          WHERE tablename = ANY($1) AND schemaname <> 'inventory'`,
        [MODEL_TABLES],
      );
      expect(elsewhere.rowCount).toBe(0);
    });

    it('publica los enums del modelo con sus etiquetas exactas', async () => {
      const res = await database.query<{ typname: string; labels: string[] }>(
        `SELECT t.typname AS typname,
                array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
           FROM pg_type t
           JOIN pg_enum e ON e.enumtypid = t.oid
           JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'inventory' AND t.typname = ANY($1)
          GROUP BY t.typname`,
        [
          [
            'incidencia_estado',
            'tipo_resolucion_incidencia',
            'traslado_estado',
            'disposicion_recepcion_traslado',
          ],
        ],
      );
      const labels = Object.fromEntries(
        res.rows.map((row) => [row.typname, row.labels]),
      );
      expect(labels.incidencia_estado).toEqual([
        'ABIERTA',
        'RESUELTA',
        'TRASLADO_PENDIENTE',
      ]);
      expect(labels.tipo_resolucion_incidencia).toEqual([
        'REHABILITADO',
        'MERMA',
        'FALTANTE_CONFIRMADO',
        'TRASLADO_ALMACEN_CENTRAL',
      ]);
      expect(labels.traslado_estado).toEqual([
        'EN_TRANSITO',
        'RECIBIDO_PARCIAL',
        'COMPLETADO',
        'COMPLETADO_CON_DISCREPANCIA',
      ]);
      expect(labels.disposicion_recepcion_traslado).toEqual([
        'REINGRESAR_DISPONIBLE',
        'REINGRESAR_BLOQUEADO',
        'CONFIRMAR_MERMA',
      ]);
    });

    it('aplica FK, unicidad y deduplicación de las tablas nuevas', async () => {
      await expect(
        database.query(
          `INSERT INTO inventory.traslados
             (traslado_id,sku_id,source_location_id,target_location_id,quantity_shipped)
           VALUES($1,$2,$3,$3,1)`,
          [randomUUID(), `sku-${randomUUID()}`, randomUUID()],
        ),
      ).rejects.toThrow();

      const trasladoId = randomUUID();
      const sku = `sku-${randomUUID()}`;
      const inserted = await database.query<{ id: string }>(
        `INSERT INTO inventory.traslados
           (traslado_id,sku_id,source_location_id,target_location_id,quantity_shipped)
         VALUES($1,$2,$3,$3,5)
         RETURNING id`,
        [trasladoId, sku, locationId],
      );
      const trasladoPk = inserted.rows[0].id;

      await expect(
        database.query(
          `INSERT INTO inventory.traslados
             (traslado_id,sku_id,source_location_id,target_location_id,quantity_shipped)
           VALUES($1,$2,$3,$3,5)`,
          [trasladoId, sku, locationId],
        ),
      ).rejects.toThrow();

      await expect(
        database.query(
          `INSERT INTO inventory.traslado_recepciones
             (recepcion_id,traslado_id,cantidad_recibida,disposicion,sub_gestor,idempotency_key)
           VALUES($1,$2,1,'REINGRESAR_DISPONIBLE','it-sub',$3)`,
          [randomUUID(), randomUUID(), `idem-${randomUUID()}`],
        ),
      ).rejects.toThrow();

      const idempotencyKey = `idem-${randomUUID()}`;
      await database.query(
        `INSERT INTO inventory.traslado_recepciones
           (recepcion_id,traslado_id,cantidad_recibida,disposicion,sub_gestor,idempotency_key)
         VALUES($1,$2,2,'REINGRESAR_DISPONIBLE','it-sub',$3)`,
        [randomUUID(), trasladoPk, idempotencyKey],
      );
      await expect(
        database.query(
          `INSERT INTO inventory.traslado_recepciones
             (recepcion_id,traslado_id,cantidad_recibida,disposicion,sub_gestor,idempotency_key)
           VALUES($1,$2,2,'REINGRESAR_DISPONIBLE','it-sub',$3)`,
          [randomUUID(), trasladoPk, idempotencyKey],
        ),
      ).rejects.toThrow();

      await database.query(`DELETE FROM inventory.traslados WHERE id = $1`, [
        trasladoPk,
      ]);
      const orphan = await database.query(
        `SELECT 1 FROM inventory.traslado_recepciones WHERE traslado_id = $1`,
        [trasladoPk],
      );
      expect(orphan.rowCount).toBe(0);
    });

    it('deduplica incidencias e inbox por sus claves únicas', async () => {
      const incidenciaId = randomUUID();
      await database.query(
        `INSERT INTO inventory.incidencias
           (incidencia_id,sku_id,location_id,cantidad_bloqueada,idempotency_key)
         VALUES($1,$2,$3,3,$4)`,
        [
          incidenciaId,
          `sku-${randomUUID()}`,
          locationId,
          `idem-${randomUUID()}`,
        ],
      );
      await expect(
        database.query(
          `INSERT INTO inventory.incidencias
             (incidencia_id,sku_id,location_id,cantidad_bloqueada,idempotency_key)
           VALUES($1,$2,$3,3,$4)`,
          [
            incidenciaId,
            `sku-${randomUUID()}`,
            locationId,
            `idem-${randomUUID()}`,
          ],
        ),
      ).rejects.toThrow();

      const messageId = randomUUID();
      await database.query(
        `INSERT INTO inventory.inbox(message_id,message_type,source,payload)
         VALUES($1,'catalog.sku.deactivated','catalog',$2)`,
        [messageId, JSON.stringify({ sku_id: 'sku-x' })],
      );
      await expect(
        database.query(
          `INSERT INTO inventory.inbox(message_id,message_type,source,payload)
           VALUES($1,'catalog.sku.deactivated','catalog',$2)`,
          [messageId, JSON.stringify({ sku_id: 'sku-x' })],
        ),
      ).rejects.toThrow();
    });

    it('deriva available y protege la PK compuesta de dashboard_projection', async () => {
      const sku = `sku-${randomUUID()}`;
      await database.query(
        `INSERT INTO inventory.dashboard_projection
           (sku_id,location_id,on_hand,reserved,blocked,status,umbral_efectivo)
         VALUES($1,$2,10,3,2,'STOCK_BAJO',5)`,
        [sku, locationId],
      );
      const derived = await database.query<{ available: number }>(
        `SELECT available FROM inventory.dashboard_projection
          WHERE sku_id = $1 AND location_id = $2`,
        [sku, locationId],
      );
      expect(derived.rows[0].available).toBe(5);

      await database.query(
        `UPDATE inventory.dashboard_projection SET on_hand = 8
          WHERE sku_id = $1 AND location_id = $2`,
        [sku, locationId],
      );
      const recalculated = await database.query<{ available: number }>(
        `SELECT available FROM inventory.dashboard_projection
          WHERE sku_id = $1 AND location_id = $2`,
        [sku, locationId],
      );
      expect(recalculated.rows[0].available).toBe(3);

      // CHECK chk_dp_reserved_plus_blocked: reserved + blocked <= on_hand.
      await expect(
        database.query(
          `UPDATE inventory.dashboard_projection SET on_hand = 1
            WHERE sku_id = $1 AND location_id = $2`,
          [sku, locationId],
        ),
      ).rejects.toThrow();

      await expect(
        database.query(
          `INSERT INTO inventory.dashboard_projection
             (sku_id,location_id,on_hand,reserved,blocked,status,umbral_efectivo)
           VALUES($1,$2,1,0,0,'STOCK_BAJO',5)`,
          [sku, locationId],
        ),
      ).rejects.toThrow();

      await expect(
        database.query(
          `INSERT INTO inventory.dashboard_projection
             (sku_id,location_id,on_hand,reserved,blocked,available,status,umbral_efectivo)
           VALUES($1,$2,1,0,0,7,'STOCK_BAJO',5)`,
          [`sku-${randomUUID()}`, locationId],
        ),
      ).rejects.toThrow();
    });

    it('revierte por completo una transacción sobre las tablas nuevas', async () => {
      const sku = `sku-${randomUUID()}`;
      await expect(
        database.transaction(async (client) => {
          await client.query(
            `INSERT INTO inventory.incidencias
               (incidencia_id,sku_id,location_id,cantidad_bloqueada,idempotency_key)
             VALUES($1,$2,$3,4,$4)`,
            [randomUUID(), sku, locationId, `idem-${randomUUID()}`],
          );
          await client.query(
            `INSERT INTO inventory.inventory_config(key,value) VALUES('it-rollback',$1)`,
            [JSON.stringify({ sku })],
          );
          await client.query(
            `INSERT INTO inventory.inventory_config(key,value) VALUES('it-rollback',$1)`,
            [JSON.stringify({ sku })],
          );
        }),
      ).rejects.toThrow();

      const incidencias = await database.query(
        `SELECT 1 FROM inventory.incidencias WHERE sku_id = $1`,
        [sku],
      );
      const config = await database.query(
        `SELECT 1 FROM inventory.inventory_config WHERE key = 'it-rollback'`,
      );
      expect(incidencias.rowCount).toBe(0);
      expect(config.rowCount).toBe(0);
    });

    it('aplica permisos requeridos y denegados del runtime en el schema aislado', async () => {
      const role = `it_runtime_${randomUUID().replaceAll('-', '')}`;
      const rolePassword = randomBytes(18).toString('hex');
      await database.query(
        `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${rolePassword}'`,
      );
      await database.query(`GRANT USAGE ON SCHEMA inventory TO ${role}`);
      await database.query(
        `GRANT SELECT ON inventory.locations, inventory.stock_balance, inventory.commercial_fulfillment_routes TO ${role}`,
      );
      await database.query(`CREATE SCHEMA IF NOT EXISTS it_foreign`);
      await database.query(
        `CREATE TABLE IF NOT EXISTS it_foreign.orders(id integer)`,
      );

      const url = new URL(pgUrl);
      url.username = role;
      url.password = rolePassword;
      const runtime = new pg.Client({ connectionString: url.toString() });
      await runtime.connect();
      try {
        const allowed = await runtime.query<{ total: number }>(
          `SELECT count(*)::int AS total FROM inventory.locations`,
        );
        expect(allowed.rows[0].total).toBeGreaterThanOrEqual(1);

        await expect(
          runtime.query(`SELECT 1 FROM inventory.outbox LIMIT 1`),
        ).rejects.toThrow(/permission denied/);
        await expect(
          runtime.query(`CREATE TABLE inventory.it_hack(id integer)`),
        ).rejects.toThrow(/permission denied/);
        await expect(
          runtime.query(
            `INSERT INTO inventory.locations(code,name,type) VALUES('it-x','x','TIENDA')`,
          ),
        ).rejects.toThrow(/permission denied/);
        await expect(
          runtime.query(`SELECT 1 FROM it_foreign.orders LIMIT 1`),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await runtime.end();
      }
    });
  });

  describe('DATA-004 — ejecución E2E de scripts SQL en PostgreSQL desechable (#14)', () => {
    const locLurin = '9129b578-631e-1735-8427-b683fb524380';
    const locMiraflores = 'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485';
    const skus = [
      'ADI-ENT22-AZU-M',
      'ADI-STAN-BLA-41',
      'CAL-NK-AIR-42',
      'NK-RUN-NEG-42',
      'NKE-TCH-GRI-L',
      'PUM-CLAS-NEG-40',
      'PUM-TRN-NEG-M',
    ];
    let loadSql: string;
    let rollbackSql: string;

    beforeAll(async () => {
      loadSql = await readFile(
        new URL('../data/data-f1/proposal-load.sql', import.meta.url),
        'utf8',
      );
      rollbackSql = await readFile(
        new URL('../data/data-f1/proposal-rollback.sql', import.meta.url),
        'utf8',
      );
    });

    async function setupBaseline(withConflict = false): Promise<void> {
      await database.query(`DELETE FROM inventory.stock_threshold_override`);

      await database.query(
        `INSERT INTO inventory.locations (id, code, name, type, active)
         VALUES ($1, 'ALM-LURIN', 'Almacén Lurín', 'ALMACEN', true),
                ($2, 'TDA-MIRAFLORES', 'Tienda Miraflores', 'TIENDA', true)
         ON CONFLICT (id) DO UPDATE SET active = true`,
        [locLurin, locMiraflores],
      );

      await database.query(
        `DELETE FROM inventory.stock_balance WHERE location_id IN ($1, $2)`,
        [locLurin, locMiraflores],
      );

      for (const locId of [locLurin, locMiraflores]) {
        for (const sku of skus) {
          await database.query(
            `INSERT INTO inventory.stock_balance
             (sku_id, location_id, on_hand, reserved, blocked)
             VALUES ($1, $2, 20, 0, 0)`,
            [sku, locId],
          );
        }
      }

      await database.query(
        `INSERT INTO inventory.stock_threshold_override
         (id, sku_id, location_id, umbral_efectivo)
         VALUES ('a0000000-0000-0000-0000-000000000001'::uuid, 'PUM-CLAS-NEG-40', NULL, 7)`,
      );

      if (withConflict) {
        await database.query(
          `INSERT INTO inventory.stock_threshold_override
           (id, sku_id, location_id, umbral_efectivo)
           VALUES ('b0000000-0000-0000-0000-000000000002'::uuid, NULL, NULL, 99)`,
        );
      }
    }

    it('ejecuta proposal-load.sql: carga atómica, verificación de umbrales y preservación de saldos y umbral previo', async () => {
      await setupBaseline();
      const client = new pg.Client({ connectionString: pgUrl });
      await client.connect();
      try {
        await client.query(loadSql);

        const overrides = await client.query<{
          id: string;
          sku_id: string | null;
          umbral_efectivo: number;
        }>(
          `SELECT id, sku_id, umbral_efectivo FROM inventory.stock_threshold_override ORDER BY created_at ASC`,
        );
        expect(overrides.rowCount).toBe(3);

        const globalRow = overrides.rows.find(
          (r) => r.id === '0a24fa68-450f-5fa1-827d-78fb5f09fe54',
        );
        expect(globalRow).toBeDefined();
        expect(globalRow?.sku_id).toBeNull();
        expect(globalRow?.umbral_efectivo).toBe(5);

        const skuRow = overrides.rows.find(
          (r) => r.id === '7b49463c-333e-5e63-b8ad-344c20847250',
        );
        expect(skuRow).toBeDefined();
        expect(skuRow?.sku_id).toBe('ADI-ENT22-AZU-M');
        expect(skuRow?.umbral_efectivo).toBe(3);

        const priorRow = overrides.rows.find(
          (r) => r.id === 'a0000000-0000-0000-0000-000000000001',
        );
        expect(priorRow).toBeDefined();
        expect(priorRow?.sku_id).toBe('PUM-CLAS-NEG-40');
        expect(priorRow?.umbral_efectivo).toBe(7);

        const balances = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM inventory.stock_balance WHERE location_id IN ($1, $2)`,
          [locLurin, locMiraflores],
        );
        expect(balances.rows[0].count).toBe(14);
      } finally {
        await client.end();
      }
    });

    it('ejecuta replay de proposal-load.sql: idempotencia estricta sin duplicados ni errores', async () => {
      const client = new pg.Client({ connectionString: pgUrl });
      await client.connect();
      try {
        await client.query(loadSql);

        const overrides = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM inventory.stock_threshold_override`,
        );
        expect(overrides.rows[0].count).toBe(3);
      } finally {
        await client.end();
      }
    });

    it('ejecuta proposal-load.sql concurrentemente: pg_advisory_xact_lock serializa sin colisión ni duplicación', async () => {
      await setupBaseline();
      const client1 = new pg.Client({ connectionString: pgUrl });
      const client2 = new pg.Client({ connectionString: pgUrl });
      await Promise.all([client1.connect(), client2.connect()]);

      try {
        const [res1, res2] = await Promise.all([
          client1.query(loadSql),
          client2.query(loadSql),
        ]);
        expect(res1).toBeDefined();
        expect(res2).toBeDefined();

        const overrides = await client1.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM inventory.stock_threshold_override`,
        );
        expect(overrides.rows[0].count).toBe(3);
      } finally {
        await Promise.all([client1.end(), client2.end()]);
      }
    });

    it('ejecuta proposal-rollback.sql: revierte exclusivamente DATA-004 y preserva datos previos y saldos', async () => {
      const client = new pg.Client({ connectionString: pgUrl });
      await client.connect();
      try {
        await client.query(rollbackSql);

        const overrides = await client.query<{
          id: string;
          sku_id: string | null;
          umbral_efectivo: number;
        }>(
          `SELECT id, sku_id, umbral_efectivo FROM inventory.stock_threshold_override`,
        );
        expect(overrides.rowCount).toBe(1);
        expect(overrides.rows[0].id).toBe(
          'a0000000-0000-0000-0000-000000000001',
        );
        expect(overrides.rows[0].sku_id).toBe('PUM-CLAS-NEG-40');
        expect(overrides.rows[0].umbral_efectivo).toBe(7);

        const balances = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM inventory.stock_balance WHERE location_id IN ($1, $2)`,
          [locLurin, locMiraflores],
        );
        expect(balances.rows[0].count).toBe(14);

        await client.query(rollbackSql);
        const overridesAfterReplay = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM inventory.stock_threshold_override`,
        );
        expect(overridesAfterReplay.rows[0].count).toBe(1);
      } finally {
        await client.end();
      }
    });

    it('aborta y hace rollback si se violan las precondiciones del baseline', async () => {
      await setupBaseline(true);
      const client = new pg.Client({ connectionString: pgUrl });
      await client.connect();
      try {
        await expect(client.query(loadSql)).rejects.toThrow(
          /Precondición fallida: ya existe un umbral global incompatible/,
        );

        // Limpiar estado de transacción abortada en la conexión
        await client.query('ROLLBACK').catch(() => {});

        const overrides = await database.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM inventory.stock_threshold_override WHERE id IN (
            '0a24fa68-450f-5fa1-827d-78fb5f09fe54'::uuid,
            '7b49463c-333e-5e63-b8ad-344c20847250'::uuid
          )`,
        );
        expect(overrides.rows[0].count).toBe(0);
      } finally {
        await client.end();
      }
    });
  });
});

async function viWaitFor(
  assertion: () => Promise<void>,
  timeout: number,
): Promise<void> {
  const end = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < end) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error('Timeout esperando condición de integración');
}

async function waitForContainer(
  container: string,
  command: string,
  user?: string,
): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 60_000) {
    try {
      execFileSync(
        'docker',
        [
          'exec',
          ...(user ? ['--user', user] : []),
          container,
          ...command.split(' '),
        ],
        {
          stdio: 'ignore',
          timeout: 5000,
        },
      );
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Timeout esperando ${container}: ${String(lastError)}`);
}
