// Run after npm run build:promotions-svc. No DB/broker connections or credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { rootCertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const main = join(root, 'dist/apps/promotions-svc/main.js');
const directory = mkdtempSync(join(tmpdir(), 'g6-promotions-smoke-'));
const certificate = join(directory, 'root.crt');
writeFileSync(certificate, rootCertificates[0]);
const secret = 'synthetic-smoke-secret';
const environment = {
  ...process.env,
  NODE_ENV: 'test',
  PROMOTIONS_DEPENDENCY_PROBES_ENABLED: 'false',
  PROMOTIONS_COUPON_RUNTIME_ENABLED: 'false',
  PGHOST: 'localhost',
  PGPORT: '5432',
  PGDATABASE: 'postgres',
  PGUSER: 'promotions_dev_login',
  PGPASSWORD: secret,
  PGSSLMODE: 'verify-full',
  PGSSLROOTCERT: certificate,
  G6_DATABASE_SCHEMA: 'promotions',
  G6_CONNECTION_MODE: 'session',
  RABBITMQ_URL: `amqp://local:${secret}@localhost:5672/test`,
};

function launch(env) {
  const child = spawn(process.execPath, [main], {
    cwd: directory,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data.toString();
  });
  child.stderr.on('data', (data) => {
    output += data.toString();
  });
  const exited = once(child, 'exit');
  const timeout = setTimeout(() => child.kill(), 10000);
  return { child, exited, timeout, output: () => output };
}

try {
  for (const override of [
    { PGPASSWORD: undefined, PROMOTIONS_SVC_PORT: '3004' },
    { PROMOTIONS_SVC_PORT: secret },
  ]) {
    const run = launch({ ...environment, ...override });
    try {
      const [code] = await run.exited;
      assert.equal(code, 1, 'Invalid configuration must fail startup');
      assert.ok(
        !run.output().includes(secret),
        'Startup must not disclose values',
      );
      const event = JSON.parse(run.output().trim());
      assert.equal(event.code, 'CONFIGURATION_INVALID');
    } finally {
      clearTimeout(run.timeout);
      if (run.child.exitCode === null) run.child.kill();
    }
  }

  const blocked = launch({
    ...environment,
    PROMOTIONS_SVC_PORT: '3004',
    PROMOTIONS_COUPON_RUNTIME_ENABLED: 'true',
  });
  try {
    const [code] = await blocked.exited;
    assert.equal(code, 1, 'Unresolved coupon runtime must reject startup');
    assert.equal(
      JSON.parse(blocked.output().trim()).code,
      'APPLICATION_START_FAILED',
    );
    assert.ok(!blocked.output().includes(secret));
  } finally {
    clearTimeout(blocked.timeout);
    if (blocked.child.exitCode === null) blocked.child.kill();
  }

  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise((done) => reservation.close(done));

  const run = launch({ ...environment, PROMOTIONS_SVC_PORT: String(port) });
  try {
    let response;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(500),
        });
        break;
      } catch {
        assert.equal(
          run.child.exitCode,
          null,
          'Valid configuration must start',
        );
        await delay(100);
      }
    }
    assert.ok(response, 'Health must become reachable');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'ok',
      service: 'promotions-svc',
    });
    assert.ok(
      !run.output().includes(secret),
      'Successful startup must not disclose values',
    );
    assert.ok(run.output().includes('APPLICATION_STARTED'));
  } finally {
    clearTimeout(run.timeout);
    run.child.kill();
    await run.exited;
  }
  console.log(
    'PASS: compiled startup rejects invalid configuration and unapproved coupon activation, serves liveness and hides synthetic secrets. No shared DB/broker integration tested.',
  );
} finally {
  const parent = resolve(tmpdir());
  const target = resolve(directory);
  assert.ok(
    target.startsWith(`${parent}\\`) || target.startsWith(`${parent}/`),
  );
  rmSync(target, { recursive: true, force: true });
}
