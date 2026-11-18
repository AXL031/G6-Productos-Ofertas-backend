// Own disposable container only. No production config, shared volumes or prune.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const id = randomUUID().replaceAll('-', '').slice(0, 12);
const name = 'g6-promotions-h5-' + id;
const database = 'g6_promotions_h5_test_' + id;
const suites = {
  coupons: 'apps/promotions-svc/test/coupon-h5.postgres.e2e-spec.ts',
  inventory: 'tests/h5/inventory-promotions.postgres.e2e-spec.ts',
  taxonomy: 'tests/h5/taxonomy-service-bus.postgres.e2e-spec.ts',
};
const nameOfSuite = process.argv[2] ?? 'coupons';
if (!Object.hasOwn(suites, nameOfSuite))
  throw new Error('UNKNOWN_H5_TEST_SUITE');
const suite = suites[nameOfSuite];
const docker = (args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  }).trim();
let created = false;
try {
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--label',
    'g6.promotions.h5.fixture=' + id,
    '--publish',
    '127.0.0.1::5432',
    '--env',
    'POSTGRES_USER=postgres',
    '--env',
    'POSTGRES_PASSWORD=synthetic-h5-local-only',
    '--env',
    'POSTGRES_DB=' + database,
    'postgres:17-alpine',
  ]);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      docker(['exec', name, 'pg_isready', '-U', 'postgres', '-d', database]);
      ready = true;
      break;
    } catch {
      await delay(250);
    }
  }
  if (!ready) throw new Error('DISPOSABLE_POSTGRES_START_FAILED');
  const port = docker(['port', name, '5432/tcp']);
  if (!/^127\.0\.0\.1:\d+$/.test(port))
    throw new Error('DISPOSABLE_POSTGRES_BINDING_INVALID');
  const result = spawnSync(
    process.execPath,
    [
      resolve('node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      'vitest.config.e2e.ts',
      suite,
      '--maxWorkers=1',
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        PROMOTIONS_H5_POSTGRES_TESTS: '1',
        PROMOTIONS_H5_TEST_DATABASE_URL:
          'postgresql://postgres:synthetic-h5-local-only@' +
          port +
          '/' +
          database,
      },
      timeout: 120000,
    },
  );
  if (result.error) throw new Error('DISPOSABLE_POSTGRES_TEST_PROCESS_FAILED');
  process.exitCode = result.status ?? 1;
} finally {
  if (created) {
    try {
      const label = docker([
        'inspect',
        '--format',
        '{{index .Config.Labels "g6.promotions.h5.fixture"}}',
        name,
      ]);
      if (label !== id) {
        console.error('DISPOSABLE_POSTGRES_OWNERSHIP_MISMATCH');
        process.exitCode = 1;
      } else docker(['rm', '--force', name]);
    } catch {
      console.error('DISPOSABLE_POSTGRES_CLEANUP_NOT_CONFIRMED');
      process.exitCode = 1;
    }
  }
}
