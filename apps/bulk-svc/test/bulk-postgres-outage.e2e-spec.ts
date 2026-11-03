import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { Client, Pool, type PoolClient } from 'pg';
import { Test } from '@nestjs/testing';
import type { INestApplication, LoggerService } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BulkSvcModule } from '../src/bulk-svc.module.js';
import { BulkUserBearerGuard } from '../src/auth/bulk-user-bearer.guard.js';
import { BulkProblemFilter } from '../src/http/bulk-problem.filter.js';

const labelKey = 'com.g6.bulk94.audit-id';
const auditId = randomUUID();
const containerName = `g6-bulk94-pg-${process.pid}-${auditId.slice(0, 8)}`;
const databaseName = 'bulk_h4_audit';
const password = randomBytes(24).toString('base64url');
const originalEnvironment = new Map<string, string | undefined>();
const capturedLogs: string[] = [];
const sensitiveData = new RegExp(
  `${password}|postgres(?:ql)?:\\/\\/|127\\.0\\.0\\.1:\\d+|${databaseName}`,
  'i',
);

const logMessage = (...parts: unknown[]) =>
  capturedLogs.push(parts.map((part) => String(part)).join(' '));

const logger: LoggerService = {
  log: (...parts: unknown[]) => logMessage(...parts),
  error: (...parts: unknown[]) => logMessage(...parts),
  warn: (...parts: unknown[]) => logMessage(...parts),
  debug: (...parts: unknown[]) => logMessage(...parts),
  verbose: (...parts: unknown[]) => logMessage(...parts),
  fatal: (...parts: unknown[]) => logMessage(...parts),
};

function docker(args: string[], input?: string): string {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    input,
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const code = result.error?.code ?? result.status ?? 'unknown';
    throw new Error(`Docker disposable database command failed (${code}).`);
  }
  return result.stdout.trim();
}

function rememberEnvironment(key: string, value: string): void {
  if (!originalEnvironment.has(key))
    originalEnvironment.set(key, process.env[key]);
  process.env[key] = value;
}

async function findAvailableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No se pudo reservar un puerto loopback descartable.');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForDatabaseReady(
  databaseUrl: string,
  deadlineMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      docker([
        'exec',
        containerName,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'postgres',
        '-d',
        databaseName,
      ]);
      const client = new Client({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 1000,
        query_timeout: 1000,
        statement_timeout: 1000,
      });
      try {
        await client.connect();
        const result = await client.query<{ ready: number }>(
          'SELECT 1 AS ready',
        );
        if (result.rows[0]?.ready !== 1)
          throw new Error(
            'La consulta de disponibilidad no devolvió el valor esperado.',
          );
        return;
      } finally {
        await client.end().catch(() => undefined);
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('La PostgreSQL descartable no quedó disponible a tiempo.');
}

async function waitForLockWait(
  pool: Pool,
  deadlineMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND query ILIKE '%export_jobs%'
      ) AS blocked
    `);
    if (result.rows[0]?.blocked) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe('Bulk recovery after a real PostgreSQL outage (disposable Docker only)', () => {
  let app: INestApplication | undefined;
  let pool: Pool | undefined;
  let databaseUrl: string;
  let containerMayExist = false;

  beforeAll(async () => {
    const image = 'postgres:17-alpine';
    const hostPort = await findAvailableLoopbackPort();
    containerMayExist = true;
    docker([
      'run',
      '--detach',
      '--name',
      containerName,
      '--label',
      `${labelKey}=${auditId}`,
      '--publish',
      `127.0.0.1:${hostPort}:5432`,
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      '--env',
      `POSTGRES_DB=${databaseName}`,
      image,
      '-c',
      'shared_buffers=32MB',
      '-c',
      'max_connections=20',
    ]);
    databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${hostPort}/${databaseName}?sslmode=disable`;

    await waitForDatabaseReady(databaseUrl);
    const migration = `
      CREATE SCHEMA bulk;
      CREATE TYPE bulk.job_status AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED_GENERAL');
      CREATE TABLE bulk.batch_jobs (id integer);
      CREATE TABLE bulk.file_manifests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        role text NOT NULL,
        format text NOT NULL,
        content_ref text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE bulk.export_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        export_id uuid NOT NULL UNIQUE,
        status bulk.job_status NOT NULL DEFAULT 'QUEUED',
        format text NOT NULL CHECK (format IN ('CSV', 'XLSX')),
        output_file_id uuid REFERENCES bulk.file_manifests(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_export_jobs_completed_file CHECK (
          status <> 'COMPLETED' OR (output_file_id IS NOT NULL AND completed_at IS NOT NULL)
        )
      );
      CREATE INDEX ix_export_jobs_status_created_at
        ON bulk.export_jobs(status, created_at);
    `;
    docker(
      [
        'exec',
        '-i',
        containerName,
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'postgres',
        '-d',
        databaseName,
      ],
      migration,
    );

    rememberEnvironment('NODE_ENV', 'test');
    rememberEnvironment('DATABASE_URL', databaseUrl);
    rememberEnvironment('BULK_AMQP_ENABLED', 'false');
    rememberEnvironment('GATEWAY_DEMO_NO_AUTH_ENABLED', 'false');

    const moduleRef = await Test.createTestingModule({
      imports: [BulkSvcModule],
    })
      .overrideGuard(BulkUserBearerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication({ logger });
    app.useGlobalFilters(new BulkProblemFilter());
    await app.init();

    pool = new Pool({ connectionString: databaseUrl, max: 3 });
    pool.on('error', () => undefined);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    if (containerMayExist) {
      try {
        const inspected = JSON.parse(
          docker(['inspect', containerName]),
        ) as Array<{
          Config?: { Labels?: Record<string, string> };
        }>;
        if (inspected[0]?.Config?.Labels?.[labelKey] === auditId) {
          docker(['rm', '--force', containerName]);
        }
      } catch {
        // Docker may be unavailable after a failed startup; do not touch any other container.
      }
    }
  });

  it('keeps liveness up, readiness down, masks errors, then recovers durable writes', async () => {
    const server = app!.getHttpServer();
    const initialHealth = await request(server).get('/health').expect(200);
    expect(initialHealth.body).toEqual({ status: 'ok', service: 'bulk-svc' });
    await request(server)
      .get('/health/readiness')
      .expect(200)
      .expect({ status: 'ready', service: 'bulk-svc' });

    const initialCount = await pool!.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM bulk.export_jobs',
    );
    const blocker: PoolClient = await pool!.connect();
    blocker.on('error', () => undefined);
    let blockerReleased = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        'LOCK TABLE bulk.export_jobs IN ACCESS EXCLUSIVE MODE',
      );

      const failedWrite = request(server)
        .post('/api/v1/carga-masiva/productos/exportaciones')
        .send({ formato: 'CSV' })
        .then((response) => response);
      expect(await waitForLockWait(pool!)).toBe(true);

      docker(['kill', '--signal=KILL', containerName]);
      blocker.release(true);
      blockerReleased = true;

      await request(server)
        .get('/health')
        .expect(200)
        .expect({ status: 'ok', service: 'bulk-svc' });
      const notReady = await request(server)
        .get('/health/readiness')
        .expect(503);
      expect(notReady.body).toEqual({
        status: 'not_ready',
        service: 'bulk-svc',
      });

      const failure = await failedWrite;
      expect(failure.status).toBe(503);
      const responseExposedDetails = sensitiveData.test(
        JSON.stringify(failure.body),
      );
      expect(
        responseExposedDetails,
        'Failure response exposed connection details.',
      ).toBe(false);
      expect(failure.body).toMatchObject({
        status: 503,
        code: 'SERVICIO_NO_DISPONIBLE',
        detail: 'No se pudo completar la operación de persistencia.',
      });
    } finally {
      try {
        docker(['start', containerName]);
      } catch {
        // The container is already running when the failure happened before the outage.
      }
      if (!blockerReleased) blocker.release(true);
    }

    await waitForDatabaseReady(databaseUrl);
    const recoveryDeadline = Date.now() + 45_000;
    let recovered = false;
    let lastReadinessStatus = 0;
    while (!recovered && Date.now() < recoveryDeadline) {
      const response = await request(server).get('/health/readiness');
      lastReadinessStatus = response.status;
      recovered = response.status === 200;
      if (!recovered) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(
      recovered,
      `Readiness did not recover; last HTTP status: ${lastReadinessStatus}.`,
    ).toBe(true);
    await request(server)
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', service: 'bulk-svc' });

    const afterFailure = await pool!.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM bulk.export_jobs',
    );
    expect(afterFailure.rows[0]?.count).toBe(initialCount.rows[0]?.count);

    const accepted = await request(server)
      .post('/api/v1/carga-masiva/productos/exportaciones')
      .send({ formato: 'CSV' })
      .expect(202);
    const exportId = accepted.body.export_id as string;
    expect(exportId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const persistDeadline = Date.now() + 10_000;
    let persisted:
      { status: string; output_file_id: string | null } | undefined;
    while (Date.now() < persistDeadline) {
      const result = await pool!.query<{
        status: string;
        output_file_id: string | null;
      }>(
        'SELECT status, output_file_id FROM bulk.export_jobs WHERE export_id = $1',
        [exportId],
      );
      persisted = result.rows[0];
      if (persisted?.status === 'FAILED_GENERAL') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(persisted).toEqual({
      status: 'FAILED_GENERAL',
      output_file_id: null,
    });

    const finalCount = await pool!.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM bulk.export_jobs',
    );
    expect(Number(finalCount.rows[0]?.count)).toBe(
      Number(initialCount.rows[0]?.count) + 1,
    );
    const logsExposedDetails = sensitiveData.test(capturedLogs.join('\n'));
    expect(
      logsExposedDetails,
      'Application logs exposed connection details.',
    ).toBe(false);
  }, 90_000);
});
