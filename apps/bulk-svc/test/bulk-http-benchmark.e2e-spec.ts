import {
  createSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BulkSvcModule } from '../src/bulk-svc.module.js';
import { BulkProblemFilter } from '../src/http/bulk-problem.filter.js';
import { createValidBulkCsv } from './support/bulk-template-fixtures.js';
import { IsolatedBulkRabbitmq } from './isolated-bulk-rabbitmq.js';

describe.skipIf(process.env.G6_PERFORMANCE_HTTP !== '1')(
  'Bulk isolated real HTTP admission performance',
  () => {
    const runId = randomUUID();
    const pgName = `g6-bulk-http-${runId.slice(0, 8)}`;
    const pgPassword = randomBytes(24).toString('base64url');
    const appPassword = randomBytes(24).toString('base64url');
    const storageKey = randomBytes(24).toString('base64url');
    const bucket = 'g6-bulk-performance-private';
    const jwtKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const issuer = 'bulk-http-benchmark.test';
    const originalEnvironment = new Map<string, string | undefined>();
    const objects = new Map<string, Buffer>();
    let storageServer: Server | undefined;
    let app: INestApplication | undefined;
    let database: Pool | undefined;
    let rabbit: IsolatedBulkRabbitmq | undefined;
    let containerExists = false;
    let pgPort = 0;
    let endpoint = '';
    let token = '';
    let csv: Buffer;

    const docker = (args: string[], input?: string) =>
      execFileSync('docker', args, {
        encoding: 'utf8',
        input,
        timeout: 90000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const availablePort = async () => {
      const server = createTcpServer();
      await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolveListen);
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No loopback port');
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
      return address.port;
    };
    const setEnvironment = (key: string, value: string) => {
      if (!originalEnvironment.has(key))
        originalEnvironment.set(key, process.env[key]);
      process.env[key] = value;
    };

    beforeAll(async () => {
      pgPort = await availablePort();
      docker([
        'run',
        '--detach',
        '--name',
        pgName,
        '--publish',
        `127.0.0.1:${pgPort}:5432`,
        '--env',
        `POSTGRES_PASSWORD=${pgPassword}`,
        '--env',
        'POSTGRES_DB=bulk_benchmark',
        'postgres:17-alpine',
        '-c',
        'shared_preload_libraries=pg_stat_statements',
      ]);
      containerExists = true;
      const adminUrl = `postgresql://postgres:${pgPassword}@127.0.0.1:${pgPort}/bulk_benchmark?sslmode=disable`;
      const appUrl = `postgresql://bulk_fixture_app:${appPassword}@127.0.0.1:${pgPort}/bulk_benchmark?sslmode=disable`;
      database = new Pool({ connectionString: adminUrl, max: 4 });
      let ready = false;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
          await database.query('SELECT 1');
          ready = true;
          break;
        } catch {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        }
      }
      if (!ready)
        throw new Error('Bulk benchmark PostgreSQL 17 did not become ready');
      const migration = await readFile(
        resolve('apps/bulk-svc/test/fixtures/0001_create_bulk_persistence.sql'),
        'utf8',
      );
      const snapshot = await readFile(
        resolve('apps/bulk-svc/migrations/0002_export_source_snapshot.sql'),
        'utf8',
      );
      docker(
        [
          'exec',
          '-i',
          pgName,
          'psql',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          'postgres',
          '-d',
          'bulk_benchmark',
        ],
        `CREATE ROLE po_bulk_owner NOLOGIN;
CREATE ROLE bulk_fixture_app LOGIN PASSWORD '${appPassword}';
CREATE SCHEMA bulk AUTHORIZATION po_bulk_owner;
SET ROLE po_bulk_owner;
${migration}
${snapshot}
GRANT USAGE ON SCHEMA bulk TO bulk_fixture_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA bulk TO bulk_fixture_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA bulk TO bulk_fixture_app;`,
      );
      await database.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');

      rabbit = new IsolatedBulkRabbitmq();
      await rabbit.start();
      storageServer = createHttpServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (
          request.headers.apikey !== storageKey ||
          request.headers.authorization !== `Bearer ${storageKey}`
        ) {
          response.writeHead(401).end();
          return;
        }
        if (
          request.method === 'GET' &&
          url.pathname === `/storage/v1/bucket/${bucket}`
        ) {
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ id: bucket, public: false }));
          return;
        }
        if (
          request.method === 'POST' &&
          url.pathname.startsWith(`/storage/v1/object/${bucket}/`)
        ) {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          objects.set(url.pathname, Buffer.concat(chunks));
          response.writeHead(200).end();
          return;
        }
        response.writeHead(404).end();
      });
      await new Promise<void>((resolveListen, reject) => {
        storageServer!.once('error', reject);
        storageServer!.listen(0, '127.0.0.1', resolveListen);
      });
      const storageAddress = storageServer.address();
      if (!storageAddress || typeof storageAddress === 'string')
        throw new Error('Storage fixture did not bind');

      setEnvironment('NODE_ENV', 'test');
      setEnvironment('DATABASE_URL', appUrl);
      setEnvironment('BULK_AMQP_ENABLED', 'true');
      setEnvironment('BULK_AMQP_URL', rabbit.url);
      setEnvironment('GATEWAY_DEMO_NO_AUTH_ENABLED', 'false');
      setEnvironment(
        'G7_JWT_PUBLIC_KEY',
        jwtKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      );
      setEnvironment('G7_JWT_ISSUER', issuer);
      setEnvironment('BULK_STORAGE_BUCKET', bucket);
      setEnvironment('SUPABASE_SERVICE_ROLE_KEY', storageKey);
      setEnvironment('SUPABASE_URL', `http://127.0.0.1:${storageAddress.port}`);
      const payload = (value: object) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const content = `${payload({ alg: 'RS256', typ: 'JWT' })}.${payload({ iss: issuer, sub: '00000000-0000-4000-8000-000000000001', tipo: 'acceso', iat: now, exp: now + 3600, jti: randomUUID(), roles: ['GESTOR_COMERCIAL'] })}`;
      const signer = createSign('RSA-SHA256');
      signer.update(content);
      token = `${content}.${signer.sign(jwtKeys.privateKey, 'base64url')}`;
      const module = await Test.createTestingModule({
        imports: [BulkSvcModule],
      }).compile();
      app = module.createNestApplication({ logger: false });
      app.useGlobalFilters(new BulkProblemFilter());
      await app.init();
      await app.listen(0, '127.0.0.1');
      endpoint = `${await app.getUrl()}/api/v1/carga-masiva/productos/importaciones`;
      csv = createValidBulkCsv('SKU-BULK-PERFORMANCE');
      const readyResponse = await fetch(
        `${await app.getUrl()}/health/readiness`,
        { signal: AbortSignal.timeout(10000) },
      );
      if (readyResponse.status !== 200)
        throw new Error(
          `Bulk benchmark dependencies not ready: ${readyResponse.status} ${await readyResponse.text()}`,
        );
    }, 120000);

    afterAll(async () => {
      await app?.close();
      await database?.end();
      await rabbit?.stop();
      if (storageServer)
        await new Promise<void>((resolveClose) =>
          storageServer!.close(() => resolveClose()),
        );
      for (const [key, value] of originalEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (containerExists) {
        try {
          docker(['rm', '--force', pgName]);
        } catch {
          /* disposable runner cleanup */
        }
      }
    });

    it('measures 1,000 real HTTP multipart admissions at concurrency 1/8/32', async () => {
      const path = '/api/v1/carga-masiva/productos/importaciones';
      const percent = (sorted: number[], p: number) =>
        sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
      const results: Array<Record<string, unknown>> = [];
      let failures = 0;
      let timeouts = 0;
      const queueBefore = await rabbit!.commandQueueDepth();
      const explain = (
        await database!.query(
          'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM bulk.batch_jobs ORDER BY created_at DESC LIMIT 20',
        )
      ).rows[0]?.['QUERY PLAN'];
      for (const concurrency of [1, 8, 32]) {
        for (let i = 0; i < 10; i += 1) {
          const form = new FormData();
          form.set('template_version', '2');
          form.set(
            'archivo',
            new Blob([csv], { type: 'text/csv' }),
            'productos.csv',
          );
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'x-correlation-id': randomUUID(),
            },
            body: form,
          });
          await response.arrayBuffer();
          if (response.status !== 202)
            throw new Error(`Bulk warmup HTTP ${response.status}`);
        }
        await database!.query('SELECT pg_stat_statements_reset()');
        const latencies: number[] = [];
        let responseBytes = 0;
        let rowFailures = 0;
        let rowTimeouts = 0;
        let next = 0;
        const sampleCount = 1000;
        const started = performance.now();
        await Promise.all(
          Array.from({ length: concurrency }, async () => {
            while (true) {
              const index = next++;
              if (index >= sampleCount) return;
              const form = new FormData();
              form.set('template_version', '2');
              form.set(
                'archivo',
                new Blob([csv], { type: 'text/csv' }),
                'productos.csv',
              );
              const requestStart = performance.now();
              try {
                const response = await fetch(endpoint, {
                  method: 'POST',
                  headers: {
                    authorization: `Bearer ${token}`,
                    'x-correlation-id': randomUUID(),
                  },
                  body: form,
                  signal: AbortSignal.timeout(30000),
                });
                const body = await response.arrayBuffer();
                latencies.push(performance.now() - requestStart);
                responseBytes += body.byteLength;
                if (response.status !== 202) rowFailures += 1;
              } catch (error) {
                latencies.push(performance.now() - requestStart);
                rowFailures += 1;
                if (error?.name === 'TimeoutError') rowTimeouts += 1;
              }
            }
          }),
        );
        const durationMs = performance.now() - started;
        const sorted = latencies.sort((a, b) => a - b);
        failures += rowFailures;
        timeouts += rowTimeouts;
        const stats = await database!.query<{
          calls: string;
          shared_blks_hit: string;
          shared_blks_read: string;
        }>(
          `SELECT COALESCE(sum(calls),0)::text calls, COALESCE(sum(shared_blks_hit),0)::text shared_blks_hit, COALESCE(sum(shared_blks_read),0)::text shared_blks_read FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query NOT LIKE '%pg_stat_statements%'`,
        );
        const connections = await database!.query<{
          total: number;
          active: number;
        }>(
          `SELECT count(*)::int total, count(*) FILTER (WHERE state='active')::int active FROM pg_stat_activity WHERE datname=current_database() AND usename='bulk_fixture_app'`,
        );
        results.push({
          evidenceClass: 'HTTP_PROCESS_BENCHMARK',
          service: 'bulk-svc',
          endpoint: `${path} (multipart CSV admission)`,
          variant: process.env.G6_PERFORMANCE_VARIANT ?? 'candidate',
          sha:
            process.env.G6_PERFORMANCE_SHA ??
            process.env.GITHUB_SHA ??
            'local-unset',
          concurrency,
          samples: sampleCount,
          warmupRequests: 10,
          p50Ms: percent(sorted, 0.5),
          p95Ms: percent(sorted, 0.95),
          p99Ms: percent(sorted, 0.99),
          throughputRequestsPerSecond: (sampleCount * 1000) / durationMs,
          durationMs,
          requestUrlBytes:
            Buffer.byteLength(`POST ${path} HTTP/1.1\r\n`) * sampleCount,
          requestBodyBytes: Buffer.byteLength(csv) * sampleCount,
          requestBearerBytes:
            Buffer.byteLength(`authorization: Bearer ${token}\r\n`) *
            sampleCount,
          requestMultipartOverheadBytes:
            'not captured by fetch client instrumentation',
          responseBodyBytes: responseBytes,
          failures: rowFailures,
          timeouts: rowTimeouts,
          sqlCalls: Number(stats.rows[0]?.calls ?? 0),
          sharedBlocksHit: Number(stats.rows[0]?.shared_blks_hit ?? 0),
          sharedBlocksRead: Number(stats.rows[0]?.shared_blks_read ?? 0),
          poolConnectionsObservedAfter: connections.rows[0]?.total ?? null,
          activeConnectionsObservedAfter: connections.rows[0]?.active ?? null,
          rabbitCommandQueueDepthAfter: await rabbit!.commandQueueDepth(),
        });
      }
      const output = resolve(
        process.env.G6_PERFORMANCE_OUTPUT ?? '.ci/performance',
      );
      await mkdir(output, { recursive: true });
      const profile = {
        schemaVersion: 1,
        evidenceClass: 'HTTP_PROCESS_BENCHMARK',
        benchmark: 'bulk-http-postgres-rabbitmq-storage-fixture',
        service: 'bulk-svc',
        variant: process.env.G6_PERFORMANCE_VARIANT ?? 'candidate',
        sha:
          process.env.G6_PERFORMANCE_SHA ??
          process.env.GITHUB_SHA ??
          'local-unset',
        composition:
          'Nest TestingModule HTTP listener with isolated PostgreSQL 17, real RabbitMQ and private Storage HTTP fixture; not dist/main process',
        routeCoverage: [path],
        sampleDefinition:
          '1,000 multipart admissions per concurrency after 10 warmups; each request has unique correlation UUID and disposable DB/outbox/storage state',
        requestBytesDefinition:
          'file bytes, URL and bearer bytes counted; multipart framing excluded',
        responseBytesDefinition: 'exact response body bytes',
        recovery:
          'PostgreSQL outage/recovery remains separately verified by bulk-postgres-outage.e2e-spec.ts; RabbitMQ stays available during this profile',
        messageFlow:
          'HTTP admission persists outbox and relay publishes to isolated po.catalogo.q; queue depth observed per window',
        storage:
          'Private Storage REST is a loopback HTTP fixture, not a real Supabase container',
        measurement: {
          sqlQueryCount: 'pg_stat_statements reset per concurrency window',
          sharedBuffers: 'shared_blks_hit/shared_blks_read per window',
          explainPlan: explain,
          poolOccupancy:
            'post-window pg_stat_activity snapshot; in-window peak not instrumented',
          rabbitQueueDepthBefore: queueBefore,
        },
        results,
        failures,
        timeouts,
      };
      await writeFile(
        resolve(output, 'bulk-http-profile.json'),
        `${JSON.stringify(profile, null, 2)}\n`,
      );
      const columns = Object.keys(results[0] ?? {});
      await writeFile(
        resolve(output, 'bulk-http-profile.csv'),
        `${[columns.join(','), ...results.map((row) => columns.map((key) => JSON.stringify(row[key] ?? '')).join(','))].join('\n')}\n`,
      );
      expect(failures).toBe(0);
      expect(timeouts).toBe(0);
    }, 600000);
  },
);
