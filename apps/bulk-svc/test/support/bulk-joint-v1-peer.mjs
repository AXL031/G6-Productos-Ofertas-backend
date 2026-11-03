// Bulk v1 runtime peer used by the isolated Catalog integration harness.
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
const headers =
  'operacion,producto_id,catalog_version,sku_base,sku_variante,nombre,descripcion,categoria_id,marca_id,tipo_producto_id,tiene_variantes,precio_regular,atributos_producto,atributos_variante,imagen_url,stock_inicial';
const csv = `${headers}\r\nALTA,,,${config.sku},,Bulk real,Disposable,category-fixture,brand-fixture,type-fixture,false,20,[],,,0\r\n`;
let phase = 'permissions';
try {
  const permission = await pool.query(
    "SELECT has_schema_privilege(current_user, 'catalog', 'USAGE') AS catalog_access",
  );
  if (permission.rows[0].catalog_access)
    throw new Error('Bulk role unexpectedly accesses Catalog');
  phase = 'import';
  await importer.receiveImport({
    bytes: Buffer.from(csv),
    format: 'CSV',
    templateVersion: 2,
    correlationId: config.correlation,
    contentRef: `test://${config.batch}`,
    batchId: config.batch,
  });
  await consumer.onModuleInit();
  phase = 'publish';
  await relay.flush();
  let snapshot;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    snapshot = await importer.getSnapshot(config.batch);
    const inbox = await pool.query(
      "SELECT count(*)::integer AS count FROM bulk.inbox WHERE event_name = 'catalog.bulk.upsert.completed' AND correlation_id = $1",
      [config.correlation],
    );
    if (
      inbox.rows[0].count > 0 &&
      snapshot.rows[0]?.row.appliedDomains.includes('CATALOGO') &&
      snapshot.rows[0]?.steps.some(
        (step) => step.domain === 'CATALOGO' && step.status === 'COMPLETED',
      )
    )
      break;
    await pause(100);
  }
  if (
    !snapshot?.rows[0]?.row.appliedDomains.includes('CATALOGO') ||
    !snapshot.rows[0].steps.some(
      (step) => step.domain === 'CATALOGO' && step.status === 'COMPLETED',
    )
  )
    throw new Error('Catalog success was not consolidated by Bulk');
  phase = 'replay';
  await pool.query(
    'UPDATE bulk.outbox SET published_at = NULL WHERE correlation_id = $1',
    [config.correlation],
  );
  await relay.flush();
  await pause(500);
  const inbox = await pool.query(
    "SELECT count(DISTINCT message_id)::integer AS count FROM bulk.inbox WHERE event_name = 'catalog.bulk.upsert.completed' AND correlation_id = $1",
    [config.correlation],
  );
  console.log(
    'BULK_FIXTURE_RESULT:' +
      JSON.stringify({
        inbox: inbox.rows[0].count,
        rows: snapshot.rows.map((item) => ({
          applied: item.row.appliedDomains,
          status: item.row.status,
          steps: item.steps.map(({ domain, status }) => ({ domain, status })),
        })),
      }),
  );
} catch (error) {
  const code =
    typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : 'UNAVAILABLE';
  console.error(`Disposable Bulk v1 peer failed at ${phase} (${code}).`);
  process.exitCode = 1;
} finally {
  await consumer.onModuleDestroy();
  await relay.onModuleDestroy();
  await pool.end();
}
