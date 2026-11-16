// Disposable Azure integration runner. Loopback-only HTTP/TLS databases; no developer credentials.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { ManagedIdentityCredential } from '@azure/identity';
import { ServiceBusClient } from '@azure/service-bus';
import { PricingDatabase } from '../../../dist/apps/pricing-svc/persistence/pricing.database.js';
import { PricingRepository } from '../../../dist/apps/pricing-svc/persistence/pricing.repository.js';
import { PricingMutations } from '../../../dist/apps/pricing-svc/application/pricing-mutations.js';
import { createPricingPriceChangedFacts } from '../../../dist/apps/pricing-svc/messaging/pricing-fact.js';
import {
  PricingDeliveryStore,
  AUDIT_PILOT_QUEUE,
} from '../../../dist/apps/pricing-svc/messaging/service-bus-deliveries.js';
import { PricingServiceBusRelay } from '../../../dist/apps/pricing-svc/messaging/service-bus-relay.js';
import { AuditDatabase } from '../../../dist/apps/price-audit-svc/persistence/audit.database.js';
import { AuditRepository } from '../../../dist/apps/price-audit-svc/persistence/audit.repository.js';
import { AuditServiceBusHandler } from '../../../dist/apps/price-audit-svc/messaging/service-bus-consumer.js';
import { createApplication as createPricingApp } from '../../../dist/apps/pricing-svc/bootstrap.js';
import { createApplication as createAuditApp } from '../../../dist/apps/price-audit-svc/bootstrap.js';
import { PricingServiceBusRuntime } from '../../../dist/apps/pricing-svc/messaging/service-bus-relay.js';
import { AuditServiceBusRuntime } from '../../../dist/apps/price-audit-svc/messaging/service-bus-consumer.js';

const root = new URL('../../../', import.meta.url);
const sql = async (path) => readFile(new URL(path, root), 'utf8');
const completedChecks = [];
const log = (value) => {
  if (value.check && value.status === 'PASS') completedChecks.push(value);
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
const resources = [];
let stage = 'configuration';
const ca = await readFile('/pilot-status/tls/server.crt', 'utf8');
const databaseSsl = { rejectUnauthorized: true, ca };

async function database(kind, port, password, fixtureHash) {
  assert.match(password, /^[0-9a-f-]{36}$/);
  const name = kind === 'pricing' ? 'pricing_test' : 'price_audit_test';
  const owner =
    kind === 'pricing' ? 'po_pricing_owner' : 'po_price_audit_owner';
  const role = kind === 'pricing' ? 'pricing_app' : 'price_audit_app';
  const schema = kind === 'pricing' ? 'pricing' : 'price_audit';
  const connection = `postgresql://postgres:${password}@127.0.0.1:${port}/${name}`;
  const pool = new Pool({
    connectionString: connection,
    ssl: databaseSsl,
    connectionTimeoutMillis: 1000,
  });
  resources.push(() => pool.end());
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      await pool.query('SELECT 1');
      ready = true;
      break;
    } catch {
      await delay(1000);
    }
  }
  assert.ok(ready, 'ISOLATED_POSTGRES_UNAVAILABLE');
  const fixture = await sql(
    `apps/${kind === 'pricing' ? 'pricing-svc' : 'price-audit-svc'}/test/fixtures/${kind === 'pricing' ? 'pricing' : 'price-audit'}.sql`,
  );
  assert.equal(
    createHash('sha256').update(fixture.replaceAll('\r\n', '\n')).digest('hex'),
    fixtureHash,
  );
  await pool.query(`
    CREATE ROLE ${owner} NOLOGIN;
    CREATE ROLE ${role} LOGIN PASSWORD '${password}';
    CREATE SCHEMA ${schema} AUTHORIZATION ${owner};
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    ${kind === 'pricing' ? 'CREATE SCHEMA extensions; CREATE EXTENSION btree_gist WITH SCHEMA extensions; GRANT USAGE ON SCHEMA extensions TO po_pricing_owner;' : 'CREATE ROLE price_audit_archiver NOLOGIN;'}
    BEGIN; SET LOCAL ROLE ${owner}; ${fixture} COMMIT;
  `);
  const migrations =
    kind === 'pricing'
      ? [
          'apps/pricing-svc/migrations/0002_schedule_effective_events.sql',
          'apps/pricing-svc/migrations/0003_initialization_operation_index.sql',
          'apps/pricing-svc/migrations-candidate/h5/0001_outbox_delivery.sql',
        ]
      : ['apps/price-audit-svc/migrations/0002_typed_price_change.sql'];
  for (const migration of migrations)
    await pool.query(
      `BEGIN; SET LOCAL ROLE ${owner}; ${await sql(migration)} COMMIT;`,
    );
  return {
    pool,
    url: `postgresql://${role}:${password}@127.0.0.1:${port}/${name}`,
  };
}

async function main() {
  const namespace = process.env.G6_SERVICE_BUS_TEST_NAMESPACE ?? '';
  const pricingId = process.env.G6_PRICING_TEST_CLIENT_ID ?? '';
  const auditId = process.env.G6_AUDIT_TEST_CLIENT_ID ?? '';
  const guid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.match(namespace, /^g6-sb-test-[a-z0-9-]+\.servicebus\.windows\.net$/);
  assert.match(pricingId, guid);
  assert.match(auditId, guid);
  assert.notEqual(pricingId, auditId);
  stage = 'isolated-postgres';
  const pricing = await database(
    'pricing',
    5432,
    process.env.PRICING_TEST_PASSWORD ?? '',
    '7f440ffa401e8d56ecb2664060edb131505a16b8568843093a5047a6c13bc581',
  );
  const audit = await database(
    'audit',
    5433,
    process.env.AUDIT_TEST_PASSWORD ?? '',
    '7d890955717025572da03d258168d81e9b7fa38c797f1b697527f0d4cab89afc',
  );
  const config = {
    nodeEnv: 'test',
    port: 3002,
    securityMode: 'G7_AUTHENTICATED',
    publicOperations: [],
    databaseUrl: pricing.url,
    databaseSsl,
    serviceBus: { namespace },
    priceChangedPublishingEnabled: true,
  };
  const pricingDb = new PricingDatabase(config);
  const auditDb = new AuditDatabase({
    nodeEnv: 'test',
    port: 3003,
    securityMode: 'G7_AUTHENTICATED',
    hotRetentionMonths: 24,
    archiveRetentionYears: 5,
    databaseUrl: audit.url,
    databaseSsl,
  });
  resources.push(
    () => pricingDb.onApplicationShutdown(),
    () => auditDb.onApplicationShutdown(),
  );
  stage = 'managed-identity';
  const options = { retryOptions: { maxRetries: 0, timeoutInMs: 5000 } };
  const pricingClient = new ServiceBusClient(
    namespace,
    new ManagedIdentityCredential({ clientId: pricingId }),
    options,
  );
  const auditClient = new ServiceBusClient(
    namespace,
    new ManagedIdentityCredential({ clientId: auditId }),
    options,
  );
  resources.push(
    () => pricingClient.close(),
    () => auditClient.close(),
  );
  const sender = pricingClient.createSender(AUDIT_PILOT_QUEUE);
  const receiver = auditClient.createReceiver(AUDIT_PILOT_QUEUE, {
    receiveMode: 'peekLock',
    skipParsingBodyAsJson: true,
  });
  resources.push(
    () => sender.close(),
    () => receiver.close(),
  );
  // RBAC propagation is bounded; do not replace workload credentials with the deploying user.
  let authorized = false;
  for (let attempt = 0; attempt < 36; attempt++) {
    try {
      await sender.createMessageBatch();
      assert.equal(
        (await receiver.peekMessages(1)).length,
        0,
        'DEDICATED_QUEUE_NOT_EMPTY',
      );
      authorized = true;
      break;
    } catch (error) {
      if (
        error?.code !== 'UnauthorizedAccess' &&
        error?.code !== 'MessagingEntityNotFound'
      )
        throw error;
      await delay(5000);
    }
  }
  assert.ok(authorized, 'RBAC_PROPAGATION_TIMEOUT');
  log({
    check: 'MANAGED_IDENTITIES_AUTHENTICATED',
    status: 'PASS',
    namespace,
    pricingClientId: pricingId,
    auditClientId: auditId,
  });
  stage = 'pricing-outbox';
  const repository = new PricingRepository(pricingDb);
  const mutations = new PricingMutations(repository, config);
  const productId = randomUUID(),
    correlationId = randomUUID(),
    now = new Date();
  await mutations.update(
    { productId },
    null,
    {
      precioRegular: '123.45',
      currency: 'PEN',
      motivoCambio: 'ISOLATED_H5_AZURE_TEST',
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
  const relay = new PricingServiceBusRelay(
    new PricingDeliveryStore(repository),
    sender,
  );
  assert.equal(await relay.publishOne(), 'sent');
  const delivery = await pricing.pool.query(
    'SELECT message_id, sent_at FROM pricing.outbox_delivery',
  );
  assert.equal(delivery.rowCount, 1);
  assert.ok(delivery.rows[0].sent_at);
  stage = 'audit-receive';
  const messages = await receiver.receiveMessages(1, {
    maxWaitTimeInMs: 10000,
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].correlationId, correlationId);
  const message = messages[0];
  log({
    check: 'RECEIVED_DATA_SECTION',
    status: 'PASS',
    binaryBody: message.body instanceof Uint8Array,
    messageId: message.messageId,
  });
  const auditRepository = new AuditRepository(auditDb);
  // Real commit, deliberately abandon settlement, then receive again from Azure.
  const crashSettlement = {
    completeMessage: async () => {
      await receiver.abandonMessage(message);
      throw new Error('SIMULATED_CRASH_AFTER_REAL_COMMIT');
    },
    abandonMessage: (item) => receiver.abandonMessage(item),
    deadLetterMessage: (item, reason) =>
      receiver.deadLetterMessage(item, reason),
  };
  stage = 'audit-commit-before-settlement';
  await assert.rejects(
    new AuditServiceBusHandler(auditRepository, crashSettlement).handle(
      message,
    ),
    /SIMULATED_CRASH_AFTER_REAL_COMMIT/,
  );
  stage = 'audit-redelivery';
  const redelivered = await receiver.receiveMessages(1, {
    maxWaitTimeInMs: 10000,
  });
  assert.equal(redelivered.length, 1);
  assert.equal(redelivered[0].messageId, message.messageId);
  assert.ok(redelivered[0].deliveryCount > message.deliveryCount);
  assert.equal(
    await new AuditServiceBusHandler(auditRepository, receiver).handle(
      redelivered[0],
    ),
    'completed',
  );
  stage = 'audit-single-effect';
  const count = await audit.pool.query(
    'SELECT count(*)::int AS count FROM price_audit.price_audit_log a JOIN price_audit.inbox i ON i.id=a.inbox_id WHERE i.message_id=$1',
    [message.messageId],
  );
  assert.equal(count.rows[0].count, 1);
  log({
    check: 'PRICING_AZURE_AUDIT_REDELIVERY',
    status: 'PASS',
    messageId: message.messageId,
    correlationId,
    auditEffects: 1,
    deliveryCount: redelivered[0].deliveryCount,
  });
  stage = 'negative-rbac';
  const wrongSender = auditClient.createSender(AUDIT_PILOT_QUEUE);
  try {
    await assert.rejects(
      wrongSender.createMessageBatch(),
      (error) => error?.code === 'UnauthorizedAccess',
    );
  } finally {
    await wrongSender.close();
  }
  log({ check: 'AUDIT_CANNOT_SEND', status: 'PASS' });
  const wrongReceiver = pricingClient.createReceiver(AUDIT_PILOT_QUEUE);
  try {
    await assert.rejects(
      wrongReceiver.peekMessages(1),
      (error) => error?.code === 'UnauthorizedAccess',
    );
  } finally {
    await wrongReceiver.close();
  }
  log({ check: 'PRICING_CANNOT_RECEIVE', status: 'PASS' });
  stage = 'dead-letter';
  const invalidId = randomUUID();
  await sender.sendMessages({
    body: '{}',
    messageId: invalidId,
    correlationId: randomUUID(),
    subject: 'pricing.price.changed',
  });
  const invalid = await receiver.receiveMessages(1, { maxWaitTimeInMs: 10000 });
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].messageId, invalidId);
  assert.equal(
    await new AuditServiceBusHandler(auditRepository, receiver).handle(
      invalid[0],
    ),
    'dead-lettered',
  );
  const deadLetters = auditClient.createReceiver(AUDIT_PILOT_QUEUE, {
    subQueueType: 'deadLetter',
  });
  try {
    // Preserve earlier failed-run evidence; only inspect the current test's ID.
    const dead = (await deadLetters.peekMessages(20)).find(
      (item) => item.messageId === invalidId,
    );
    assert.ok(dead);
    assert.equal(dead.deadLetterReason, 'INVALID_PRICING_CONTRACT');
  } finally {
    await deadLetters.close();
  }
  log({
    check: 'INVALID_MESSAGE_REAL_DLQ',
    status: 'PASS',
    messageId: invalidId,
  });
  assert.equal((await receiver.peekMessages(1)).length, 0);
  stage = 'full-nest-production-tls';
  await receiver.close();
  const baseEnv = {
    NODE_ENV: 'production',
    G6_SECURITY_MODE: 'G7_AUTHENTICATED',
    MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
    G6_SERVICE_BUS_PILOT_ENABLED: 'true',
    G6_SERVICE_BUS_PRODUCTION_ENABLED: 'true',
    SERVICE_BUS_NAMESPACE_FQDN: namespace,
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: '/pilot-status/tls/server.crt',
    // Anonymous-denial smoke only; no positive G7 authentication is claimed.
    AUTH_ISSUER: 'https://g7.unconfigured.invalid/api/v1/auth',
    AUTH_JWKS_URL: 'https://g7.unconfigured.invalid/api/v1/auth/jwks',
  };
  for (const round of [1, 2]) {
    const product = randomUUID(),
      correlation = randomUUID(),
      at = new Date();
    await mutations.update(
      { productId: product },
      null,
      {
        precioRegular: '145.20',
        currency: 'PEN',
        motivoCambio: 'ISOLATED_H5_NEST_RESTART',
        usuarioId: null,
      },
      0n,
      at,
      (before, after) =>
        createPricingPriceChangedFacts(before, after, {
          actor: null,
          correlationId: correlation,
          at,
          operation: 'actualizarPrecioBaseProducto',
          productId: product,
        }),
    );
    const pricingApp = await createPricingApp({
      ...baseEnv,
      AZURE_CLIENT_ID: pricingId,
      DATABASE_URL: pricing.url,
      PORT: '3002',
      PRICING_PRICE_CHANGED_PUBLISH_ENABLED: 'true',
    });
    const auditApp = await createAuditApp({
      ...baseEnv,
      AZURE_CLIENT_ID: auditId,
      DATABASE_URL: audit.url,
      PORT: '3003',
    });
    try {
      await auditApp.app.listen(3003, '127.0.0.1');
      await pricingApp.app.listen(3002, '127.0.0.1');
      let persisted = false;
      // No HTTP request wakes the worker: SQL intention predates boot/reboot.
      for (let attempt = 0; attempt < 45; attempt++) {
        const result = await audit.pool.query(
          'SELECT count(*)::int AS count FROM price_audit.price_audit_log a JOIN price_audit.inbox i ON i.id=a.inbox_id WHERE i.correlation_id=$1',
          [correlation],
        );
        if (
          result.rows[0].count === 1 &&
          pricingApp.app.get(PricingServiceBusRuntime).available &&
          auditApp.app.get(AuditServiceBusRuntime).available
        ) {
          persisted = true;
          break;
        }
        await delay(1000);
      }
      assert.ok(persisted, 'FULL_NEST_WORKER_DID_NOT_RECOVER_SQL');
      for (const port of [3002, 3003]) {
        assert.equal(
          (await fetch(`http://127.0.0.1:${port}/health`)).status,
          200,
        );
        assert.equal(
          (await fetch(`http://127.0.0.1:${port}/health/ready`)).status,
          200,
        );
      }
      assert.ok(
        [401, 403].includes(
          (await fetch('http://127.0.0.1:3003/api/v1/auditoria-precios'))
            .status,
        ),
      );
      if (round === 2) {
        await pricingApp.app.get(PricingServiceBusRuntime).onModuleDestroy();
        assert.equal((await fetch('http://127.0.0.1:3002/health')).status, 200);
        assert.equal(
          (await fetch('http://127.0.0.1:3002/health/ready')).status,
          503,
        );
      }
      log({
        check:
          round === 1
            ? 'FULL_NEST_PRODUCTION_TLS_BOOT'
            : 'FULL_NEST_RESTART_SQL_RECOVERY',
        status: 'PASS',
        correlationId: correlation,
        auditEffects: 1,
        realG7PositiveAuthentication: false,
      });
    } finally {
      await Promise.allSettled([pricingApp.app.close(), auditApp.app.close()]);
    }
  }
  const inventory = auditClient.createReceiver(AUDIT_PILOT_QUEUE, {
    subQueueType: 'deadLetter',
  });
  try {
    const messages = await inventory.peekMessages(20, {
      fromSequenceNumber: message.sequenceNumber.subtract(
        message.sequenceNumber,
      ),
    });
    log({
      check: 'DLQ_INVENTORY',
      status: 'PASS',
      messages: messages.map((item) => ({
        messageId: item.messageId,
        reason: item.deadLetterReason,
        bodySha256: createHash('sha256')
          .update(Buffer.from(item.body))
          .digest('hex'),
      })),
    });
  } finally {
    await inventory.close();
  }
  log({
    check: 'AZURE_ISOLATED_PILOT',
    status: 'PASS',
    sourceBundleSha256: process.env.BUNDLE_SHA256,
    completedChecks: [...completedChecks],
  });
}

async function cleanupTestDeadLetters() {
  stage = 'test-dlq-cleanup';
  const namespace = process.env.G6_SERVICE_BUS_TEST_NAMESPACE ?? '';
  assert.match(namespace, /^g6-sb-test-[a-z0-9-]+\.servicebus\.windows\.net$/);
  const manifest = JSON.parse(process.env.G6_TEST_DLQ_CLEANUP_MANIFEST);
  assert.equal(manifest.namespace, namespace);
  assert.ok(
    Array.isArray(manifest.messages) &&
      manifest.messages.length > 0 &&
      manifest.messages.length <= 20,
  );
  const expected = new Map();
  for (const item of manifest.messages) {
    assert.match(item.messageId, /^[0-9a-f-]{36}$/i);
    assert.match(item.bodySha256, /^[0-9a-f]{64}$/);
    assert.equal(item.reason, 'INVALID_PRICING_CONTRACT');
    assert.ok(!expected.has(item.messageId));
    expected.set(item.messageId, item);
  }
  const client = new ServiceBusClient(
    namespace,
    new ManagedIdentityCredential({
      clientId: process.env.G6_AUDIT_TEST_CLIENT_ID,
    }),
    { retryOptions: { maxRetries: 0, timeoutInMs: 5000 } },
  );
  resources.push(() => client.close());
  const receiver = client.createReceiver(AUDIT_PILOT_QUEUE, {
    subQueueType: 'deadLetter',
    receiveMode: 'peekLock',
  });
  resources.push(() => receiver.close());
  const matches = (message) => {
    const item = expected.get(message.messageId);
    return (
      item &&
      message.deadLetterReason === item.reason &&
      createHash('sha256').update(Buffer.from(message.body)).digest('hex') ===
        item.bodySha256
    );
  };
  const peeked = await receiver.peekMessages(20);
  assert.equal(peeked.length, expected.size);
  assert.ok(peeked.every(matches), 'UNREVIEWED_DLQ_MESSAGE');
  const completed = [];
  while (completed.length < expected.size) {
    const messages = await receiver.receiveMessages(20, {
      maxWaitTimeInMs: 5000,
    });
    assert.ok(messages.length, 'REVIEWED_MESSAGES_NOT_RECEIVED');
    for (const message of messages) {
      if (!matches(message) || completed.includes(message.messageId)) {
        await receiver.abandonMessage(message);
        throw new Error('UNREVIEWED_DLQ_MESSAGE');
      }
      await receiver.completeMessage(message);
      completed.push(message.messageId);
    }
  }
  log({
    check: 'REVIEWED_TEST_DLQ_DISPOSITION',
    status: 'PASS',
    namespace,
    completed,
    archivedManifest: manifest,
    sourceBundleSha256: process.env.BUNDLE_SHA256,
  });
}

try {
  if (process.env.G6_TEST_DLQ_CLEANUP_MANIFEST) await cleanupTestDeadLetters();
  else await main();
} catch (error) {
  // Deliberately exclude raw SDK/SQL errors, tokens, connection strings and payloads.
  const code = [
    'UnauthorizedAccess',
    'ServiceCommunicationProblem',
    'ServiceTimeout',
    'MessagingEntityNotFound',
    'ERR_ASSERTION',
  ].includes(error?.code)
    ? error.code
    : 'PILOT_CHECK_FAILED';
  log({ check: 'AZURE_ISOLATED_PILOT', status: 'FAIL', stage, code });
  process.exitCode = 1;
} finally {
  for (const close of resources.reverse()) {
    try {
      await close();
    } catch {}
  }
}
