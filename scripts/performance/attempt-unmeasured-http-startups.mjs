import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const outputDirectory = resolve(
  process.env.G6_PERFORMANCE_OUTPUT ?? '.ci/performance',
);
const scratch = await mkdtemp(join(tmpdir(), 'g6-http-startup-attempt-'));
const password = `attempt-${randomUUID()}`;

function safe(value) {
  return String(value)
    .replaceAll(password, '[redacted-test-password]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .slice(-8000);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

async function start(spec) {
  const port = await freePort();
  const environment = {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'test',
    [spec.portKey]: String(port),
    ...spec.environment,
  };
  const child = spawn(process.execPath, [resolve(spec.entry)], {
    cwd: scratch,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let logs = '';
  child.stdout.on('data', (data) => (logs += String(data)));
  child.stderr.on('data', (data) => (logs += String(data)));
  const startedAt = Date.now();
  let livenessStatus = null;
  let readinessStatus = null;
  let readinessBody = '';
  const healthUrl = `http://127.0.0.1:${port}${spec.livenessPath}`;
  const readyUrl = `http://127.0.0.1:${port}${spec.readinessPath}`;

  try {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(healthUrl, {
          signal: AbortSignal.timeout(750),
        });
        await response.arrayBuffer();
        if (response.status < 500) {
          livenessStatus = response.status;
          break;
        }
      } catch {
        await delay(200);
      }
    }
    if (livenessStatus !== null) {
      try {
        const ready = await fetch(readyUrl, {
          signal: AbortSignal.timeout(2500),
        });
        readinessStatus = ready.status;
        readinessBody = safe(await ready.text());
      } catch (error) {
        readinessBody = `probe_error=${error?.name ?? 'Error'}`;
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        delay(3000).then(() => child.kill('SIGKILL')),
      ]);
    }
  }

  return {
    evidenceClass: 'HTTP_PROCESS_STARTUP_ATTEMPT_NOT_PERFORMANCE',
    service: spec.service,
    sha: process.env.GITHUB_SHA ?? 'local-unset',
    command: `node ${spec.entry}`,
    envKeysProvided: Object.keys(environment).sort(),
    dependencyProbeTarget: spec.dependencyProbeTarget,
    livenessPath: spec.livenessPath,
    readinessPath: spec.readinessPath,
    livenessHttpStatus: livenessStatus,
    readinessHttpStatus: readinessStatus,
    readinessBody,
    processExitCode: child.exitCode,
    processSignal: child.signalCode,
    startupDurationMs: Date.now() - startedAt,
    classification:
      livenessStatus === null
        ? 'PROCESS_DID_NOT_REACH_HTTP_LIVENESS'
        : readinessStatus === 200
          ? 'PROCESS_READY_WITH_TEST_ENDPOINTS_ONLY_NOT_PERFORMANCE'
          : 'PROCESS_HTTP_STARTED_BUT_DEPENDENCIES_NOT_READY_NOT_PERFORMANCE',
    logs: safe(logs),
    businessRouteLoad:
      'NOT_RUN: no official schema/data fixture in startup-attempt job',
  };
}

const certificate = join(scratch, 'test-root.crt');
const certKey = join(scratch, 'test-root.key');
const issuer = 'http://127.0.0.1:1/test-issuer';
const commonAuth = {
  G6_SECURITY_MODE: 'SIMULATED_AUTH',
  SIMULATED_AUTH_ISSUER: issuer,
  SIMULATED_AUTH_JWKS_URL: `${issuer}/jwks`,
};
const openssl = spawn(
  process.env.OPENSSL_BIN ?? 'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    certKey,
    '-out',
    certificate,
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ],
  { stdio: 'ignore' },
);
await new Promise((resolveExit) => openssl.once('exit', resolveExit));

const attempts = [];
for (const spec of [
  {
    service: 'Promotions',
    entry: 'dist/apps/promotions-svc/main.js',
    portKey: 'PROMOTIONS_SVC_PORT',
    livenessPath: '/health',
    readinessPath: '/health/ready',
    dependencyProbeTarget:
      'PostgreSQL TLS + RabbitMQ:127.0.0.1:1 (isolated unavailable target)',
    environment: {
      ...commonAuth,
      PGHOST: '127.0.0.1',
      PGPORT: '1',
      PGDATABASE: 'promotions_attempt',
      PGUSER: 'promotions_app',
      PGPASSWORD: password,
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: certificate,
      G6_DATABASE_SCHEMA: 'promotions',
      G6_CONNECTION_MODE: 'session',
      RABBITMQ_URL: 'amqp://attempt:attempt@127.0.0.1:1/%2f',
      PROMOTIONS_DEPENDENCY_PROBES_ENABLED: 'true',
      PROMOTIONS_COUPON_RUNTIME_ENABLED: 'false',
      GATEWAY_DEMO_NO_AUTH_ENABLED: 'false',
    },
  },
  {
    service: 'Price Audit',
    entry: 'dist/apps/price-audit-svc/main.js',
    portKey: 'PRICE_AUDIT_SVC_PORT',
    livenessPath: '/health/live',
    readinessPath: '/health/ready',
    dependencyProbeTarget:
      'PostgreSQL + RabbitMQ:127.0.0.1:1 (isolated unavailable target)',
    environment: {
      ...commonAuth,
      DATABASE_URL: `postgresql://audit_app:${encodeURIComponent(password)}@127.0.0.1:1/audit_attempt?sslmode=disable`,
      PRICE_AUDIT_AMQP_URL: 'amqp://attempt:attempt@127.0.0.1:1/%2f',
    },
  },
  {
    service: 'Bulk',
    entry: 'dist/apps/bulk-svc/main.js',
    portKey: 'BULK_SVC_PORT',
    livenessPath: '/health',
    readinessPath: '/health/readiness',
    dependencyProbeTarget:
      'PostgreSQL:127.0.0.1:1 (isolated unavailable target)',
    environment: {
      ...commonAuth,
      DATABASE_URL: `postgresql://bulk_app:${encodeURIComponent(password)}@127.0.0.1:1/bulk_attempt?sslmode=disable`,
    },
  },
]) {
  attempts.push(await start(spec));
}

await mkdir(outputDirectory, { recursive: true });
await writeFile(
  join(outputDirectory, 'remaining-http-startup-attempts.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      evidenceClass: 'HTTP_PROCESS_STARTUP_ATTEMPTS_NOT_PERFORMANCE',
      baselineCandidateComparison: false,
      limitation:
        'This attempt records whether the real compiled service process starts HTTP and how readiness behaves with deliberately unavailable isolated dependencies. It is not a business-route benchmark.',
      attempts,
    },
    null,
    2,
  )}\n`,
);
const columns = Object.keys(attempts[0]);
const csv = [
  columns.join(','),
  ...attempts.map((attempt) =>
    columns.map((column) => JSON.stringify(attempt[column] ?? '')).join(','),
  ),
].join('\n');
await writeFile(
  join(outputDirectory, 'remaining-http-startup-attempts.csv'),
  `${csv}\n`,
);
console.log(
  JSON.stringify(
    attempts.map(
      ({
        service,
        classification,
        livenessHttpStatus,
        readinessHttpStatus,
      }) => ({
        service,
        classification,
        livenessHttpStatus,
        readinessHttpStatus,
      }),
    ),
  ),
);
await rm(scratch, { recursive: true, force: true });
