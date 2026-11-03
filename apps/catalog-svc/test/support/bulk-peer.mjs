import { bulkSimpleCsv } from './bulk-peer-fixtures.mjs';
// Executed in a separate process. No Catalog source imports a Bulk module.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as pause } from 'node:timers/promises';
const config = JSON.parse(readFileSync(0, 'utf8'));
const require = createRequire(join(config.build, 'bulk-import.service.js'));
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const load = file => import(pathToFileURL(join(config.build, file)).href);
const { BulkImportService } = await load('bulk-import.service.js');
const { BulkPersistenceRepository } = await load('persistence/bulk.repository.js');
const { bulkSchema } = await load('persistence/bulk.schema.js');
const { BulkOutboxRelay } = await load('messaging/bulk-outbox-relay.js');
const { CatalogBulkResultConsumer } = await load('messaging/catalog-bulk-result-consumer.js');
const pool = new Pool({ host: '127.0.0.1', port: config.port, database: 'postgres', user: 'bulk_fixture_app', password: 'isolated-bulk-password', ssl: { rejectUnauthorized: true, ca: readFileSync(config.ca, 'utf8') }, max: 2 });
const repo = new BulkPersistenceRepository(drizzle(pool, { schema: bulkSchema }));
const importer = new BulkImportService(repo);
const consumer = new CatalogBulkResultConsumer(repo, config.broker);
const relay = new BulkOutboxRelay(repo, config.broker);
let phase = 'permissions';
try {
  const permission = await pool.query("SELECT has_schema_privilege(current_user, 'catalog', 'USAGE') AS catalog_access");
  if (permission.rows[0].catalog_access) throw new Error('Bulk role unexpectedly accesses Catalog');
  const csv = bulkSimpleCsv(config.sku);
  const input = { bytes: Buffer.from(csv), format: 'CSV', templateVersion: 2, correlationId: config.correlation, contentRef: `test://${config.batch}`, batchId: config.batch };
  phase = 'import';
  await importer.receiveImport(input);
  phase = 'consume-start';
  await consumer.onModuleInit();
  phase = 'publish';
  await relay.flush();
  phase = 'catalog-result';
  let snapshot;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    snapshot = await importer.getSnapshot(config.batch);
    if (snapshot.rows[0]?.steps.some(step => step.domain === 'CATALOGO' && step.status === 'COMPLETED')) break;
    await pause(100);
  }
  if (!snapshot?.rows[0]?.steps.some(step => step.domain === 'CATALOGO' && step.status === 'COMPLETED')) throw new Error('Catalog result not durably consolidated by Bulk');
  // Explicit crash-window replay of the same durable message, never a new intent.
  phase = 'replay';
  await pool.query('UPDATE bulk.outbox SET published_at = NULL WHERE correlation_id = $1', [config.correlation]);
  await relay.flush(); await pause(250);
  const inbox = await pool.query("SELECT count(DISTINCT message_id)::integer AS count FROM bulk.inbox WHERE event_name = 'catalog.bulk.upsert.completed' AND correlation_id = $1", [config.correlation]);
  console.log('BULK_FIXTURE_RESULT:' + JSON.stringify({ rows: snapshot.rows.map(item => ({ applied: item.row.appliedDomains, status: item.row.status, steps: item.steps.map(step => ({ domain: step.domain, status: step.status })) })), inbox: inbox.rows[0].count }));
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'UNAVAILABLE';
  console.error(`Disposable Bulk peer failed at ${phase} (${code}).`); process.exitCode = 1;
} finally { await consumer.onModuleDestroy(); await relay.onModuleDestroy(); await pool.end(); }
