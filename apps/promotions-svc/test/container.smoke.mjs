// Build Dockerfile.service for promotions-svc first. Uses only synthetic config.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';

const image =
  process.env.G6_PROMOTIONS_TEST_IMAGE ?? 'g6-service:promotions-svc-ci';
const directory = mkdtempSync(join(tmpdir(), 'g6-promotions-container-'));
const certificate = join(directory, 'root.crt');
writeFileSync(certificate, rootCertificates[0]);
const created = [];
const secret = randomUUID();
function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
try {
  const invalid = 'g6-promotions-invalid-' + randomUUID();
  created.push(invalid);
  const failed = spawnSync(
    'docker',
    ['run', '--name', invalid, '--env', 'PORT=3004', image],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 },
  );
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stdout.trim()).code, 'CONFIGURATION_INVALID');

  const valid = 'g6-promotions-valid-' + randomUUID();
  created.push(valid);
  const environment = {
    NODE_ENV: 'test',
    PORT: '3004',
    PROMOTIONS_SVC_PORT: '3004',
    PGHOST: '127.0.0.1',
    PGPORT: '1',
    PGDATABASE: 'isolated',
    PGUSER: 'isolated',
    PGPASSWORD: secret,
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: '/test-root.crt',
    G6_DATABASE_SCHEMA: 'promotions',
    G6_CONNECTION_MODE: 'session',
    RABBITMQ_URL: `amqp://isolated:${secret}@127.0.0.1:1/test`,
    PROMOTIONS_DEPENDENCY_PROBES_ENABLED: 'false',
    PROMOTIONS_COUPON_RUNTIME_ENABLED: 'false',
  };
  docker([
    'run',
    '--detach',
    '--name',
    valid,
    '--publish',
    '127.0.0.1::3004',
    '--mount',
    `type=bind,source=${certificate},target=/test-root.crt,readonly`,
    ...Object.entries(environment).flatMap(([key, value]) => [
      '--env',
      `${key}=${value}`,
    ]),
    image,
  ]);
  const ports = JSON.parse(
    docker(['inspect', valid, '--format', '{{json .NetworkSettings.Ports}}']),
  );
  const port = ports['3004/tcp'][0].HostPort;
  let healthy = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.status, 'ok');
      assert.equal(payload.service, 'promotions-svc');
      healthy =
        docker(['inspect', valid, '--format', '{{.State.Health.Status}}']) ===
        'healthy';
      if (healthy) break;
    } catch {
      /* wait for startup and the image's real healthcheck */
    }
    await delay(1000);
  }
  assert.equal(
    healthy,
    true,
    'Container must pass liveness and Docker healthcheck',
  );
  const logs = docker(['logs', valid]);
  assert.equal(
    logs.includes(secret),
    false,
    'Logs must not expose configuration values',
  );
  assert.match(logs, /APPLICATION_STARTED/);
  console.log(
    JSON.stringify({
      status: 'PASS',
      checks: [
        'invalid config exits 1',
        'valid synthetic config starts without dependencies',
        'HTTP liveness 200',
        'Docker healthcheck healthy',
        'logs exclude synthetic secrets',
      ],
      readiness: 'not asserted',
      couponRuntime: 'disabled',
    }),
  );
} finally {
  for (const name of created.reverse()) {
    try {
      docker(['rm', '--force', name]);
    } catch {
      /* already stopped */
    }
  }
  rmSync(directory, { recursive: true, force: true });
}

// The existing CI entry point also verifies the production demo TCP boundary.
await import('./restricted-demo.container.smoke.mjs');
