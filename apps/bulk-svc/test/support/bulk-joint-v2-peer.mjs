// Bulk runtime peer used by the disposable Catalog integration harness.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as pause } from 'node:timers/promises';

const config = JSON.parse(readFileSync(0, 'utf8'));
const require = createRequire(join(config.build, 'bulk-import.service.js'));
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const load = (file) => import(pathToFileURL(join(config.build, file)).href);
const { BulkImportService } = await load('bulk-import.service.js');
const { parseBulkEnvironment } = await load('config/bulk-environment.js');
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
const importer = new BulkImportService(
  repo,
  parseBulkEnvironment({
    NODE_ENV: 'test',
    BULK_CATALOG_COMMAND_V2_ENABLED: 'true',
  }),
);
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
let phase = 'permissions';
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
  console.log('BULK_JOINT_V2_RESULT:' + JSON.stringify(outcomes));
} catch (error) {
  const code =
    typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : 'UNAVAILABLE';
  console.error(`Disposable Bulk v2 peer failed at ${phase} (${code}).`);
  process.exitCode = 1;
} finally {
  await consumer.onModuleDestroy();
  await relay.onModuleDestroy();
  await pool.end();
}
