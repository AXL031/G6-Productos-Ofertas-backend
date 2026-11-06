// Starts the real Bulk and Gateway applications as isolated loopback processes.
// Catalog's real AMQP consumer runs in the separate disposable Catalog E2E process.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

const root = resolve('.');
const input = JSON.parse(readFileSync(0, 'utf8'));
const prefix = 'BULK_GATEWAY_CATALOG_RESULT:';
const trace = (value) => process.stderr.write(`BULK_GATEWAY_STAGE:${value}\n`);
const storageKey = 'isolated-bulk-gateway-storage-key';
const bucket = 'bulk-gateway-e2e-private';
const objects = new Map();
let storage;
let bulk;
let gateway;

function portFrom(server) {
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string')
        return reject(new Error('Invalid test listener'));
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function startStorage() {
  storage = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (
      request.headers.apikey !== storageKey ||
      request.headers.authorization !== `Bearer ${storageKey}`
    ) {
      response.writeHead(401).end();
      return;
    }
    if (
      url.pathname === `/storage/v1/bucket/${bucket}` &&
      request.method === 'GET'
    ) {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ id: bucket, public: false }));
      return;
    }
    const marker = `/storage/v1/object/${bucket}/`;
    if (!url.pathname.startsWith(marker)) {
      response.writeHead(404).end();
      return;
    }
    const name = decodeURIComponent(url.pathname.slice(marker.length));
    if (request.method === 'GET') {
      const bytes = objects.get(name);
      if (!bytes) {
        response
          .writeHead(404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ code: 'NoSuchKey', statusCode: '404' }));
        return;
      }
      response.writeHead(200).end(bytes);
      return;
    }
    if (request.method !== 'POST' || objects.has(name)) {
      response.writeHead(objects.has(name) ? 409 : 405).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    objects.set(name, Buffer.concat(chunks));
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ Key: name }));
  });
  const port = await portFrom(storage);
  await new Promise((resolveListen, reject) => {
    storage.once('error', reject);
    storage.listen(port, '127.0.0.1', resolveListen);
  });
  return port;
}

function buildGateway(directory) {
  const build = join(directory, 'gateway-build');
  const result = spawnSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '-p',
      resolve('apps/api-gateway/tsconfig.app.json'),
      '--outDir',
      build,
      '--tsBuildInfoFile',
      join(directory, 'gateway.tsbuildinfo'),
    ],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000 },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Gateway compile failed: ${result.stderr || result.error?.message || result.status}`,
    );
  return build;
}

function start(script, env, options = {}) {
  const args = options.preload
    ? ['--require', options.preload, script]
    : [script];
  const child = spawn(process.execPath, args, {
    cwd: options.cwd ?? root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      NODE_ENV: 'test',
      ...env,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  child.output = output;
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    pause(5000),
  ]);
  if (child.exitCode === null) child.kill();
}

async function untilReady(url, predicate, child, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`${label} exited: ${child.output.join('').slice(-1200)}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (predicate(response)) return response;
    } catch {}
    await pause(100);
  }
  throw new Error(
    `${label} readiness timeout: ${child.output.join('').slice(-1200)}`,
  );
}

async function startGateway(
  port,
  bulkPort,
  directory,
  demo = true,
  acceptedStatuses = [200, 401],
) {
  const build = join(directory, 'gateway-build');
  const preload = join(directory, 'loopback-listen.cjs');
  writeFileSync(
    preload,
    `const net = require('node:net');\nconst original = net.Server.prototype.listen;\nnet.Server.prototype.listen = function (...args) { if (typeof args[0] === 'number' && (args.length === 1 || typeof args[1] === 'function')) args.splice(1, 0, '127.0.0.1'); return original.apply(this, args); };\n`,
  );
  const child = start(
    join(build, 'main.js'),
    {
      API_GATEWAY_PORT: String(port),
      GATEWAY_DEMO_NO_AUTH_ENABLED: demo ? 'true' : 'false',
      GATEWAY_BULK_SVC_URL: `http://127.0.0.1:${bulkPort}`,
    },
    { preload, cwd: directory },
  );
  const response = await untilReady(
    `http://127.0.0.1:${port}/api/v1/carga-masiva/productos/plantilla?formato=CSV`,
    () => true,
    child,
    'API Gateway',
  );
  if (!acceptedStatuses.includes(response.status)) {
    const details = (await response.text()).slice(0, 400);
    await stop(child);
    throw new Error(
      `API Gateway started with unexpected route status ${response.status}: ${details}`,
    );
  }
  return child;
}

function csv(inputCase) {
  const values = [
    'ACTUALIZACION',
    inputCase.productId,
    JSON.stringify({
      producto: inputCase.productVersion,
      variante: inputCase.variantVersion,
    }),
    inputCase.skuBase,
    inputCase.skuVariant,
    'Gateway Bulk update',
    '',
    'category-fixture',
    'brand-fixture',
    'type-fixture',
    'true',
    '',
    '[]',
    '{"identificadores":[],"no_identificadores":[]}',
    'https://example.test/gateway-bulk.jpg',
    '0',
  ];
  const cell = (value) => `"${String(value).replaceAll('"', '""')}"`;
  return `operacion,producto_id,catalog_version,sku_base,sku_variante,nombre,descripcion,categoria_id,marca_id,tipo_producto_id,tiene_variantes,precio_regular,atributos_producto,atributos_variante,imagen_url,stock_inicial\r\n${values.map(cell).join(',')}\r\n`;
}

async function sendCsv(base, data, correlation) {
  const form = new FormData();
  form.append(
    'archivo',
    new Blob([csv(data)], { type: 'text/csv' }),
    'productos.csv',
  );
  form.append('template_version', '2');
  return fetch(`${base}/api/v1/carga-masiva/productos/importaciones`, {
    method: 'POST',
    headers: { 'x-correlation-id': correlation },
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
}

async function waitSnapshot(base, batchId, predicate) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${base}/api/v1/carga-masiva/productos/importaciones/${batchId}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!response.ok)
      throw new Error(`Gateway batch query returned ${response.status}`);
    const snapshot = await response.json();
    if (predicate(snapshot)) return snapshot;
    await pause(150);
  }
  throw new Error(`Timed out waiting for Gateway batch ${batchId}`);
}

let pgPool;
let replayConnection;
try {
  trace('storage-start');
  const storagePort = await startStorage();
  const directory = input.directory;
  buildGateway(directory);
  const bulkPort = await portFrom(createServer());
  const gatewayPort = await portFrom(createServer());
  const bulkDatabase = `postgresql://bulk_fixture_app:isolated-bulk-password@127.0.0.1:${input.pgPort}/postgres?sslmode=verify-full`;
  bulk = start(input.bulkMain, {
    BULK_SVC_HOST: '127.0.0.1',
    BULK_SVC_PORT: String(bulkPort),
    DATABASE_URL: bulkDatabase,
    PGSSLROOTCERT: input.ca,
    BULK_AMQP_ENABLED: 'true',
    BULK_AMQP_URL: input.broker,
    SUPABASE_URL: `http://127.0.0.1:${storagePort}`,
    SUPABASE_SERVICE_ROLE_KEY: storageKey,
    BULK_STORAGE_BUCKET: bucket,
    GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
    BULK_DEMO_GATEWAY_IPS: '127.0.0.1',
  });
  trace('bulk-started');
  await untilReady(
    `http://127.0.0.1:${bulkPort}/health/readiness`,
    (response) => response.status === 200,
    bulk,
    'Bulk',
  );
  trace('bulk-ready');
  const directTemplate = await fetch(
    `http://127.0.0.1:${bulkPort}/api/v1/carga-masiva/productos/plantilla?formato=CSV`,
    { signal: AbortSignal.timeout(3000) },
  );
  trace(`bulk-direct-template-${directTemplate.status}`);
  if (directTemplate.status !== 200)
    throw new Error(
      `Bulk direct loopback template expected 200, got ${directTemplate.status}`,
    );
  gateway = await startGateway(gatewayPort, bulkPort, directory, true);
  trace('gateway-ready');
  const base = `http://127.0.0.1:${gatewayPort}`;

  const csvTemplate = await fetch(
    `${base}/api/v1/carga-masiva/productos/plantilla?formato=CSV`,
  );
  const xlsxTemplate = await fetch(
    `${base}/api/v1/carga-masiva/productos/plantilla?formato=XLSX`,
  );
  if (
    csvTemplate.status !== 200 ||
    !(csvTemplate.headers.get('content-type') ?? '').includes('text/csv')
  )
    throw new Error('Gateway CSV template contract failed');
  if (
    xlsxTemplate.status !== 200 ||
    !(xlsxTemplate.headers.get('content-type') ?? '').includes(
      'spreadsheetml.sheet',
    )
  )
    throw new Error('Gateway XLSX template contract failed');
  const invalidFormat = await fetch(
    `${base}/api/v1/carga-masiva/productos/plantilla?formato=TXT`,
  );
  if (invalidFormat.status !== 400)
    throw new Error(
      `Invalid template format expected 400, got ${invalidFormat.status}`,
    );
  const unknownMethod = await fetch(
    `${base}/api/v1/carga-masiva/productos/importaciones`,
    { method: 'DELETE' },
  );
  if (unknownMethod.status !== 404)
    throw new Error(`Unknown method expected 404, got ${unknownMethod.status}`);
  trace('templates-and-validation-ok');

  const successCorrelation = input.successCorrelation;
  const accepted = await sendCsv(base, input.successCase, successCorrelation);
  if (accepted.status !== 202)
    throw new Error(
      `Gateway import expected 202, got ${accepted.status}: ${await accepted.text()}`,
    );
  if (accepted.headers.get('x-correlation-id') !== successCorrelation)
    throw new Error('Gateway did not preserve X-Correlation-Id');
  const admission = await accepted.json();
  if (
    admission.correlation_id !== successCorrelation ||
    admission.status !== 'QUEUED'
  )
    throw new Error('Contract admission correlation/status mismatch');
  const successSnapshot = await waitSnapshot(
    base,
    admission.batch_id,
    (snapshot) =>
      snapshot.rows?.[0]?.applied_domains?.includes('CATALOGO') &&
      snapshot.rows[0].steps?.some(
        (step) => step.dominio === 'CATALOGO' && step.status === 'COMPLETED',
      ),
  );
  if (
    successSnapshot.rows[0].applied_domains.length !== 1 ||
    successSnapshot.rows[0].applied_domains[0] !== 'CATALOGO' ||
    successSnapshot.rows[0].status !== 'COMPLETED'
  )
    throw new Error(
      'ACTUALIZACION should complete after its only required domain, Catalog',
    );
  if (successSnapshot.rows[0].steps.length !== 1)
    throw new Error('ACTUALIZACION must not create a pending Inventory step');
  trace('catalog-result-persisted');

  const { Pool } = await import('pg');
  pgPool = new Pool({
    host: '127.0.0.1',
    port: Number(input.pgPort),
    database: 'postgres',
    user: 'bulk_fixture_app',
    password: 'isolated-bulk-password',
    ssl: { rejectUnauthorized: true, ca: readFileSync(input.ca, 'utf8') },
    max: 2,
  });
  const commandResult = await pgPool.query(
    "SELECT message_id,event_name,correlation_id,payload FROM bulk.outbox WHERE correlation_id=$1 AND event_name='catalog.bulk.upsert.requested'",
    [successCorrelation],
  );
  if (commandResult.rowCount !== 1)
    throw new Error(
      `Expected one persisted Catalog Outbox command, got ${commandResult.rowCount}`,
    );
  const command = commandResult.rows[0];
  const amqp = await import('amqplib');
  replayConnection = await amqp.default.connect(input.broker);
  const channel = await replayConnection.createConfirmChannel();
  channel.publish(
    'po.comandos.x',
    command.event_name,
    Buffer.from(JSON.stringify(command.payload)),
    {
      persistent: true,
      contentType: 'application/json',
      messageId: command.message_id,
      correlationId: command.correlation_id,
      type: command.event_name,
      userId: new URL(input.broker).username
        ? decodeURIComponent(new URL(input.broker).username)
        : 'guest',
    },
  );
  await channel.waitForConfirms();
  await channel.close();
  await pause(1000);
  trace('replay-confirmed');

  const missingCorrelation = input.missingCorrelation;
  const missing = await sendCsv(
    base,
    {
      ...input.successCase,
      skuVariant: `gateway-missing-${missingCorrelation}`,
      variantVersion: 1,
    },
    missingCorrelation,
  );
  if (missing.status !== 202)
    throw new Error(`Missing SKU import expected 202, got ${missing.status}`);
  const missingAdmission = await missing.json();
  const failedSnapshot = await waitSnapshot(
    base,
    missingAdmission.batch_id,
    (snapshot) => snapshot.rows?.[0]?.status === 'FAILED',
  );
  const report = await fetch(
    `${base}/api/v1/carga-masiva/productos/importaciones/${missingAdmission.batch_id}/reporte`,
  );
  const reportCsv = await report.text();
  if (
    report.status !== 200 ||
    !(report.headers.get('content-type') ?? '').includes('text/csv') ||
    !reportCsv.includes('VARIANTE_NO_ENCONTRADA')
  )
    throw new Error(
      'Catalog failure was not exposed in the Gateway CSV report',
    );
  const invalidTransition = await fetch(
    `${base}/api/v1/carga-masiva/productos/importaciones/${missingAdmission.batch_id}/reanudar`,
    { method: 'POST' },
  );
  const invalidBody = await invalidTransition.json();
  if (
    invalidTransition.status !== 409 ||
    invalidBody.code !== 'IDEMPOTENCY_CONFLICT'
  )
    throw new Error(
      'Invalid resume transition did not return the contract problem response',
    );
  trace('failure-report-and-transition-ok');

  const invalidVersionForm = new FormData();
  invalidVersionForm.append(
    'archivo',
    new Blob([csv(input.successCase)], { type: 'text/csv' }),
    'invalid-version.csv',
  );
  invalidVersionForm.append('template_version', '1');
  const invalidVersion = await fetch(
    `${base}/api/v1/carga-masiva/productos/importaciones`,
    {
      method: 'POST',
      body: invalidVersionForm,
      headers: { 'x-correlation-id': input.invalidCorrelation },
    },
  );
  if (invalidVersion.status !== 422)
    throw new Error(
      `Invalid template_version expected 422, got ${invalidVersion.status}`,
    );

  await stop(gateway);
  gateway = await startGateway(gatewayPort, bulkPort, directory, false);
  const anonymous = await fetch(
    `${base}/api/v1/carga-masiva/productos/plantilla?formato=CSV`,
  );
  if (anonymous.status !== 401)
    throw new Error(
      `Without demo and without token expected 401, got ${anonymous.status}`,
    );
  trace('auth-off-rejected');
  await stop(gateway);
  await stop(bulk);
  bulk = undefined;
  gateway = await startGateway(gatewayPort, bulkPort, directory, true, [503]);
  const unavailable = await fetch(
    `${base}/api/v1/carga-masiva/productos/plantilla?formato=CSV`,
  );
  if (unavailable.status !== 503)
    throw new Error(
      `Unavailable upstream expected 503, got ${unavailable.status}`,
    );
  trace('upstream-unavailable-checked');

  const replayCount = (
    await pgPool.query(
      "SELECT count(*)::int AS count FROM bulk.inbox WHERE handler='bulk.catalog.bulk-upsert.result' AND correlation_id=$1",
      [successCorrelation],
    )
  ).rows[0].count;
  if (replayCount !== 1)
    throw new Error(
      `Bulk result Inbox should be idempotent, got ${replayCount}`,
    );
  process.stdout.write(
    prefix +
      JSON.stringify({
        templateCsv: csvTemplate.status,
        templateXlsx: xlsxTemplate.status,
        accepted: admission.status,
        correlationPreserved: true,
        outboxCommands: commandResult.rowCount,
        catalogApplied: successSnapshot.rows[0].applied_domains,
        inventoryStatus:
          successSnapshot.rows[0].steps.find(
            (step) => step.dominio === 'INVENTARIO',
          )?.status ?? null,
        catalogFailure: failedSnapshot.rows[0].code,
        reportStatus: report.status,
        reportContainsCatalogFailure: reportCsv.includes(
          'VARIANTE_NO_ENCONTRADA',
        ),
        invalidTransition: invalidTransition.status,
        replayedCommand: command.message_id,
        bulkInboxReceipts: replayCount,
        authDisabledWithoutToken: anonymous.status,
        invalidFormat: invalidFormat.status,
        invalidVersion: invalidVersion.status,
        unknownMethod: unknownMethod.status,
        upstreamUnavailable: unavailable.status,
        storage: 'local-http-compatible',
        auth: 'RESTRICTED_DEMO_LOOPBACK_ONLY',
      }) +
      '\n',
  );
} catch (error) {
  process.stderr.write(
    `Disposable Gateway→Bulk→Catalog E2E failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await stop(gateway);
  await stop(bulk);
  await replayConnection?.close().catch(() => undefined);
  await pgPool?.end().catch(() => undefined);
  if (storage?.listening)
    await new Promise((resolveClose) => storage.close(resolveClose));
}
