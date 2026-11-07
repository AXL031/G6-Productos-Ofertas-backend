// Bulk runtime peer used by the disposable Catalog integration harness.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as pause } from 'node:timers/promises';
import { createServer } from 'node:http';

const config = JSON.parse(readFileSync(0, 'utf8'));
const require = createRequire(join(config.build, 'bulk-import.service.js'));
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const load = (file) => import(pathToFileURL(join(config.build, file)).href);
const { BulkImportService } = await load('bulk-import.service.js');
const { BulkPersistenceRepository } = await load(
  'persistence/bulk.repository.js',
);
const { bulkSchema } = await load('persistence/bulk.schema.js');
const { BulkOutboxRelay } = await load('messaging/bulk-outbox-relay.js');
const { CatalogBulkResultConsumer } = await load(
  'messaging/catalog-bulk-result-consumer.js',
);
const pool = new Pool({
  host: '127.0.0.1',
  port: config.port,
  database: 'postgres',
  user: 'bulk_fixture_app',
  password: 'isolated-bulk-password',
  ssl: { rejectUnauthorized: true, ca: readFileSync(config.ca, 'utf8') },
  max: 2,
});
const repo = new BulkPersistenceRepository(
  drizzle(pool, { schema: bulkSchema }),
);
const importer = new BulkImportService(repo);
const consumer = new CatalogBulkResultConsumer(repo, config.broker);
const relay = new BulkOutboxRelay(repo, config.broker);

const csvCell = (value) => `"${String(value).replaceAll('"', '""')}"`;
const csv = (testCase) => {
  const values = [
    'ACTUALIZACION',
    testCase.productId,
    JSON.stringify({
      producto: testCase.productVersion,
      variante: testCase.variantVersion,
    }),
    testCase.skuBase,
    testCase.skuVariant,
    'Bulk joint v2 actualizado',
    '',
    'category-fixture',
    'brand-fixture',
    'type-fixture',
    'true',
    '',
    '[]',
    '{"identificadores":[],"no_identificadores":[]}',
    'https://example.test/bulk-joint-v2.jpg',
    '0',
  ];
  const headers =
    'operacion,producto_id,catalog_version,sku_base,sku_variante,nombre,descripcion,categoria_id,marca_id,tipo_producto_id,tiene_variantes,precio_regular,atributos_producto,atributos_variante,imagen_url,stock_inicial';
  return `${headers}\r\n${values.map(csvCell).join(',')}\r\n`;
};

const outcomes = [];
let httpOutcome = null;
let peerRuntimeStopped = false;
let phase = 'permissions';
let httpStorage;
let httpApp;
try {
  const permission = await pool.query(
    "SELECT has_schema_privilege(current_user, 'catalog', 'USAGE') AS catalog_access",
  );
  if (permission.rows[0].catalog_access)
    throw new Error('Bulk role unexpectedly accesses Catalog');
  await consumer.onModuleInit();

  for (const testCase of config.cases) {
    const input = {
      bytes: Buffer.from(csv(testCase)),
      format: 'CSV',
      templateVersion: 2,
      correlationId: testCase.correlation,
      contentRef: `test://${testCase.batch}`,
      batchId: testCase.batch,
    };
    phase = `import-${testCase.name}`;
    await importer.receiveImport(input);
    const admission = await repo.findImportAdmissionIntent(testCase.batch);
    const command = admission.catalogCommands[0];
    if (command.schema_version !== 2)
      throw new Error('Bulk did not persist a v2 command');
    phase = `publish-${testCase.name}`;
    await relay.flush();
    let snapshot;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      snapshot = await importer.getSnapshot(testCase.batch);
      const inbox = await pool.query(
        "SELECT count(*)::integer AS count FROM bulk.inbox WHERE event_name = 'catalog.bulk.upsert.completed' AND correlation_id = $1",
        [testCase.correlation],
      );
      const row = snapshot.rows[0]?.row;
      const catalogStep = snapshot.rows[0]?.steps.find(
        (step) => step.domain === 'CATALOGO',
      );
      const consolidated =
        (row?.appliedDomains.includes('CATALOGO') &&
          catalogStep?.status === 'COMPLETED') ||
        (row?.status === 'FAILED' && catalogStep?.status === 'FAILED');
      if (inbox.rows[0].count > 0 && consolidated) break;
      await pause(100);
    }
    const received = await pool.query(
      "SELECT payload FROM bulk.inbox WHERE handler = 'bulk.catalog.bulk-upsert.result' AND event_name = 'catalog.bulk.upsert.completed' AND correlation_id = $1 ORDER BY processed_at LIMIT 1",
      [testCase.correlation],
    );
    if (received.rowCount !== 1)
      throw new Error('Bulk did not durably consume the Catalog result');
    outcomes.push({
      name: testCase.name,
      command,
      row: {
        applied: snapshot.rows[0].row.appliedDomains,
        status: snapshot.rows[0].row.status,
        errorCode: snapshot.rows[0].row.errorCode,
        steps: snapshot.rows[0].steps.map(({ domain, status }) => ({
          domain,
          status,
        })),
      },
      result: received.rows[0].payload,
    });

    if (testCase.replay) {
      phase = `replay-${testCase.name}`;
      const before = await pool.query(
        'SELECT payload FROM bulk.outbox WHERE correlation_id = $1',
        [testCase.correlation],
      );
      await pool.query(
        'UPDATE bulk.outbox SET published_at = NULL WHERE correlation_id = $1',
        [testCase.correlation],
      );
      await relay.flush();
      await pause(500);
      const after = await pool.query(
        'SELECT payload FROM bulk.outbox WHERE correlation_id = $1',
        [testCase.correlation],
      );
      const inbox = await pool.query(
        "SELECT count(DISTINCT message_id)::integer AS count FROM bulk.inbox WHERE event_name = 'catalog.bulk.upsert.completed' AND correlation_id = $1",
        [testCase.correlation],
      );
      if (
        JSON.stringify(before.rows[0].payload) !==
          JSON.stringify(after.rows[0].payload) ||
        inbox.rows[0].count !== 1
      )
        throw new Error('Outbox replay changed identity or duplicated Inbox');
    }
  }

  if (config.httpCase) {
    // The anonymous demo guard is permitted only on this loopback-bound disposable app.
    await consumer.onModuleDestroy();
    await relay.onModuleDestroy();
    peerRuntimeStopped = true;
    phase = 'http-storage';
    const storageObjects = new Map();
    const storageBucket = 'bulk-joint-v2-http';
    const storageKey = 'bulk-joint-v2-local-test-key';
    httpStorage = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const parts = url.pathname.split('/').map(decodeURIComponent);
      if (
        request.headers.apikey !== storageKey ||
        request.headers.authorization !== `Bearer ${storageKey}`
      ) {
        response.writeHead(401).end();
        return;
      }
      if (
        request.method === 'GET' &&
        parts[3] === 'bucket' &&
        parts[4] === storageBucket
      ) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: storageBucket, public: false }));
        return;
      }
      if (parts[3] !== 'object' || parts[4] !== storageBucket) {
        response.writeHead(404).end();
        return;
      }
      const objectName = parts.slice(5).join('/');
      if (request.method === 'GET') {
        const bytes = storageObjects.get(objectName);
        if (!bytes) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(bytes);
        return;
      }
      if (
        request.method === 'POST' &&
        request.headers['x-upsert'] === 'false'
      ) {
        const chunks = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        storageObjects.set(objectName, Buffer.concat(chunks));
        response.writeHead(200).end();
        return;
      }
      response.writeHead(405).end();
    });
    await new Promise((resolve, reject) => {
      httpStorage.once('error', reject);
      httpStorage.listen(0, '127.0.0.1', resolve);
    });
    const storageAddress = httpStorage.address();
    if (!storageAddress || typeof storageAddress === 'string')
      throw new Error('Local private Storage substitute did not bind loopback');

    phase = 'http-module';
    const databaseUrl = new URL(
      `postgresql://bulk_fixture_app:isolated-bulk-password@127.0.0.1:${config.port}/postgres`,
    );
    databaseUrl.searchParams.set('sslmode', 'verify-full');
    databaseUrl.searchParams.set('sslrootcert', config.ca);
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl.toString(),
      BULK_AMQP_ENABLED: 'true',
      BULK_AMQP_URL: config.broker,
      BULK_SVC_HOST: '127.0.0.1',
      BULK_DEMO_GATEWAY_IPS: '127.0.0.1',
      BULK_STORAGE_BUCKET: storageBucket,
      GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
      SUPABASE_SERVICE_ROLE_KEY: storageKey,
      SUPABASE_URL: `http://127.0.0.1:${storageAddress.port}`,
    });
    const { NestFactory } = await import('@nestjs/core');
    const { BulkSvcModule } = await load('bulk-svc.module.js');
    const { BulkProblemFilter } = await load('http/bulk-problem.filter.js');
    const { BulkPersistenceRepository } = await load(
      'persistence/bulk.repository.js',
    );
    const http = require('supertest');
    httpApp = await NestFactory.create(BulkSvcModule, {
      abortOnError: false,
      logger: false,
    });
    httpApp.useGlobalFilters(new BulkProblemFilter());
    await httpApp.init();
    // Bind the test-only process to loopback; it is never exposed to the host network.
    await httpApp.listen(0, '127.0.0.1');
    const httpRepository = httpApp.get(BulkPersistenceRepository);
    const testCase = config.httpCase;
    const headers =
      'operacion,producto_id,catalog_version,sku_base,sku_variante,nombre,descripcion,categoria_id,marca_id,tipo_producto_id,tiene_variantes,precio_regular,atributos_producto,atributos_variante,imagen_url,stock_inicial';
    const values = [
      'ACTUALIZACION',
      testCase.productId,
      JSON.stringify({
        producto: testCase.productVersion,
        variante: testCase.variantVersion,
      }),
      testCase.skuBase,
      testCase.skuVariant,
      'Bulk joint v2 HTTP actualizado',
      '',
      'category-fixture',
      'brand-fixture',
      'type-fixture',
      'true',
      '',
      '[]',
      '{"identificadores":[],"no_identificadores":[]}',
      'https://example.test/bulk-joint-v2-http.jpg',
      '0',
    ];
    const csvBytes = Buffer.from(
      `${headers}\r\n${values.map(csvCell).join(',')}\r\n`,
      'utf8',
    );
    phase = 'http-admission';
    const accepted = await http(httpApp.getHttpServer())
      .post('/api/v1/carga-masiva/productos/importaciones')
      .set('x-correlation-id', testCase.correlation)
      .field('template_version', '2')
      .attach('archivo', csvBytes, 'catalog-update.csv');
    if (accepted.status !== 202)
      throw Object.assign(
        new Error(
          `HTTP admission returned ${accepted.status}: ${accepted.body?.code ?? 'NO_CODE'}`,
        ),
        {
          code: String(accepted.body?.code ?? 'HTTP_ERROR').replace(
            /[^A-Z0-9_]/g,
            '_',
          ),
        },
      );
    const batchId = accepted.body.batch_id;
    if (accepted.body.correlation_id !== testCase.correlation)
      throw new Error('HTTP admission did not preserve correlation_id');
    let snapshot;
    let resultInboxCount = 0;
    const resultDeadline = Date.now() + 60000;
    while (Date.now() < resultDeadline) {
      const outbox = await pool.query(
        "SELECT message_id, payload, published_at FROM bulk.outbox WHERE event_name = 'catalog.bulk.upsert.requested' AND correlation_id = $1",
        [testCase.correlation],
      );
      snapshot = await http(httpApp.getHttpServer())
        .get(`/api/v1/carga-masiva/productos/importaciones/${batchId}`)
        .expect(200);
      const steps = snapshot.body.rows[0]?.steps ?? [];
      const catalogStep = steps.find((step) => step.dominio === 'CATALOGO');
      const receipts = await pool.query(
        "SELECT count(*)::integer AS count FROM bulk.inbox WHERE handler = 'bulk.catalog.bulk-upsert.result' AND event_name = 'catalog.bulk.upsert.completed' AND correlation_id = $1",
        [testCase.correlation],
      );
      resultInboxCount = receipts.rows[0].count;
      if (
        outbox.rowCount === 1 &&
        outbox.rows[0].published_at &&
        resultInboxCount === 1 &&
        catalogStep?.status === 'COMPLETED'
      )
        break;
      await pause(100);
    }
    const initialHttpSnapshot = snapshot.body;
    if (
      initialHttpSnapshot.status !== 'COMPLETED' ||
      initialHttpSnapshot.completed_rows !== 1 ||
      initialHttpSnapshot.rows[0]?.applied_domains.join(',') !== 'CATALOGO' ||
      initialHttpSnapshot.rows[0]?.status !== 'COMPLETED' ||
      resultInboxCount !== 1
    ) {
      const [commandRows, receipts] = await Promise.all([
        pool.query(
          "SELECT message_id, payload, published_at FROM bulk.outbox WHERE event_name = 'catalog.bulk.upsert.requested' AND correlation_id = $1",
          [testCase.correlation],
        ),
        pool.query(
          'SELECT handler, event_name, result, payload FROM bulk.inbox WHERE correlation_id = $1 ORDER BY created_at',
          [testCase.correlation],
        ),
      ]);
      throw new Error(
        `HTTP result not consolidated: batch=${initialHttpSnapshot.status}/${initialHttpSnapshot.rows[0]?.applied_domains?.join(',') ?? 'NO_ROW'}; resultReceipts=${resultInboxCount}; commands=${JSON.stringify(commandRows.rows)}; inbox=${JSON.stringify(receipts.rows)}`,
      );
    }
    const firstHttpOutbox = await pool.query(
      "SELECT message_id, payload, published_at FROM bulk.outbox WHERE event_name = 'catalog.bulk.upsert.requested' AND correlation_id = $1",
      [testCase.correlation],
    );
    const httpCommand = firstHttpOutbox.rows[0]?.payload;
    const httpCommandRow = httpCommand?.data?.rows?.[0];
    const httpResultReceipt = await pool.query(
      "SELECT payload FROM bulk.inbox WHERE handler = 'bulk.catalog.bulk-upsert.result' AND event_name = 'catalog.bulk.upsert.completed' AND correlation_id = $1",
      [testCase.correlation],
    );
    const httpResultEnvelope = httpResultReceipt.rows[0]?.payload;
    if (
      firstHttpOutbox.rowCount !== 1 ||
      !firstHttpOutbox.rows[0].published_at ||
      httpCommand?.schema_version !== 2 ||
      httpCommand?.message_id !== firstHttpOutbox.rows[0].message_id ||
      httpCommand?.operation_id !== httpCommand?.data?.batch_operation_id ||
      httpCommand?.correlation_id !== testCase.correlation ||
      httpCommand?.causation_id !== null ||
      httpCommand?.data?.batch_id !== batchId ||
      httpCommandRow?.sku_variante !== testCase.skuVariant ||
      typeof httpCommandRow?.row_operation_id !== 'string' ||
      httpResultEnvelope?.causation_id !== httpCommand?.message_id ||
      httpResultEnvelope?.operation_id !== httpCommand?.operation_id ||
      httpResultEnvelope?.correlation_id !== testCase.correlation ||
      httpResultEnvelope?.data?.batch_operation_id !==
        httpCommand?.data?.batch_operation_id
    )
      throw new Error(
        'HTTP Catalog v2 command/result causal identity mismatch',
      );
    const contentRef = (await httpRepository.findBatchByBatchId(batchId))
      ? (
          await pool.query(
            'SELECT fm.content_ref FROM bulk.file_manifests fm JOIN bulk.batch_jobs bj ON bj.input_file_id = fm.id WHERE bj.batch_id = $1',
            [batchId],
          )
        ).rows[0].content_ref
      : null;
    if (
      typeof contentRef !== 'string' ||
      !contentRef.startsWith(`supabase://${storageBucket}/`)
    )
      throw new Error(
        'HTTP admission did not persist its private object reference',
      );
    const objectName = contentRef.slice(`supabase://${storageBucket}/`.length);
    if (!storageObjects.get(objectName)?.equals(csvBytes))
      throw new Error(
        'HTTP Storage object did not preserve the admitted bytes',
      );
    const replay = await http(httpApp.getHttpServer())
      .post('/api/v1/carga-masiva/productos/importaciones')
      .set('x-correlation-id', testCase.correlation)
      .field('template_version', '2')
      .attach('archivo', csvBytes, 'catalog-update.csv')
      .expect(202);
    if (replay.body.batch_id !== batchId)
      throw new Error('HTTP replay changed batch identity');
    const replayOutbox = await pool.query(
      "SELECT message_id, payload, published_at FROM bulk.outbox WHERE event_name = 'catalog.bulk.upsert.requested' AND correlation_id = $1",
      [testCase.correlation],
    );
    const replayReceipts = await pool.query(
      "SELECT count(*)::integer AS count FROM bulk.inbox WHERE handler = 'bulk.catalog.bulk-upsert.result' AND event_name = 'catalog.bulk.upsert.completed' AND correlation_id = $1",
      [testCase.correlation],
    );
    if (
      replayOutbox.rowCount !== 1 ||
      replayReceipts.rows[0].count !== 1 ||
      firstHttpOutbox.rows[0].message_id !== replayOutbox.rows[0].message_id ||
      JSON.stringify(firstHttpOutbox.rows[0].payload) !==
        JSON.stringify(replayOutbox.rows[0].payload)
    )
      throw new Error(
        'HTTP replay duplicated or changed the durable Catalog command/result',
      );
    const finalHttpSnapshot = await http(httpApp.getHttpServer())
      .get(`/api/v1/carga-masiva/productos/importaciones/${batchId}`)
      .expect(200);
    httpOutcome = {
      name: 'http',
      admission: accepted.body,
      snapshot: finalHttpSnapshot.body,
      outboxMessageId: replayOutbox.rows[0].message_id,
      operationId: httpCommand.operation_id,
      batchOperationId: httpCommand.data.batch_operation_id,
      rowOperationId: httpCommandRow.row_operation_id,
      resultCausationId: httpResultEnvelope.causation_id,
      catalogResultReceipts: replayReceipts.rows[0].count,
      storedContentRef: contentRef,
    };
  }
  console.log(
    'BULK_JOINT_V2_RESULT:' +
      JSON.stringify({ cases: outcomes, http: httpOutcome }),
  );
} catch (error) {
  const code =
    typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : 'UNAVAILABLE';
  const detail =
    error instanceof Error
      ? error.message.replace(/[^\x20-\x7E]/g, '').slice(0, 180)
      : '';
  console.error(
    `Disposable Bulk v2 peer failed at ${phase} (${code}): ${detail}`,
  );
  process.exitCode = 1;
} finally {
  await httpApp?.close();
  if (httpStorage)
    await new Promise((resolve) => httpStorage.close(() => resolve()));
  if (!peerRuntimeStopped) {
    await consumer.onModuleDestroy();
    await relay.onModuleDestroy();
  }
  await pool.end();
}
