// Compiled production probes against disposable real PostgreSQL TLS/RabbitMQ.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rootCertificates } from 'node:tls';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import {
  PromotionsConfigService,
  validatePromotionsConfiguration,
} from '../../../dist/apps/promotions-svc/infrastructure/config/promotions-config.js';
import { PromotionsReadinessService } from '../../../dist/apps/promotions-svc/health/promotions-readiness.service.js';
import { nativePromotionsDependencyProbes } from '../../../dist/apps/promotions-svc/health/promotions-dependency-probes.js';

const require = createRequire(import.meta.url);
const { Client } = require('pg');
const amqp = require('amqplib');
const directory = mkdtempSync(join(tmpdir(), 'g6-cueva-probes-'));
const created = [];
const password = randomUUID();
let connection;
let client;
const checks = [];
let stage = 'certificate';
function docker(args, environment = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 90000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...environment },
  }).trim();
}
function start(image, port, environment, args = []) {
  const id = docker(
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      'g6-cueva-probes-' + randomUUID(),
      '--publish',
      `127.0.0.1::${port}`,
      ...Object.keys(environment).flatMap((key) => ['--env', key]),
      ...args,
      image,
      ...(image.startsWith('postgres')
        ? [
            'sh',
            '-c',
            'cp /test-tls/server.key /tmp/probe-server.key && chmod 600 /tmp/probe-server.key && chown postgres /tmp/probe-server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/test-tls/server.crt -c ssl_key_file=/tmp/probe-server.key',
          ]
        : []),
    ],
    environment,
  );
  created.push(id);
  return Number(
    JSON.parse(
      docker(['inspect', id, '--format', '{{json .NetworkSettings.Ports}}']),
    )[`${port}/tcp`][0].HostPort,
  );
}
async function ready(operation) {
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      return await operation();
    } catch {
      await delay(500);
    }
  }
  throw new Error('ISOLATED_SERVICE_START_TIMEOUT');
}
try {
  // Match the other isolated runners: use an existing OpenSSL installation
  // when supplied, without requiring a separate Python package installation.
  if (process.env.G6_TEST_OPENSSL) {
    execFileSync(
      process.env.G6_TEST_OPENSSL,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=isolated-probe-test',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-keyout',
        join(directory, 'server.key'),
        '-out',
        join(directory, 'server.crt'),
      ],
      { stdio: 'pipe', windowsHide: true },
    );
  } else
    execFileSync(
      process.env.G6_TEST_PYTHON ?? 'python',
      [
        resolve('apps/promotions-svc/test/support/create-probe-certificate.py'),
        directory,
      ],
      { stdio: 'pipe', windowsHide: true },
    );
  const certificate = join(directory, 'server.crt');
  const unrelated = join(directory, 'untrusted.crt');
  writeFileSync(unrelated, rootCertificates[0]);
  stage = 'postgres-container';
  const pgPort = start(
    'postgres:17-alpine',
    5432,
    { POSTGRES_PASSWORD: password },
    ['--mount', `type=bind,source=${directory},target=/test-tls,readonly`],
  );
  stage = 'rabbitmq-container';
  const brokerPort = start('rabbitmq:4.1-alpine', 5672, {
    RABBITMQ_DEFAULT_USER: 'probe',
    RABBITMQ_DEFAULT_PASS: password,
  });
  const pgSettings = {
    host: '127.0.0.1',
    port: pgPort,
    user: 'postgres',
    password,
    database: 'postgres',
    ssl: {
      rejectUnauthorized: true,
      ca: (await import('node:fs')).readFileSync(certificate, 'utf8'),
    },
    connectionTimeoutMillis: 750,
  };
  stage = 'postgres-tls';
  client = await ready(async () => {
    const candidate = new Client(pgSettings);
    try {
      await candidate.connect();
      return candidate;
    } catch (error) {
      await candidate.end().catch(() => undefined);
      throw error;
    }
  });
  const brokerUrl = `amqp://probe:${password}@127.0.0.1:${brokerPort}`;
  stage = 'rabbitmq-authentication';
  connection = await ready(() => amqp.connect(brokerUrl, { timeout: 750 }));
  connection.on('error', () => undefined);
  const channel = await connection.createChannel();
  await channel.assertQueue('po.promociones.q', {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  channel.sendToQueue(
    'po.promociones.q',
    Buffer.from('synthetic-probe-preservation-check'),
  );
  const environment = {
    NODE_ENV: 'test',
    PGHOST: '127.0.0.1',
    PGPORT: String(pgPort),
    PGUSER: 'postgres',
    PGPASSWORD: password,
    PGDATABASE: 'postgres',
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: certificate,
    G6_DATABASE_SCHEMA: 'promotions',
    G6_CONNECTION_MODE: 'session',
    RABBITMQ_URL: brokerUrl,
    PROMOTIONS_DEPENDENCY_PROBES_ENABLED: 'true',
  };
  const service = (overrides = {}) =>
    new PromotionsReadinessService(
      nativePromotionsDependencyProbes(
        new PromotionsConfigService(
          validatePromotionsConfiguration({ ...environment, ...overrides }),
        ),
      ),
    );
  const check = (overrides = {}) => service(overrides).check();
  stage = 'disabled-probes';
  assert.deepEqual(
    (await check({ PROMOTIONS_DEPENDENCY_PROBES_ENABLED: 'false' }))
      .dependencies,
    { database: 'disabled', broker: 'disabled' },
  );
  checks.push('default-disabled probes never claim readiness');
  stage = 'positive-probes';
  assert.deepEqual((await check()).dependencies, {
    database: 'up',
    broker: 'up',
  });
  stage = 'ssl-session-check';
  const ssl = await client.query(
    'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()',
  );
  assert.equal(ssl.rows[0].ssl, true);
  checks.push(
    'production probes execute authenticated PostgreSQL TLS SELECT and passive AMQP queue check',
  );
  stage = 'invalid-database-password';
  assert.deepEqual((await check({ PGPASSWORD: randomUUID() })).dependencies, {
    database: 'down',
    broker: 'up',
  });
  checks.push('invalid database password is down');
  stage = 'untrusted-certificate';
  assert.deepEqual((await check({ PGSSLROOTCERT: unrelated })).dependencies, {
    database: 'down',
    broker: 'up',
  });
  checks.push('untrusted certificate fails; verify-full is preserved');
  stage = 'invalid-broker-password';
  const rejected = await check({
    RABBITMQ_URL: `amqp://probe:${randomUUID()}@127.0.0.1:${brokerPort}`,
  });
  assert.deepEqual(rejected.dependencies, { database: 'up', broker: 'down' });
  assert.ok(!JSON.stringify(rejected).includes(password));
  checks.push(
    'broker authentication failure is down without private diagnostics',
  );
  stage = 'queue-preservation';
  const queue = await channel.checkQueue('po.promociones.q');
  assert.equal(queue.consumerCount, 0);
  assert.equal(queue.messageCount, 1);
  checks.push('all probes preserve queued messages and create zero consumers');
  stage = 'test-fixture-queue-cleanup';
  const queued = await channel.get('po.promociones.q', { noAck: false });
  assert.ok(queued);
  channel.ack(queued);
  // RabbitMQ 4.1 quorum does not support conditional deletion. This fixture
  // owns the entire disposable broker and already verified zero consumers.
  await channel.deleteQueue('po.promociones.q');
  stage = 'missing-queue';
  assert.deepEqual((await check()).dependencies, {
    database: 'up',
    broker: 'down',
  });
  checks.push(
    'missing contractual queue stays down; probe does not create topology',
  );
  stage = 'http-only-profile';
  const monitor = service();
  assert.equal((await monitor.check()).status, 'not_ready');
  assert.deepEqual(await monitor.check(false), {
    status: 'ready',
    service: 'promotions-svc',
    dependencies: { database: 'up', broker: 'disabled' },
  });
  checks.push(
    'HTTP-only technical readiness does not require the unused broker',
  );
  stage = 'broker-recovery';
  await channel.assertQueue('po.promociones.q', {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  assert.equal((await monitor.check()).status, 'ready');
  checks.push('same readiness instance recovers after the queue is restored');
  stage = 'application-shutdown';
  monitor.beforeApplicationShutdown();
  assert.equal((await monitor.check()).status, 'not_ready');
  assert.equal((await monitor.check(false)).status, 'not_ready');
  checks.push('shutdown denies readiness for both profiles');
  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        scope: 'DISPOSABLE_LOCAL_ONLY',
        checks,
        postgres_version: (await client.query('SHOW server_version')).rows[0]
          .server_version,
        shared_connections: false,
        shared_writes: false,
        integration_homologation_deployment: 'NOT_EXECUTED',
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    error instanceof assert.AssertionError
      ? 'ISOLATED_PROBE_ASSERTION_FAILED: ' + error.message
      : 'ISOLATED_PROBE_SMOKE_FAILED: ' +
          stage +
          ' ' +
          String(error.message).split(password).join('[redacted]'),
  );
  if (error.stderr)
    console.error(
      String(error.stderr).split(password).join('[redacted]').slice(-1800),
    );
  process.exitCode = 1;
} finally {
  await connection?.close().catch(() => undefined);
  await client?.end().catch(() => undefined);
  for (const id of created.reverse()) docker(['rm', '--force', id]);
  assert.ok(
    resolve(directory).startsWith(
      resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'),
    ),
  );
  rmSync(directory, { recursive: true, force: true });
}
