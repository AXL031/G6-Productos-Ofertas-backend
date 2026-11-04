import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rootCertificates } from 'node:tls';

export function createEnvironmentFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'g6-promotions-config-'));
  const certificate = join(directory, 'root.crt');
  writeFileSync(certificate, rootCertificates[0]);
  return {
    directory,
    environment: {
      NODE_ENV: 'test',
      PROMOTIONS_DEPENDENCY_PROBES_ENABLED: 'false',
      PROMOTIONS_COUPON_RUNTIME_ENABLED: 'false',
      PROMOTIONS_SVC_PORT: '3004',
      PGHOST: 'localhost',
      PGPORT: '5432',
      PGDATABASE: 'postgres',
      PGUSER: 'promotions_dev_login',
      PGPASSWORD: 'synthetic-db-password',
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: certificate,
      G6_DATABASE_SCHEMA: 'promotions',
      G6_CONNECTION_MODE: 'session',
      RABBITMQ_URL:
        'amqp://local:synthetic-broker-password@localhost:5672/test',
    } satisfies NodeJS.ProcessEnv,
    cleanup() {
      const parent = resolve(tmpdir());
      const target = resolve(directory);
      if (
        !target.startsWith(`${parent}\\`) &&
        !target.startsWith(`${parent}/`)
      ) {
        throw new Error('Fixture directory outside temporary workspace');
      }
      rmSync(target, { recursive: true, force: true });
    },
  };
}
