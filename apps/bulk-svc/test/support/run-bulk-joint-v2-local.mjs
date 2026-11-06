// Creates an isolated copy of the Catalog E2E harness and extends only that
// temporary copy. The versioned Catalog tree is never written by this runner.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve('.');
const catalogTest = resolve(
  root,
  'apps/catalog-svc/test/postgres.persistence.e2e-spec.ts',
);
const catalogDir = dirname(catalogTest);
const tempDir = mkdtempSync(
  join(root, 'apps/bulk-svc/test/.bulk-joint-v2-local-'),
);
const generatedSpec = join(tempDir, 'bulk-joint-v2.e2e-spec.ts');
const testFilter = process.argv[2] ?? 'BULK-JOINT';

const extension = `    it('BULK-JOINT v2: real Bulk CSV producer, Catalog consumer, TLS PostgreSQL, result v1 and replay', async () => {
      const ownerRoleExists = command('docker', ['exec', container, 'psql', '-U', 'postgres', '-tAc', "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'po_bulk_owner')"]);
      if (ownerRoleExists !== 't') command('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], 'CREATE ROLE po_bulk_owner NOLOGIN');
      const appRoleExists = command('docker', ['exec', container, 'psql', '-U', 'postgres', '-tAc', "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bulk_fixture_app')"]);
      command('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], appRoleExists === 't' ? "ALTER ROLE bulk_fixture_app WITH LOGIN PASSWORD 'isolated-bulk-password'" : "CREATE ROLE bulk_fixture_app LOGIN PASSWORD 'isolated-bulk-password'");
      const bulkSchemaExists = command('docker', ['exec', container, 'psql', '-U', 'postgres', '-tAc', "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'bulk')"]);
      if (bulkSchemaExists !== 't') command('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], 'CREATE SCHEMA bulk AUTHORIZATION po_bulk_owner');
      const bulkManifestExists = command('docker', ['exec', container, 'psql', '-U', 'postgres', '-tAc', "SELECT to_regclass('bulk.file_manifests') IS NOT NULL"]);
      if (bulkManifestExists !== 't') {
        command('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], 'SET ROLE po_bulk_owner; ' + readFileSync(resolve('apps/catalog-svc/test/fixtures/0001_create_bulk_persistence.sql'), 'utf8'));
      }
      const exportSnapshotColumnExists = command('docker', ['exec', container, 'psql', '-U', 'postgres', '-tAc', "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'bulk' AND table_name = 'file_manifests' AND column_name = 'metadata')"]);
      if (exportSnapshotColumnExists !== 't') command('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], 'SET ROLE po_bulk_owner; ' + readFileSync(resolve('apps/bulk-svc/migrations/0002_export_source_snapshot.sql'), 'utf8'));
      command('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], 'GRANT USAGE ON SCHEMA bulk TO bulk_fixture_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA bulk TO bulk_fixture_app; GRANT USAGE ON ALL SEQUENCES IN SCHEMA bulk TO bulk_fixture_app;');
      const productInputValue = createRequest(true);
      const created = await mutationService().createProduct(productInputValue, actor);
      const skuVariant = 'joint-v2-' + randomUUID();
      const foreignSku = 'joint-v2-foreign-' + randomUUID();
      const variantInput = (sku) => ({
        sku,
        atributosIdentificadores: [{ caracteristica_id: 'size', nombre: 'Size', valor_id: 'M', valor: 'M' }],
        imagenUrl: 'https://example.test/joint-v2-seed.jpg',
        perfilFisico: fullProfile,
      });
      await mutationService().createVariant(created.product_id, variantInput(skuVariant), actor);
      const foreignProductInput = createRequest(true);
      const foreignProduct = await mutationService().createProduct(foreignProductInput, actor);
      await mutationService().createVariant(foreignProduct.product_id, variantInput(foreignSku), actor);
      const initialParent = (await database.read((db) => db.select().from(products).where(eq(products.id, created.product_id))))[0];
      const initialVariant = (await database.read((db) => db.select().from(variants).where(eq(variants.sku, skuVariant))))[0];
      const initialForeign = (await database.read((db) => db.select().from(variants).where(eq(variants.sku, foreignSku))))[0];
      if (!initialParent || !initialVariant || !initialForeign) throw new Error('Could not seed disposable Catalog variants');

      const handler = bulkHandler();
      const messages = new CatalogMessageService(database, new CatalogTelemetry(), handler);
      jointRuntime = new CatalogAmqpRuntime(messages, jointBroker.settings);
      jointRuntime.onModuleInit();
      const buildDirectory = mkdtempSync(join(tmpdir(), 'bulk-joint-v2-build-'));
      const build = join(buildDirectory, 'bulk-build');
      try {
        writeFileSync(join(buildDirectory, 'package.json'), JSON.stringify({ type: 'module' }));
        command(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', resolve('apps/bulk-svc/tsconfig.app.json'), '--outDir', build, '--tsBuildInfoFile', join(buildDirectory, 'bulk.tsbuildinfo')]);
        symlinkSync(resolve('node_modules'), join(buildDirectory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
        const cases = [
          { name: 'success', skuVariant, productVersion: Number(initialParent.catalog_version), variantVersion: Number(initialVariant.catalog_version), replay: true },
          { name: 'missing', skuVariant: 'joint-v2-missing-' + randomUUID(), productVersion: Number(initialParent.catalog_version) + 1, variantVersion: Number(initialVariant.catalog_version) + 1 },
          { name: 'foreign', skuVariant: foreignSku, productVersion: Number(initialParent.catalog_version) + 1, variantVersion: Number(initialForeign.catalog_version) },
          { name: 'stale', skuVariant, productVersion: Number(initialParent.catalog_version) + 1, variantVersion: Number(initialVariant.catalog_version) },
        ].map((item) => ({ ...item, productId: created.product_id, skuBase: productInputValue.skuBase, batch: randomUUID(), correlation: randomUUID() }));
        const httpCase = {
          productId: created.product_id,
          productVersion: Number(initialParent.catalog_version) + 1,
          variantVersion: Number(initialVariant.catalog_version) + 1,
          skuBase: productInputValue.skuBase,
          skuVariant,
          correlation: randomUUID(),
        };
        const child = spawn(process.execPath, [resolve('apps/bulk-svc/test/support/bulk-joint-v2-peer.mjs')], {
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'test' },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stdin.end(JSON.stringify({ build, port: Number(port), ca: caFile, broker: jointBroker.bulkUrl, cases, httpCase }));
        const output = [];
        const diagnostics = [];
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (data) => output.push(String(data)));
        const exit = await new Promise((done, reject) => {
          const timer = setTimeout(() => { child.kill(); reject(new Error('Disposable Bulk v2 peer timeout')); }, 120000);
          child.once('error', (error) => { clearTimeout(timer); reject(error); });
          child.once('exit', (code) => { clearTimeout(timer); done(code); });
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (data) => {
            const text = String(data);
            if (text.includes('Disposable Bulk v2 peer failed at ')) diagnostics.push(text.trim());
          });
        });
        expect(exit, 'Real Bulk v2 peer failed: ' + diagnostics.join(' ')).toBe(0);
        const line = output.join('').split('\\n').find((value) => value.startsWith('BULK_JOINT_V2_RESULT:'));
        expect(line).toBeDefined();
        const peerResults = JSON.parse(line.slice('BULK_JOINT_V2_RESULT:'.length));
        const results = peerResults.cases;
        const httpResult = peerResults.http;
        expect(results.map((item) => item.name)).toEqual(['success', 'missing', 'foreign', 'stale']);
        expect(results.map((item) => item.command.schema_version)).toEqual([2, 2, 2, 2]);
        expect(results.map((item) => item.result.data.results[0].code)).toEqual([null, 'VARIANTE_NO_ENCONTRADA', 'VARIANTE_NO_ENCONTRADA', 'VERSION_CONFLICT']);
        expect(results[0].result.schema_version).toBe(1);
        expect(results[0].row.applied).toEqual(['CATALOGO']);
        expect(results[0].row.applied).not.toContain('PRICING');
        expect(results[0].row.applied).not.toContain('INVENTARIO');
        expect(results[0].row.steps).toEqual([
          { domain: 'CATALOGO', status: 'COMPLETED' },
        ]);
        expect(httpResult).toMatchObject({
          admission: {
            status: 'QUEUED',
            template_version: 2,
            correlation_id: httpCase.correlation,
          },
          snapshot: {
            status: 'COMPLETED',
            completed_rows: 1,
            failed_rows: 0,
            rows: [
              {
              status: 'COMPLETED',
                applied_domains: ['CATALOGO'],
                failed_domain: null,
                needs_reconciliation: false,
              },
            ],
          },
          catalogResultReceipts: 1,
        });
        expect(httpResult).toMatchObject({
          outboxMessageId: expect.any(String),
          operationId: expect.any(String),
          batchOperationId: expect.any(String),
          rowOperationId: expect.any(String),
          resultCausationId: httpResult.outboxMessageId,
        });
        expect(httpResult.batchOperationId).toBe(httpResult.operationId);
        expect(httpResult.snapshot.rows[0].steps).toEqual([
          expect.objectContaining({ dominio: 'CATALOGO', status: 'COMPLETED' }),
        ]);
        expect(httpResult.storedContentRef).toContain('supabase://bulk-joint-v2-http/imports/');
        const afterParent = (await database.read((db) => db.select().from(products).where(eq(products.id, created.product_id))))[0];
        const afterTarget = (await database.read((db) => db.select().from(variants).where(eq(variants.sku, skuVariant))))[0];
        const afterForeign = (await database.read((db) => db.select().from(variants).where(eq(variants.sku, foreignSku))))[0];
        expect(afterParent.catalog_version).toBe(initialParent.catalog_version + 2n);
        expect(afterParent.nombre).toBe('Bulk joint v2 HTTP actualizado');
        expect(afterTarget.catalog_version).toBe(initialVariant.catalog_version + 2n);
        expect(afterForeign.catalog_version).toBe(initialForeign.catalog_version);
        const acceptedCommandId = results[0].command.message_id;
        const catalogReceipts = await database.read((db) => db.select().from(inbox).where(eq(inbox.message_id, acceptedCommandId)));
        expect(catalogReceipts).toHaveLength(1);
        const gatewayCorrelation = randomUUID();
        const missingCorrelation = randomUUID();
        const invalidCorrelation = randomUUID();
        const gatewayChild = spawn(process.execPath, [resolve('apps/bulk-svc/test/support/bulk-gateway-catalog-peer.mjs')], {
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'test' },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        gatewayChild.stdin.end(JSON.stringify({
          bulkMain: join(build, 'main.js'),
          directory: buildDirectory,
          pgPort: Number(port),
          ca: caFile,
          broker: jointBroker.bulkUrl,
          successCase: {
            productId: created.product_id,
            productVersion: Number(afterParent.catalog_version),
            variantVersion: Number(afterTarget.catalog_version),
            skuBase: productInputValue.skuBase,
            skuVariant,
          },
          successCorrelation: gatewayCorrelation,
          missingCorrelation,
          invalidCorrelation,
        }));
        const gatewayOutput = [];
        const gatewayDiagnostics = [];
        gatewayChild.stdout.setEncoding('utf8');
        gatewayChild.stderr.setEncoding('utf8');
        gatewayChild.stdout.on('data', (data) => gatewayOutput.push(String(data)));
        gatewayChild.stderr.on('data', (data) => { gatewayDiagnostics.push(String(data)); process.stderr.write(String(data)); });
        const gatewayExit = await new Promise((done, reject) => {
          const timer = setTimeout(() => { gatewayChild.kill(); reject(new Error('Disposable Gateway→Bulk→Catalog peer timeout')); }, 90000);
          gatewayChild.once('error', (error) => { clearTimeout(timer); reject(error); });
          gatewayChild.once('exit', (code) => { clearTimeout(timer); done(code); });
        });
        expect(gatewayExit, 'Real Gateway→Bulk→Catalog peer failed: ' + gatewayDiagnostics.join(' ').slice(-2000)).toBe(0);
        const gatewayLine = gatewayOutput.join('').split('\\n').find((value) => value.startsWith('BULK_GATEWAY_CATALOG_RESULT:'));
        expect(gatewayLine).toBeDefined();
        const gatewayResults = JSON.parse(gatewayLine.slice('BULK_GATEWAY_CATALOG_RESULT:'.length));
        expect(gatewayResults).toMatchObject({
          templateCsv: 200,
          templateXlsx: 200,
          accepted: 'QUEUED',
          correlationPreserved: true,
          outboxCommands: 1,
          catalogApplied: ['CATALOGO'],
          inventoryStatus: null,
          reportStatus: 200,
          reportContainsCatalogFailure: true,
          invalidTransition: 409,
          bulkInboxReceipts: 1,
          authDisabledWithoutToken: 401,
          invalidFormat: 400,
          invalidVersion: 422,
          unknownMethod: 404,
          upstreamUnavailable: 503,
          storage: 'local-http-compatible',
          auth: 'RESTRICTED_DEMO_LOOPBACK_ONLY',
        });
        const gatewayCatalogReceipts = await database.read((db) => db.select().from(inbox).where(eq(inbox.message_id, gatewayResults.replayedCommand)));
        expect(gatewayCatalogReceipts).toHaveLength(1);
        const afterGatewayReplay = (await database.read((db) => db.select().from(variants).where(eq(variants.sku, skuVariant))))[0];
        expect(afterGatewayReplay.catalog_version).toBe(afterTarget.catalog_version + 1n);
        console.log('BULK_JOINT_V2_PERSISTED:' + JSON.stringify({
          skuVariant,
          parentVersion: [Number(initialParent.catalog_version), Number(afterParent.catalog_version)],
          targetVariantVersion: [Number(initialVariant.catalog_version), Number(afterTarget.catalog_version)],
          foreignVariantVersion: [Number(initialForeign.catalog_version), Number(afterForeign.catalog_version)],
          resultCodes: results.map((item) => item.result.data.results[0].code),
          catalogInboxReceiptsAfterReplay: catalogReceipts.length,
          gatewayE2E: gatewayResults,
          catalogInboxReceiptsAfterGatewayReplay: gatewayCatalogReceipts.length,
        }));
        await expect.poll(() => jointBroker.bulkQueueStats(), { timeout: 15000, interval: 500 }).toMatch(/po\\.catalogo\\.q\\s+0\\s+0/);
      } finally {
        await jointRuntime.onModuleDestroy();
        jointRuntime = undefined;
        const withinTemp = relative(tmpdir(), buildDirectory);
        if (!withinTemp || withinTemp.startsWith('..') || isAbsolute(withinTemp)) throw new Error('Invalid Bulk build cleanup path');
        rmSync(buildDirectory, { recursive: true, force: true });
      }
    }, 180000);
`;

let exitCode = 1;
try {
  let source = readFileSync(catalogTest, 'utf8');
  source = source.replace(
    /from (['"])(\.\.?\/[^'"]+)\1/g,
    (_all, quote, specifier) => {
      const absolute = resolve(catalogDir, specifier)
        .replace(/\.js$/, '.ts')
        .replaceAll('\\', '/');
      return `from ${quote}${absolute}${quote}`;
    },
  );
  const anchor = "    it('BULK-v2: resolves opaque SKU under parent lock";
  if (!source.includes(anchor))
    throw new Error('Catalog v2 insertion point missing');
  source = source.replaceAll(
    "resolve('apps/catalog-svc/test/support/bulk-peer.mjs')",
    "resolve('apps/bulk-svc/test/support/bulk-joint-v1-peer.mjs')",
  );
  source = source.replace(anchor, extension + anchor);
  writeFileSync(generatedSpec, source);
  const vitest = resolve(root, 'node_modules/vitest/vitest.mjs');
  const result = spawnSync(
    process.execPath,
    [
      vitest,
      'run',
      '--reporter=verbose',
      '--silent=false',
      '--config',
      resolve(root, 'vitest.config.e2e.ts'),
      generatedSpec,
      '-t',
      testFilter,
    ],
    {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  exitCode = result.status ?? 1;
} catch (error) {
  console.error('Could not run temporary BULK-JOINT harness:', error);
}
const intendedRoot = resolve(root, 'apps/bulk-svc/test');
const relativeTemp = relative(intendedRoot, tempDir);
if (
  !relativeTemp ||
  relativeTemp.startsWith('..') ||
  relativeTemp.includes(':')
)
  throw new Error(
    'Refusing to remove temporary integration files outside Bulk tests',
  );
rmSync(tempDir, { recursive: true, force: true });
process.exitCode = exitCode;
