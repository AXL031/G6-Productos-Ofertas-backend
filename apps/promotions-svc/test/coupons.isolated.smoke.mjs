import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { CouponCommandProcessor } from '../../../dist/apps/promotions-svc/coupons/coupon-transactions.js';
import { CouponOutbox } from '../../../dist/apps/promotions-svc/coupons/coupon-outbox.js';
import { CouponOutboxPump } from '../../../dist/apps/promotions-svc/coupons/coupon-outbox-pump.js';
import { CouponCommandConsumer } from '../../../dist/apps/promotions-svc/coupons/coupon-consumer.js';
import { promotionsBrokerBinding } from '../../../dist/apps/promotions-svc/coupons/event-contract.generated.js';
import { verifyAssignedEvents } from './support/assigned-event-checks.mjs';
import { verifyCouponEligibility } from './support/coupon-eligibility-checks.mjs';
import { verifyRestorationConformance } from './support/restoration-conformance-checks.mjs';
import { verifyNativeTransport } from './support/native-transport-checks.mjs';
import {
  docsRevision,
  officialMigrations,
} from './support/official-migrations.mjs';
import {
  CouponAmqpPublisher,
  CouponCommandDeliveryHandler,
} from '../../../dist/apps/promotions-svc/coupons/coupon-amqp.js';

const dependencies = createRequire(resolve('package.json'));
const { Pool } = dependencies('pg');
const amqp = dependencies('amqplib');
const created = [];
const pools = [];
let connection;
const password = randomUUID();
const checks = [];
function docker(args, env = process.env) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    env,
    timeout: 90000,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error('ISOLATED_DOCKER_OPERATION_FAILED');
  return result.stdout.trim();
}
function container(image, port, environment = {}) {
  const name = 'g6-cueva-coupons-' + randomUUID();
  const id = docker(
    [
      'run',
      '--rm',
      '--detach',
      '--name',
      name,
      '--publish',
      `127.0.0.1::${port}`,
      ...Object.keys(environment).flatMap((key) => ['--env', key]),
      image,
    ],
    { ...process.env, ...environment },
  );
  created.push(id);
  const ports = JSON.parse(
    docker(['inspect', id, '--format', '{{json .NetworkSettings.Ports}}']),
  );
  return Number(ports[`${port}/tcp`][0].HostPort);
}
async function ready(connect) {
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      return await connect();
    } catch {
      await delay(500);
    }
  }
  throw new Error('ISOLATED_SERVICE_START_TIMEOUT');
}
const command = (coupon = 'DEMO_RESTORE', overrides = {}) => ({
  message_id: randomUUID(),
  operation_id: randomUUID(),
  schema_version: 2,
  occurred_at: '2026-10-16T12:00:00Z',
  correlation_id: 'isolated-trace',
  causation_id: 'order-event',
  producer: 'modulo-ventas',
  kind: 'command',
  name: 'promotions.coupon.consumption.requested',
  data: {
    order_id: 'PED-' + randomUUID(),
    coupon_code: coupon,
    channel_id: 'MARKETPLACE',
    reservation_id: randomUUID(),
    commercial_snapshot_ref: 'test-only:durable-snapshot',
    effective_at: '2026-10-16T12:00:00Z',
  },
  ...overrides,
});
const proof = {
  verify: async ({ data }) => ({
    reservationConfirmed: true,
    snapshotDurable: true,
    eligible: true,
    orderId: data.order_id,
    reservationId: data.reservation_id,
    commercialSnapshotRef: data.commercial_snapshot_ref,
  }),
};
const restore = (consumed, operation = consumed.operation_id) =>
  command('', {
    name: 'promotions.coupon.restoration.requested',
    data: {
      order_id: consumed.data.order_id,
      cancellation_reason: 'test cancellation',
      cancelled_at: '2026-10-16T13:00:00Z',
      ...(operation ? { consumption_operation_id: operation } : {}),
    },
  });
try {
  const pgPort = container('postgres:17-alpine', 5432, {
    POSTGRES_PASSWORD: password,
  });
  const brokerPort = container('rabbitmq:4.1-alpine', 5672);
  const admin = new Pool({
    host: '127.0.0.1',
    port: pgPort,
    user: 'postgres',
    database: 'postgres',
    password,
    connectionTimeoutMillis: 1000,
  });
  pools.push(admin);
  await ready(() => admin.query('SELECT 1'));
  await admin.query(
    'CREATE ROLE po_promotions_owner NOLOGIN; CREATE ROLE po_promotions_runtime NOLOGIN; CREATE SCHEMA promotions AUTHORIZATION po_promotions_owner',
  );
  const migrationClient = await admin.connect();
  try {
    await migrationClient.query('BEGIN; SET LOCAL ROLE po_promotions_owner');
    for (const migration of await officialMigrations())
      await migrationClient.query(migration);
    await migrationClient.query('COMMIT');
  } finally {
    migrationClient.release();
  }
  // Runtime isolation applies to every acquired connection. No shared credentials are read.
  const runtime = {
    connect: async () => {
      const client = await admin.connect();
      await client.query('SET ROLE po_promotions_runtime');
      return {
        query: (sql, values) => client.query(sql, values),
        release: () => client.release(true),
      };
    },
  };
  const setup = await admin.connect();
  try {
    await setup.query('BEGIN; SET LOCAL ROLE po_promotions_owner');
    for (const [code, policy, limit, customerLimit] of [
      ['DEMO_RESTORE', 'RESTAURAR_EN_CANCELACION', 20, null],
      ['DEMO_KEEP', 'NO_RESTAURAR', 20, null],
      ['DEMO_LAST', 'RESTAURAR_EN_CANCELACION', 1, null],
      ['DEMO_RESTORE_ONCE', 'RESTAURAR_EN_CANCELACION', 1, null],
      ['DEMO_CUSTOMER', 'RESTAURAR_EN_CANCELACION', 20, 1],
    ]) {
      const id = randomUUID();
      await setup.query(
        `INSERT INTO promotions.promotions(id,name,discount_type,discount_value,modality,state,valid_from,valid_until,priority,enabled_channels)
        VALUES ($1,$2,'PORCENTAJE',10,'CUPON','ACTIVO','2026-10-01','2026-12-01',1,ARRAY['MARKETPLACE'])`,
        [id, code],
      );
      await setup.query(
        "INSERT INTO promotions.promotion_scopes(promotion_id,sku) VALUES ($1,'SYNTHETIC-ISOLATED-SKU')",
        [id],
      );
      await setup.query(
        'INSERT INTO promotions.combination_policy VALUES ($1,false,false,false)',
        [id],
      );
      await setup.query(
        `INSERT INTO promotions.coupons(promotion_id,code,state,max_global_uses,max_customer_uses,cancellation_policy)
        VALUES ($1,$2,'ACTIVO',$3,$4,$5)`,
        [id, code, limit, customerLimit, policy],
      );
    }
    await setup.query('COMMIT');
  } finally {
    setup.release();
  }
  const processor = new CouponCommandProcessor(runtime, proof);
  const first = command();
  const completed = await processor.process(first, 'modulo-ventas');
  assert.match(completed.name, /consumption.completed$/);
  const same = await processor.process(first, 'modulo-ventas');
  assert.deepEqual(same, completed);
  const retry = await processor.process(
    { ...first, message_id: randomUUID() },
    'modulo-ventas',
  );
  assert.deepEqual(retry, completed);
  checks.push('durable consumption and identical replay');

  const conflict = await processor.process(
    {
      ...first,
      message_id: randomUUID(),
      data: { ...first.data, coupon_code: 'OTHER' },
    },
    'modulo-ventas',
  );
  assert.equal(conflict.data.result_code, 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(
    () =>
      processor.process(
        { ...first, correlation_id: 'altered-envelope' },
        'modulo-ventas',
      ),
    /COUPON_COMMAND_FAILED/,
  );
  assert.equal(
    Number(
      (
        await admin.query(
          'SELECT count(*) FROM promotions.coupon_uses WHERE order_id=$1',
          [first.data.order_id],
        )
      ).rows[0].count,
    ),
    1,
  );
  checks.push('operation conflict and message collision preserve one use');

  const race = await Promise.all(
    [command('DEMO_LAST'), command('DEMO_LAST')].map((input) =>
      processor.process(input, 'modulo-ventas'),
    ),
  );
  assert.equal(
    race.filter((result) => result.name.endsWith('.completed')).length,
    1,
  );
  assert.equal(
    race.find((result) => result.name.endsWith('.rejected')).data.result_code,
    'COUPON_GLOBAL_LIMIT',
  );
  const anonymous = await processor.process(
    command('DEMO_CUSTOMER'),
    'modulo-ventas',
  );
  assert.equal(anonymous.data.result_code, 'CUSTOMER_REF_REQUERIDO');
  checks.push('concurrent last-use limit and required buyer identity');

  const unconfirmed = new CouponCommandProcessor(runtime, {
    verify: async (input, signal) => ({
      ...(await proof.verify(input, signal)),
      reservationConfirmed: false,
    }),
  });
  assert.equal(
    (await unconfirmed.process(command(), 'modulo-ventas')).data.result_code,
    'COUPON_NOT_ELIGIBLE',
  );
  const unavailable = new CouponCommandProcessor(runtime, {
    verify: async () => {
      throw new Error('test-only-private-diagnostic');
    },
  });
  const pending = command();
  await assert.rejects(
    () => unavailable.process(pending, 'modulo-ventas'),
    /COUPON_EVIDENCE_UNAVAILABLE/,
  );
  assert.equal(
    Number(
      (
        await admin.query(
          'SELECT count(*) FROM promotions.coupon_command_receipts WHERE operation_id=$1',
          [pending.operation_id],
        )
      ).rows[0].count,
    ),
    0,
  );
  checks.push(
    '202/unconfirmed is not evidence; technical failure rolls back without result',
  );

  const restored = await processor.process(restore(first), 'modulo-ventas');
  assert.equal(restored.data.outcome, 'RESTORED');
  assert.equal(
    (await processor.process(restore(first), 'modulo-ventas')).data.outcome,
    'RESTORED',
  );
  const kept = command('DEMO_KEEP');
  await processor.process(kept, 'modulo-ventas');
  assert.equal(
    (await processor.process(restore(kept), 'modulo-ventas')).data.outcome,
    'POLICY_KEEPS_CONSUMPTION',
  );
  assert.equal(
    (await processor.process(restore(command(), null), 'modulo-ventas')).data
      .outcome,
    'NO_CONSUMPTION',
  );
  assert.equal(
    (await processor.process(restore(first, randomUUID()), 'modulo-ventas'))
      .data.result_code,
    'COUPON_IDENTITY_MISMATCH',
  );
  checks.push(
    'restoration, repeated restoration, no-restore policy, no consumption and unknown reference',
  );

  // A distinct operation must not rewrite history or free an already reused slot.
  const originalUse = command('DEMO_RESTORE_ONCE');
  await processor.process(originalUse, 'modulo-ventas');
  const firstRestoration = restore(originalUse);
  const firstRestorationResult = await processor.process(
    firstRestoration,
    'modulo-ventas',
  );
  assert.equal(firstRestorationResult.data.outcome, 'RESTORED');
  const restoredHistory = async () =>
    (
      await admin.query(
        `SELECT id,coupon_id,consumed_at,restored_at,created_at,updated_at
         FROM promotions.coupon_uses WHERE order_id=$1`,
        [originalUse.data.order_id],
      )
    ).rows;
  const historyAfterFirst = await restoredHistory();
  assert.equal(historyAfterFirst.length, 1);
  assert.equal(
    historyAfterFirst[0].restored_at.toISOString(),
    '2026-10-16T13:00:00.000Z',
  );
  assert.deepEqual(
    await processor.process(
      { ...firstRestoration, message_id: randomUUID() },
      'modulo-ventas',
    ),
    firstRestorationResult,
  );
  // The first restoration permits exactly one replacement consumption.
  assert.match(
    (await processor.process(command('DEMO_RESTORE_ONCE'), 'modulo-ventas'))
      .name,
    /consumption.completed$/,
  );
  assert.equal(
    (await processor.process(command('DEMO_RESTORE_ONCE'), 'modulo-ventas'))
      .data.result_code,
    'COUPON_GLOBAL_LIMIT',
  );
  const secondRestoration = restore(originalUse);
  secondRestoration.data.cancelled_at = '2026-10-16T14:00:00Z';
  assert.notEqual(
    secondRestoration.operation_id,
    firstRestoration.operation_id,
  );
  const secondRestorationResult = await processor.process(
    secondRestoration,
    'modulo-ventas',
  );
  assert.equal(secondRestorationResult.data.outcome, 'RESTORED');
  assert.deepEqual(
    await processor.process(
      { ...secondRestoration, message_id: randomUUID() },
      'modulo-ventas',
    ),
    secondRestorationResult,
  );
  assert.deepEqual(await restoredHistory(), historyAfterFirst);
  assert.equal(
    (await processor.process(command('DEMO_RESTORE_ONCE'), 'modulo-ventas'))
      .data.result_code,
    'COUPON_GLOBAL_LIMIT',
  );
  assert.deepEqual(
    (
      await admin.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE restored_at IS NULL)::int AS active,
                count(*) FILTER (WHERE restored_at IS NOT NULL)::int AS restored
         FROM promotions.coupon_uses WHERE coupon_id=$1`,
        [historyAfterFirst[0].coupon_id],
      )
    ).rows[0],
    { total: 2, active: 1, restored: 1 },
  );
  checks.push(
    'distinct restoration operations and redeliveries preserve restored_at/history and release the last slot only once',
  );

  const ambiguous = command();
  await processor.process(ambiguous, 'modulo-ventas');
  await processor.process(
    command('DEMO_KEEP', {
      data: { ...ambiguous.data, coupon_code: 'DEMO_KEEP' },
    }),
    'modulo-ventas',
  );
  assert.equal(
    (await processor.process(restore(ambiguous, null), 'modulo-ventas')).data
      .result_code,
    'COUPON_IDENTITY_MISMATCH',
  );
  assert.equal(
    (await processor.process(restore(ambiguous), 'modulo-ventas')).data.outcome,
    'RESTORED',
  );
  assert.equal(
    Number(
      (
        await admin.query(
          'SELECT count(*) FROM promotions.coupon_uses WHERE order_id=$1 AND restored_at IS NOT NULL',
          [ambiguous.data.order_id],
        )
      ).rows[0].count,
    ),
    1,
  );
  checks.push(
    'ambiguous fallback rejected; explicit consumption identity restores only its own use',
  );

  checks.push(
    await verifyRestorationConformance({ processor, admin, command, restore }),
  );

  const brokenPool = {
    connect: async () => {
      const client = await runtime.connect();
      return {
        release: () => client.release(),
        query: async (sql, values) => {
          if (sql.includes('INSERT INTO promotions.outbox'))
            throw new Error('synthetic-outbox-write-failure');
          return client.query(sql, values);
        },
      };
    },
  };
  const brokenCommand = command();
  let acknowledged = false;
  await assert.rejects(
    () =>
      new CouponCommandDeliveryHandler(
        new CouponCommandProcessor(brokenPool, proof),
      ).handle(
        {
          content: Buffer.from(JSON.stringify(brokenCommand)),
          properties: { contentType: 'application/json' },
          fields: { exchange: 'po.comandos.x', routingKey: brokenCommand.name },
        },
        'modulo-ventas',
        () => {
          acknowledged = true;
        },
      ),
    /COUPON_COMMAND_FAILED/,
  );
  assert.equal(acknowledged, false);
  assert.equal(
    Number(
      (
        await admin.query(
          'SELECT count(*) FROM promotions.coupon_uses WHERE order_id=$1',
          [brokenCommand.data.order_id],
        )
      ).rows[0].count,
    ),
    0,
  );
  assert.equal(
    Number(
      (
        await admin.query(
          'SELECT count(*) FROM promotions.coupon_command_receipts WHERE operation_id=$1',
          [brokenCommand.operation_id],
        )
      ).rows[0].count,
    ),
    0,
  );
  checks.push(
    'outbox insert failure rolls back effect, receipt and inbox without ACK',
  );

  // A real delivery is ACKed only after a fresh connection observes its committed result.
  connection = await ready(() =>
    amqp.connect({
      protocol: 'amqp',
      hostname: '127.0.0.1',
      port: brokerPort,
      username: 'guest',
      password: 'guest',
    }),
  );
  connection.on('error', () => undefined);
  const channel = await connection.createConfirmChannel();
  channel.on('error', () => undefined);
  await channel.assertExchange('po.comandos.x', 'topic', { durable: true });
  await channel.assertExchange('po.resultados.x', 'topic', { durable: true });
  await channel.assertExchange('po.eventos.x', 'topic', { durable: true });
  await channel.assertQueue('po.promociones.q', {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  for (const binding of promotionsBrokerBinding.bindings)
    await channel.bindQueue(
      'po.promociones.q',
      binding.exchange,
      binding.routing_key,
    );
  const results = await channel.assertQueue('', { exclusive: true });
  await channel.bindQueue(
    results.queue,
    'po.resultados.x',
    'promotions.coupon.#',
  );
  checks.push(
    ...(await verifyNativeTransport({
      brokerPort,
      brokerContainer: created[1],
      channel,
      resultsQueue: results.queue,
      docker,
    })),
  );
  const brokerCommand = command();
  const receiving = await connection.createChannel();
  receiving.on('error', () => undefined);
  let committedAtAck;
  const originalAck = receiving.ack.bind(receiving);
  receiving.ack = (message) => {
    committedAtAck = admin.query(
      'SELECT status FROM promotions.coupon_command_receipts WHERE operation_id=$1',
      [brokerCommand.operation_id],
    );
    originalAck(message);
  };
  const worker = new CouponCommandConsumer(
    receiving,
    new CouponCommandDeliveryHandler(processor),
    {
      authenticatedActor: async (delivery) => {
        assert.equal(delivery.properties.userId, 'guest');
        return 'modulo-ventas'; // Explicit identity mapping only for the isolated test broker.
      },
      handleOtherAssignedEvent: async () => {
        throw new Error('unimplemented-test-event');
      },
      failed: () => {
        throw new Error('unexpected-test-consumer-failure');
      },
    },
  );
  await worker.start();
  channel.publish(
    'po.comandos.x',
    brokerCommand.name,
    Buffer.from(JSON.stringify(brokerCommand)),
    {
      persistent: true,
      contentType: 'application/json',
      messageId: brokerCommand.message_id,
      userId: 'guest',
    },
  );
  await channel.waitForConfirms();
  await ready(async () => {
    if (!committedAtAck) throw new Error('WAIT');
    return committedAtAck;
  });
  assert.equal((await committedAtAck).rows[0].status, 'COMPLETED');
  await worker.stop();
  checks.push(
    'continuous AMQP subscription, explicit test identity and ACK after durable commit',
  );

  const lostAckCommand = command();
  channel.publish(
    'po.comandos.x',
    lostAckCommand.name,
    Buffer.from(JSON.stringify(lostAckCommand)),
    { persistent: true, contentType: 'application/json' },
  );
  await channel.waitForConfirms();
  const interrupted = await connection.createChannel();
  const lostDelivery = await ready(async () => {
    const message = await interrupted.get('po.promociones.q', { noAck: false });
    if (!message) throw new Error('WAIT');
    return message;
  });
  await assert.rejects(
    () =>
      new CouponCommandDeliveryHandler(processor).handle(
        lostDelivery,
        'modulo-ventas',
        () => {
          throw new Error('synthetic-lost-ack');
        },
      ),
    /synthetic-lost-ack/,
  );
  await interrupted.close();
  const redelivered = await ready(async () => {
    const message = await channel.get('po.promociones.q', { noAck: false });
    if (!message) throw new Error('WAIT');
    return message;
  });
  assert.equal(redelivered.fields.redelivered, true);
  await new CouponCommandDeliveryHandler(processor).handle(
    redelivered,
    'modulo-ventas',
    () => channel.ack(redelivered),
  );
  assert.equal(
    Number(
      (
        await admin.query(
          'SELECT count(*) FROM promotions.coupon_uses WHERE order_id=$1',
          [lostAckCommand.data.order_id],
        )
      ).rows[0].count,
    ),
    1,
  );
  checks.push(
    'real broker redelivery after lost ACK does not repeat the effect',
  );

  const failedPublish = new CouponOutbox(runtime, {
    publishConfirmed: async () => {
      throw new Error('test-only-private-error');
    },
  });
  assert.equal(await failedPublish.publishOne(), 'pending');
  const pendingRows = await admin.query(
    'SELECT last_error,published_at FROM promotions.outbox WHERE last_error IS NOT NULL',
  );
  assert.equal(pendingRows.rows[0].last_error, 'PUBLISH_NOT_CONFIRMED');
  assert.equal(pendingRows.rows[0].published_at, null);
  const outbox = new CouponOutbox(runtime, new CouponAmqpPublisher(channel));
  let published = 0;
  const pump = new CouponOutboxPump(
    {
      publishOne: async () => {
        const outcome = await outbox.publishOne();
        if (outcome === 'published') published++;
        return outcome;
      },
    },
    () => undefined,
  );
  pump.start();
  try {
    await ready(async () => {
      const pending = await admin.query(
        'SELECT count(*) FROM promotions.outbox WHERE published_at IS NULL',
      );
      if (Number(pending.rows[0].count) !== 0)
        throw new Error('OUTBOX_STILL_PENDING');
    });
  } finally {
    await pump.stop();
  }
  assert.ok(published > 0);
  const received = await channel.get(results.queue, { noAck: true });
  assert.ok(received);
  assert.equal(JSON.parse(received.content).kind, 'result');
  assert.equal(
    Number(
      (
        await admin.query(
          'SELECT count(*) FROM promotions.outbox WHERE published_at IS NULL',
        )
      ).rows[0].count,
    ),
    0,
  );
  checks.push(
    'continuous Outbox pump recovers pending rows with real broker confirms and drains before shutdown',
  );
  checks.push(
    ...(await verifyAssignedEvents({
      pool: runtime,
      admin,
      connection,
      channel,
      commandHandler: new CouponCommandDeliveryHandler(processor),
    })),
  );
  checks.push(
    ...(await verifyCouponEligibility({
      pool: runtime,
      admin,
      command,
      restore,
      connection,
      channel,
    })),
  );
  await channel.close();
  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        environment: 'DISPOSABLE_LOCAL_ONLY',
        checks,
        migrations: 'official 0001–0004 unchanged',
        source_commit: execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
          windowsHide: true,
        }).trim(),
        normative_commit: docsRevision,
        working_tree: execFileSync(
          'git',
          [
            'status',
            '--porcelain',
            '--untracked-files=no',
            '--',
            'apps/promotions-svc/src',
            'apps/promotions-svc/test',
            'package.json',
            'package-lock.json',
          ],
          { encoding: 'utf8', windowsHide: true },
        ).trim()
          ? 'MODIFIED'
          : 'CLEAN',
        captured_at: new Date().toISOString(),
        postgres_version: (await admin.query('SHOW server_version')).rows[0]
          .server_version,
        images: ['postgres:17-alpine', 'rabbitmq:4.1-alpine'].map((image) => ({
          image,
          digests: JSON.parse(
            docker([
              'image',
              'inspect',
              image,
              '--format',
              '{{json .RepoDigests}}',
            ]),
          ),
        })),
        shared_writes: false,
        evidence:
          'synthetic isolated provider; no G5/Inventory integration or homologation',
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    error instanceof assert.AssertionError
      ? 'ISOLATED_ASSERTION_FAILED: ' + error.message
      : 'ISOLATED_SMOKE_FAILED',
  );
  process.exitCode = 1;
} finally {
  if (connection) await connection.close().catch(() => undefined);
  for (const pool of pools) await pool.end();
  for (const id of created.reverse()) docker(['rm', '--force', id]);
}
