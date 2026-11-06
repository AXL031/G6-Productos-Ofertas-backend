import {
  createSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, Pool, type PoolClient } from 'pg';
import { Test } from '@nestjs/testing';
import type { INestApplication, LoggerService } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BulkSvcModule } from '../src/bulk-svc.module.js';
import { BulkProblemFilter } from '../src/http/bulk-problem.filter.js';
import { BulkImportService } from '../src/bulk-import.service.js';
import {
  createValidBulkCsv,
  createValidBulkXlsx,
} from './support/bulk-template-fixtures.js';

const labelKey = 'com.g6.bulk94.audit-id';
const auditId = randomUUID();
const containerName = `g6-bulk94-pg-${process.pid}-${auditId.slice(0, 8)}`;
const databaseName = 'bulk_h4_audit';
const password = randomBytes(24).toString('base64url');
const applicationPassword = randomBytes(24).toString('base64url');
const storageTestKey = 'bulk-storage-test-only-key';
const storageTestBucket = 'bulk-h4-e2e-private';
const testIssuer = 'bulk-postgres-http-test-issuer';
const testJwtKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const testJwtPublicKey = testJwtKeys.publicKey
  .export({ type: 'spki', format: 'pem' })
  .toString();
const encodeJwtPart = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const testJwtHeader = encodeJwtPart({ alg: 'RS256', typ: 'JWT' });
const testJwtClaims = encodeJwtPart({
  iss: testIssuer,
  sub: 'bulk-postgres-http-test-user',
  aud: 'api-productos',
  exp: Math.floor(Date.now() / 1000) + 3600,
  roles: ['GESTOR_COMERCIAL'],
});
const testJwtSigner = createSign('RSA-SHA256');
testJwtSigner.update(`${testJwtHeader}.${testJwtClaims}`);
const testUserBearer = `${testJwtHeader}.${testJwtClaims}.${testJwtSigner.sign(testJwtKeys.privateKey, 'base64url')}`;
const originalEnvironment = new Map<string, string | undefined>();
const capturedLogs: string[] = [];
const sensitiveData = new RegExp(
  `${password}|${applicationPassword}|${storageTestKey}|postgres(?:ql)?:\\/\\/|127\\.0\\.0\\.1:\\d+|${databaseName}`,
  'i',
);
const storedObjects = new Map<string, Buffer>();
let storageUploads = 0;
let storageServer: Server | undefined;

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

function authorizedGet(
  server: ReturnType<INestApplication['getHttpServer']>,
  path: string,
) {
  return request(server)
    .get(path)
    .set('Authorization', `Bearer ${testUserBearer}`);
}

function authorizedPost(
  server: ReturnType<INestApplication['getHttpServer']>,
  path: string,
) {
  return request(server)
    .post(path)
    .set('Authorization', `Bearer ${testUserBearer}`);
}

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

async function startStorageTestServer(): Promise<string> {
  storageServer = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const segments = url.pathname.split('/').map(decodeURIComponent);
    if (
      request.headers.apikey !== storageTestKey ||
      request.headers.authorization !== `Bearer ${storageTestKey}`
    ) {
      response.writeHead(401).end();
      return;
    }
    if (
      request.method === 'GET' &&
      segments[1] === 'storage' &&
      segments[2] === 'v1' &&
      segments[3] === 'bucket' &&
      segments[4] === storageTestBucket
    ) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: storageTestBucket, public: false }));
      return;
    }
    if (
      segments[1] !== 'storage' ||
      segments[2] !== 'v1' ||
      segments[3] !== 'object' ||
      segments[4] !== storageTestBucket
    ) {
      response.writeHead(404).end();
      return;
    }
    const objectName = segments.slice(5).join('/');
    if (request.method === 'GET') {
      const bytes = storedObjects.get(objectName);
      if (!bytes) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(bytes);
      return;
    }
    if (request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      storedObjects.set(objectName, Buffer.concat(chunks));
      storageUploads++;
      response.writeHead(200).end();
      return;
    }
    response.writeHead(405).end();
  });
  await new Promise<void>((resolve, reject) => {
    storageServer!.once('error', reject);
    storageServer!.listen(0, '127.0.0.1', resolve);
  });
  const address = storageServer.address();
  if (!address || typeof address === 'string')
    throw new Error('No se pudo iniciar el sustituto HTTP local de Storage.');
  return `http://127.0.0.1:${address.port}`;
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
  let applicationDatabaseUrl: string;
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
    applicationDatabaseUrl = `postgresql://bulk_fixture_app:${applicationPassword}@127.0.0.1:${hostPort}/${databaseName}?sslmode=disable`;

    await waitForDatabaseReady(databaseUrl);
    const migration = readFileSync(
      resolve('apps/bulk-svc/test/fixtures/0001_create_bulk_persistence.sql'),
      'utf8',
    );
    const exportSnapshotMigration = readFileSync(
      resolve('apps/bulk-svc/migrations/0002_export_source_snapshot.sql'),
      'utf8',
    );
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
      `CREATE ROLE po_bulk_owner NOLOGIN;
CREATE ROLE bulk_fixture_app LOGIN PASSWORD '${applicationPassword}';
CREATE SCHEMA bulk AUTHORIZATION po_bulk_owner;
SET ROLE po_bulk_owner;
${migration}
${exportSnapshotMigration}
GRANT USAGE ON SCHEMA bulk TO bulk_fixture_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA bulk TO bulk_fixture_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA bulk TO bulk_fixture_app;`,
    );

    rememberEnvironment('NODE_ENV', 'test');
    rememberEnvironment('DATABASE_URL', applicationDatabaseUrl);
    rememberEnvironment('BULK_AMQP_ENABLED', 'false');
    rememberEnvironment('GATEWAY_DEMO_NO_AUTH_ENABLED', 'false');
    rememberEnvironment('G7_JWT_PUBLIC_KEY', testJwtPublicKey);
    rememberEnvironment('G7_JWT_ISSUER', testIssuer);
    rememberEnvironment('BULK_STORAGE_BUCKET', storageTestBucket);
    rememberEnvironment('SUPABASE_SERVICE_ROLE_KEY', storageTestKey);
    rememberEnvironment('SUPABASE_URL', await startStorageTestServer());

    const moduleRef = await Test.createTestingModule({
      imports: [BulkSvcModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger });
    app.useGlobalFilters(new BulkProblemFilter());
    await app.init();

    pool = new Pool({ connectionString: databaseUrl, max: 3 });
    pool.on('error', () => undefined);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (storageServer)
      await new Promise<void>((resolve) =>
        storageServer!.close(() => resolve()),
      );
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

  it('imports CSV and XLSX over HTTP with private Storage and durable PostgreSQL results', async () => {
    const server = app!.getHttpServer();
    const unauthenticated = await request(server)
      .get('/api/v1/carga-masiva/productos/plantilla?formato=CSV')
      .expect(401);
    expect(unauthenticated.body.code).toBe('TOKEN_INVALIDO');
    const csvTemplate = await authorizedGet(
      server,
      '/api/v1/carga-masiva/productos/plantilla?formato=CSV',
    ).expect(200);
    expect(csvTemplate.text).toContain('operacion,producto_id');
    const xlsxTemplate = await authorizedGet(
      server,
      '/api/v1/carga-masiva/productos/plantilla?formato=XLSX',
    ).expect(200);
    expect(xlsxTemplate.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    const invalidTemplate = await authorizedGet(
      server,
      '/api/v1/carga-masiva/productos/plantilla?formato=TXT',
    ).expect(400);
    expect(invalidTemplate.body).toMatchObject({
      code: 'VALIDACION',
      status: 400,
    });

    const correlationId = randomUUID();
    const csvSku = `SKU-HTTP-${randomUUID()}`;
    const csv = createValidBulkCsv(csvSku);
    const csvAdmission = await authorizedPost(
      server,
      '/api/v1/carga-masiva/productos/importaciones',
    )
      .set('x-correlation-id', correlationId)
      .field('template_version', '2')
      .attach('archivo', csv, 'productos.csv')
      .expect(202);
    expect(csvAdmission.body).toMatchObject({
      status: 'QUEUED',
      template_version: 2,
      correlation_id: correlationId,
    });
    const csvBatchId = csvAdmission.body.batch_id as string;

    const storedInput = await pool!.query<{ content_ref: string }>(
      `SELECT content_ref FROM bulk.file_manifests
       WHERE role = 'ENTRADA_IMPORTACION' AND content_ref LIKE $1`,
      [`supabase://${storageTestBucket}/imports/${csvBatchId}/%`],
    );
    expect(storedInput.rows).toHaveLength(1);
    const contentRef = storedInput.rows[0]!.content_ref;
    const objectName = contentRef.slice(
      `supabase://${storageTestBucket}/`.length,
    );
    expect(storedObjects.get(objectName)?.equals(csv)).toBe(true);
    expect(storageUploads).toBe(1);

    const outboxBeforeReplay = await pool!.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM bulk.outbox
       WHERE event_name = 'catalog.bulk.upsert.requested'
         AND payload->'data'->>'batch_id' = $1`,
      [csvBatchId],
    );
    expect(outboxBeforeReplay.rows[0]?.count).toBe(1);
    const replay = await authorizedPost(
      server,
      '/api/v1/carga-masiva/productos/importaciones',
    )
      .set('x-correlation-id', correlationId)
      .field('template_version', '2')
      .attach('archivo', csv, 'productos.csv')
      .expect(202);
    expect(replay.body.batch_id).toBe(csvBatchId);
    expect(storageUploads).toBe(1);
    const outboxAfterReplay = await pool!.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM bulk.outbox
       WHERE event_name = 'catalog.bulk.upsert.requested'
         AND payload->'data'->>'batch_id' = $1`,
      [csvBatchId],
    );
    expect(outboxAfterReplay.rows[0]?.count).toBe(1);

    const xlsx = createValidBulkXlsx(`SKU-HTTP-${randomUUID()}`);
    const xlsxCorrelationId = randomUUID();
    const xlsxAdmission = await authorizedPost(
      server,
      '/api/v1/carga-masiva/productos/importaciones',
    )
      .set('x-correlation-id', xlsxCorrelationId)
      .field('template_version', '2')
      .attach('archivo', xlsx, 'productos.xlsx')
      .expect(202);
    expect(xlsxAdmission.body).toMatchObject({
      status: 'QUEUED',
      template_version: 2,
      correlation_id: xlsxCorrelationId,
    });
    expect(storageUploads).toBe(2);
    const xlsxBatch = await authorizedGet(
      server,
      `/api/v1/carga-masiva/productos/importaciones/${xlsxAdmission.body.batch_id}`,
    ).expect(200);
    expect(xlsxBatch.body).toMatchObject({
      status: 'QUEUED',
      total_rows: 1,
      rows: [
        {
          status: 'PENDING',
          steps: expect.arrayContaining([
            expect.objectContaining({ dominio: 'CATALOGO', status: 'PENDING' }),
            expect.objectContaining({ dominio: 'PRICING', status: 'PENDING' }),
            expect.objectContaining({
              dominio: 'INVENTARIO',
              status: 'PENDING',
            }),
          ]),
        },
      ],
    });

    const malformedCsv = await authorizedPost(
      server,
      '/api/v1/carga-masiva/productos/importaciones',
    )
      .attach('archivo', Buffer.from('not a template'), 'malformed.csv')
      .expect(422);
    expect(malformedCsv.body.code).toBe('PLANTILLA_INCOMPATIBLE');
    const wrongHeaders = await authorizedPost(
      server,
      '/api/v1/carga-masiva/productos/importaciones',
    )
      .attach(
        'archivo',
        Buffer.from(csv.toString('utf8').replace('operacion,', 'operation,')),
        'headers.csv',
      )
      .expect(422);
    expect(wrongHeaders.body.code).toBe('PLANTILLA_INCOMPATIBLE');

    const imports = app!.get(BulkImportService);
    const snapshotBeforeResults = await authorizedGet(
      server,
      `/api/v1/carga-masiva/productos/importaciones/${csvBatchId}`,
    ).expect(200);
    expect(snapshotBeforeResults.body).toMatchObject({
      batch_id: csvBatchId,
      status: 'QUEUED',
      total_rows: 1,
      rows: [
        {
          status: 'PENDING',
          applied_domains: [],
          steps: expect.arrayContaining([
            expect.objectContaining({ dominio: 'CATALOGO', status: 'PENDING' }),
            expect.objectContaining({ dominio: 'PRICING', status: 'PENDING' }),
            expect.objectContaining({
              dominio: 'INVENTARIO',
              status: 'PENDING',
            }),
          ]),
        },
      ],
    });
    const rowId = snapshotBeforeResults.body.rows[0].row_id as string;
    const resultCorrelationId = correlationId;
    const catalogResult = {
      batchId: csvBatchId,
      rowId,
      domain: 'CATALOGO' as const,
      operationId: randomUUID(),
      messageId: randomUUID(),
      correlationId: resultCorrelationId,
      eventName: 'catalog.bulk.upsert.completed',
      action: 'UPSERT' as const,
      status: 'COMPLETED' as const,
    };
    await expect(
      imports.applyDomainResult(catalogResult),
    ).resolves.toMatchObject({
      processed: true,
    });
    await expect(
      imports.applyDomainResult(catalogResult),
    ).resolves.toMatchObject({
      processed: false,
    });
    await imports.applyDomainResult({
      batchId: csvBatchId,
      rowId,
      domain: 'PRICING',
      operationId: randomUUID(),
      messageId: randomUUID(),
      correlationId: resultCorrelationId,
      eventName: 'pricing.product.initialization.rejected',
      action: 'PRICE_INITIALIZATION',
      causationId: randomUUID(),
      status: 'FAILED',
      errorCode: 'PRICE_REJECTED',
      errorDetail: 'Precio rechazado para la prueba E2E.',
    });

    const partialSnapshot = await authorizedGet(
      server,
      `/api/v1/carga-masiva/productos/importaciones/${csvBatchId}`,
    ).expect(200);
    expect(partialSnapshot.body.rows[0]).toMatchObject({
      status: 'PROCESSING',
      applied_domains: ['CATALOGO'],
      failed_domain: null,
      steps: expect.arrayContaining([
        expect.objectContaining({ dominio: 'CATALOGO', status: 'COMPLETED' }),
        expect.objectContaining({
          dominio: 'PRICING',
          status: 'FAILED',
          code: 'PRICE_REJECTED',
        }),
        expect.objectContaining({ dominio: 'INVENTARIO', status: 'PENDING' }),
      ]),
    });
    await imports.applyDomainResult({
      batchId: csvBatchId,
      rowId,
      domain: 'INVENTARIO',
      operationId: randomUUID(),
      messageId: randomUUID(),
      correlationId: resultCorrelationId,
      eventName: 'inventory.sku.initialization.completed',
      action: 'SKU_INITIALIZATION',
      skuId: csvSku,
      status: 'COMPLETED',
    });

    const finalSnapshot = await authorizedGet(
      server,
      `/api/v1/carga-masiva/productos/importaciones/${csvBatchId}`,
    ).expect(200);
    expect(finalSnapshot.body).toMatchObject({
      status: 'COMPLETED',
      total_rows: 1,
      completed_rows: 0,
      failed_rows: 1,
      needs_reconciliation: true,
      rows: [
        {
          status: 'FAILED',
          applied_domains: ['CATALOGO', 'INVENTARIO'],
          failed_domain: 'PRICING',
          needs_reconciliation: true,
          code: 'PRICE_REJECTED',
          detail: 'Precio rechazado para la prueba E2E.',
        },
      ],
    });
    const report = await authorizedGet(
      server,
      `/api/v1/carga-masiva/productos/importaciones/${csvBatchId}/reporte`,
    ).expect(200);
    expect(report.headers['content-type']).toContain('text/csv');
    expect(report.text).toContain('PRICE_REJECTED');
    expect(report.text).toContain('PRICING');
    const refusedResume = await authorizedPost(
      server,
      `/api/v1/carga-masiva/productos/importaciones/${csvBatchId}/reanudar`,
    ).expect(503);
    expect(refusedResume.body.code).toBe('SERVICIO_NO_DISPONIBLE');
    expect(refusedResume.body.status).not.toBe('QUEUED');
    await authorizedGet(
      server,
      `/api/v1/carga-masiva/productos/importaciones/${csvBatchId}`,
    )
      .expect(200)
      .then((response) =>
        expect(response.body).toMatchObject({
          status: 'COMPLETED',
          failed_rows: 1,
          needs_reconciliation: true,
        }),
      );
    const invalidTransition = await authorizedPost(
      server,
      `/api/v1/carga-masiva/productos/importaciones/${csvBatchId}/reanudar`,
    ).expect(503);
    expect(invalidTransition.body.code).toBe('SERVICIO_NO_DISPONIBLE');
    const missingBatch = await authorizedGet(
      server,
      `/api/v1/carga-masiva/productos/importaciones/${randomUUID()}`,
    ).expect(404);
    expect(missingBatch.body.code).toBe('LOTE_NO_ENCONTRADO');
    expect(
      JSON.stringify([csvAdmission.body, finalSnapshot.body]),
    ).not.toContain(storageTestKey);
    expect(sensitiveData.test(capturedLogs.join('\n'))).toBe(false);
  }, 30_000);

  it('keeps liveness up, distinguishes DB outage from missing AMQP, and recovers durable writes', async () => {
    const server = app!.getHttpServer();
    const initialHealth = await request(server).get('/health').expect(200);
    expect(initialHealth.body).toEqual({ status: 'ok', service: 'bulk-svc' });
    const initialReadiness = await request(server)
      .get('/health/readiness')
      .expect(503);
    expect(initialReadiness.body).toEqual({
      status: 'not_ready',
      service: 'bulk-svc',
      reason: 'AMQP_DISABLED',
    });

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

      const failedWrite = authorizedPost(
        server,
        '/api/v1/carga-masiva/productos/exportaciones',
      )
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
        reason: 'DATABASE_UNAVAILABLE',
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
    let lastReadinessReason: string | undefined;
    while (!recovered && Date.now() < recoveryDeadline) {
      const response = await request(server).get('/health/readiness');
      lastReadinessStatus = response.status;
      lastReadinessReason = response.body.reason;
      recovered =
        response.status === 503 && response.body.reason === 'AMQP_DISABLED';
      if (!recovered) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(
      recovered,
      `Readiness did not distinguish the recovered DB from missing AMQP; last HTTP status/reason: ${lastReadinessStatus}/${lastReadinessReason}.`,
    ).toBe(true);
    await request(server)
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', service: 'bulk-svc' });

    const afterFailure = await pool!.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM bulk.export_jobs',
    );
    expect(afterFailure.rows[0]?.count).toBe(initialCount.rows[0]?.count);

    const accepted = await authorizedPost(
      server,
      '/api/v1/carga-masiva/productos/exportaciones',
    )
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
