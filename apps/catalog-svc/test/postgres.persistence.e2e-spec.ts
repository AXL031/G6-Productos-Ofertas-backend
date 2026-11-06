import {
  CatalogBulkService,
  CatalogBulkIdentity,
  canonicalBulk,
  type BulkRow,
  type BulkRowResult,
} from '../src/catalog-bulk.service.js';
import { CatalogTokenVerifier } from '../src/catalog-auth.js';
import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { CatalogEnvelope } from '../src/catalog-messages.js';
import { spawn, spawnSync } from 'node:child_process';
import {
  writeFileSync,
  symlinkSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { DisposableCatalogBroker } from './support/disposable-catalog-broker.js';
import { LegacyDemoList } from './support/legacy-demo-list.js';
import { CatalogGatewayHarness } from './support/catalog-gateway-harness.js';
import { CommercialService } from '../src/commercial.service.js';
import type { CatalogConfig } from '../src/config.js';
import type { TaxonomyClient } from '../src/taxonomy.client.js';
import type { ProductQuery, ProductSummary } from '../src/commercial.types.js';
import { CatalogAmqpRuntime } from '../src/catalog-amqp.js';
import { CatalogTelemetry } from '../src/catalog-telemetry.js';
import { and, eq, sql } from 'drizzle-orm';
import {
  CatalogMutationService,
  type CatalogProductCreationPolicy,
} from '../src/catalog-mutation.service.js';
import type { CatalogMasterClient } from '../src/catalog-master.client.js';
import { CatalogMessageService } from '../src/catalog-message.service.js';
import { CatalogQueryRepository } from '../src/catalog-query.repository.js';
import {
  activeAttempt,
  parseCatalogMessage,
  UUID,
} from '../src/catalog-messages.js';
import type { Attribute } from '../src/commercial.types.js';
import { CatalogPersistenceError } from '../src/database-errors.js';
import {
  Database,
  readPostgresSettings,
  type PostgresSettings,
  type CatalogDatabase,
  type CatalogTransaction,
} from '../src/database.js';
import { CatalogTransactionManager } from '../src/catalog-transaction.js';
import { PostgresCatalogWriteRepository } from '../src/postgres-catalog-write.repository.js';
import { PostgresCatalogRepository } from '../src/postgres-catalog.repository.js';
import { BarcodeRepository } from '../src/barcode.repository.js';
import {
  assertMasterReferences,
  lockMasterReferences,
} from '../src/catalog-master-barriers.js';
import {
  products,
  variants,
  masterBarriers,
  inbox,
  activationChecks,
  outbox,
  skuIdentity,
  skuPhysicalProfiles,
  productImages,
  variantImages,
} from '../src/catalog.schema.js';

const dockerAvailable =
  spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  }).status === 0 &&
  spawnSync('openssl', ['version'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  }).status === 0;
const isCi = process.env.CI?.toLowerCase() === 'true';

if (isCi && !dockerAvailable) {
  throw new Error(
    'Catalog persistence E2E requires Docker and OpenSSL in CI; refusing to skip PostgreSQL coverage',
  );
}

function command(executable: string, args: string[], input?: string): string {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    input,
    timeout: 120000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      basename(executable) + ' failed in isolated catalog PostgreSQL setup',
    );
  return result.stdout.trim();
}

function sanitizedPostgresLogs(container: string): string {
  const result = spawnSync('docker', ['logs', '--tail', '80', container], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  const diagnostics = (result.stdout + '\n' + result.stderr)
    .split(/\r?\n/)
    .filter((line) =>
      /database system is ready to accept connections|starting PostgreSQL|permission denied|private key|server certificate|could not (?:open|read|load).*?(?:certificate|key)|fatal:/i.test(
        line,
      ),
    )
    .map((line) => {
      if (
        /permission denied|private key|server certificate|could not/i.test(line)
      )
        return '[PostgreSQL startup] TLS certificate/key access diagnostic';
      if (/ready to accept connections/i.test(line))
        return '[PostgreSQL startup] ready to accept connections';
      if (/fatal:/i.test(line))
        return '[PostgreSQL startup] fatal server error';
      return '[PostgreSQL startup] server starting';
    });
  const uniqueDiagnostics = [...new Set(diagnostics)].slice(-20);
  return uniqueDiagnostics.length
    ? uniqueDiagnostics.join('\n')
    : 'No sanitized startup diagnostics were emitted.';
}

async function until(check: () => boolean, timeout = 30000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await pause(200);
  }
  throw new Error('Isolated PostgreSQL did not become available in time');
}

describe.skipIf(!dockerAvailable)(
  'Catalog persistence on isolated PostgreSQL 17',
  () => {
    const container = 'catalog-persistence-' + process.pid + '-' + Date.now();
    let directory = '';
    let caFile = '';
    let port = '';
    let database: Database;
    let persistenceSettings: PostgresSettings;
    let transactions: CatalogTransactionManager;
    const repository = new PostgresCatalogWriteRepository();
    let closed = false;
    const jointBroker = new DisposableCatalogBroker();
    let jointRuntime: CatalogAmqpRuntime | undefined;

    const ready = () =>
      spawnSync(
        'docker',
        ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
        {
          timeout: 5000,
          windowsHide: true,
          stdio: 'ignore',
        },
      ).status === 0;

    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), 'catalog-persistence-'));
      const certDirectory = join(directory, 'certs');
      mkdirSync(certDirectory);
      chmodSync(certDirectory, 0o755);
      const cert = join(certDirectory, 'server.crt');
      const key = join(certDirectory, 'server.key');
      caFile = cert;
      command('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        key,
        '-out',
        cert,
      ]);
      chmodSync(key, 0o644);
      chmodSync(cert, 0o644);
      command('docker', [
        'run',
        '--detach',
        '--name',
        container,
        '--publish',
        '127.0.0.1::5432',
        '--env',
        'POSTGRES_PASSWORD=isolated-admin-password',
        '--volume',
        certDirectory + ':/certs:ro',
        '--entrypoint',
        'sh',
        'postgres:17-alpine',
        '-c',
        'cp /certs/server.key /tmp/server.key; chown postgres:postgres /tmp/server.key; chmod 600 /tmp/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/tmp/server.key',
      ]);
      try {
        await until(ready);
      } catch {
        throw new Error(
          'Isolated PostgreSQL did not become available in time. Sanitized container logs:\n' +
            sanitizedPostgresLogs(container),
        );
      }

      const migration = readFileSync(
        resolve('apps/catalog-svc/test/fixtures/0001_create_catalog.sql'),
        'utf8',
      );
      const barcodeMigration = readFileSync(
        resolve('apps/catalog-svc/migrations/0002_create_sku_barcodes.sql'),
        'utf8',
      );
      command(
        'docker',
        [
          'exec',
          '-i',
          container,
          'psql',
          '-U',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
        ],
        `CREATE ROLE po_catalog_owner NOLOGIN;\nCREATE ROLE catalog_app LOGIN PASSWORD 'isolated-runtime-password';\nCREATE SCHEMA catalog AUTHORIZATION po_catalog_owner;\nCREATE SCHEMA foreign_context;\nCREATE TABLE foreign_context.private_probe (value text);\nINSERT INTO foreign_context.private_probe VALUES ('isolated');\nSET ROLE po_catalog_owner;\n${migration}\n${barcodeMigration}\nINSERT INTO catalog.products (id,nombre,descripcion,categoria_id,tipo_producto_id,marca_id,sku_base,slug,tiene_variantes) VALUES ('00000000-0000-4000-8000-000000000049','Historical','Before migration','historic-category','historic-type','historic-brand','historic-00049','historic-00049',false);\n${readFileSync(resolve('apps/catalog-svc/migrations/0003_product_publication_history.sql'), 'utf8')}`,
      );
      port = command('docker', ['port', container, '5432/tcp'])
        .split(':')
        .at(-1)!;
      const env: NodeJS.ProcessEnv = {
        NODE_ENV: 'test',
        PGHOST: 'localhost',
        G6_CONNECT_HOST: '127.0.0.1',
        PGPORT: port,
        PGDATABASE: 'postgres',
        PGUSER: 'catalog_app',
        PGPASSWORD: 'isolated-runtime-password',
        PGSSLMODE: 'verify-full',
        PGSSLROOTCERT: caFile,
        G6_DATABASE_SCHEMA: 'catalog',
        G6_EXPECTED_ROLE: 'catalog_app',
        G6_CONNECTION_MODE: 'direct',
      };
      persistenceSettings = readPostgresSettings(env);
      database = new Database(persistenceSettings);
      transactions = new CatalogTransactionManager(database);
      await database.verifyIdentity();
      await jointBroker.start();
    }, 180000);

    afterAll(async () => {
      await jointRuntime?.onModuleDestroy();
      await jointBroker.close();
      if (!closed) await database?.onModuleDestroy();
      spawnSync('docker', ['rm', '--force', container], {
        timeout: 15000,
        windowsHide: true,
        stdio: 'ignore',
      });
      if (directory) {
        const withinTemp = relative(tmpdir(), directory);
        if (
          !withinTemp ||
          withinTemp.startsWith('..') ||
          isAbsolute(withinTemp)
        )
          throw new Error('Invalid isolated test cleanup path');
        rmSync(directory, { recursive: true, force: true });
      }
    }, 30000);

    function productInput(sku: string) {
      return {
        nombre: 'Persistence fixture',
        descripcion: 'Disposable integration fixture',
        categoria_id: 'category-fixture',
        tipo_producto_id: 'type-fixture',
        marca_id: 'brand-fixture',
        sku_base: sku,
        slug: 'fixture-' + randomUUID(),
        tiene_variantes: false,
      };
    }

    it('enumerates Marketplace preview snapshots beyond 100 with real PostgreSQL and complete Pricing', async () => {
      const marker = 'PREVIEW-PAGES-' + randomUUID();
      const groups = [1, 100, 101, 205] as const;
      await transactions.run(async (tx) => {
        for (const size of groups)
          for (let index = 0; index < size; index++) {
            const name = `${marker}-${size}-${String(index).padStart(3, '0')}`;
            const row = await repository.insertProduct(tx, {
              ...productInput(`${marker}-SKU-${size}-${index}`),
              nombre: name,
            });
            await tx.insert(productImages).values([
              {
                product_id: row.id,
                url: `https://example.test/${size}/${index}/primary.jpg`,
                principal: true,
                posicion: 0,
              },
              {
                product_id: row.id,
                url: `https://example.test/${size}/${index}/secondary.jpg`,
                principal: false,
                posicion: 1,
              },
            ]);
          }
      });
      const reads = new PostgresCatalogRepository(database);
      let activePrices = 0,
        maxConcurrentPrices = 0;
      const pricing = {
        currentPrice: async () => {
          activePrices++;
          maxConcurrentPrices = Math.max(maxConcurrentPrices, activePrices);
          await pause(1);
          activePrices--;
          return {
            precio_regular: 10,
            precio_oferta: null,
            currency: 'PEN' as const,
          };
        },
      };
      const service = new CommercialService(
        reads,
        {} as TaxonomyClient,
        { enabled: false },
        { marketplaceDemoPreview: true } as CatalogConfig,
        pricing,
      );
      for (const size of [0, ...groups]) {
        const q = size ? `${marker}-${size}-` : marker + '-absent-';
        const result = await service.list({
          canal: 'MARKETPLACE',
          q,
          pagina: 1,
          tamanio: 250,
          orden: 'NOMBRE_ASC',
        });
        expect(result.total).toBe(size);
        expect(result.items).toHaveLength(size);
        if (size > 1) {
          expect(result.items[0]?.name).toBe(`${marker}-${size}-000`);
          expect(result.items.at(-1)?.name).toBe(
            `${marker}-${size}-${String(size - 1).padStart(3, '0')}`,
          );
          expect(result.items[0]?.images).toEqual([
            `https://example.test/${size}/0/primary.jpg`,
            `https://example.test/${size}/0/secondary.jpg`,
          ]);
        }
      }
      const secondPage = await service.list({
        canal: 'MARKETPLACE',
        q: `${marker}-205-`,
        pagina: 2,
        tamanio: 10,
        orden: 'NOMBRE_ASC',
      });
      expect(secondPage).toMatchObject({ total: 205, pagina: 2, tamanio: 10 });
      expect(secondPage.items[0]?.name).toBe(`${marker}-205-010`);
      expect(maxConcurrentPrices).toBeLessThanOrEqual(3);
      const noPrice = new CommercialService(
        reads,
        {} as TaxonomyClient,
        { enabled: false },
        { marketplaceDemoPreview: true } as CatalogConfig,
        { currentPrice: async () => null },
      );
      expect(
        (
          await noPrice.list({
            canal: 'MARKETPLACE',
            q: `${marker}-1-`,
            pagina: 1,
            tamanio: 10,
            orden: 'NOMBRE_ASC',
          })
        ).total,
      ).toBe(0);
      const invalidDto = new CommercialService(
        reads,
        {} as TaxonomyClient,
        { enabled: false },
        { marketplaceDemoPreview: true } as CatalogConfig,
        { currentPrice: async () => undefined as never },
      );
      await expect(
        invalidDto.list({
          canal: 'MARKETPLACE',
          q: `${marker}-1-`,
          pagina: 1,
          tamanio: 10,
          orden: 'NOMBRE_ASC',
        }),
      ).rejects.toMatchObject({ status: 503 });
      const literal = (value: string) =>
        "'" + value.replaceAll("'", "''") + "'";
      const markerPattern = literal(marker + '-%');
      command(
        'docker',
        [
          'exec',
          '-i',
          container,
          'psql',
          '-U',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
        ],
        `SET session_replication_role = replica;
         DELETE FROM catalog.products WHERE nombre LIKE ${markerPattern};`,
      );
    }, 120000);

    it('reads internal demo drafts and their actual variant photos without exposing them through the ordinary active-only query', async () => {
      const marker = 'DEMO-READ-' + randomUUID();
      const parent = await transactions.run(async (tx) => {
        const row = await repository.insertProduct(tx, {
          ...productInput(marker),
          nombre: marker,
          tiene_variantes: true,
        });
        const child = await repository.insertVariant(tx, {
          product_id: row.id,
          sku: marker + '-M',
          identifying_key: { size: { valor_id: 'M' } },
        });
        await repository.insertVariantImage(tx, {
          variant_id: child.id,
          url: 'https://example.test/demo-variant.jpg',
          posicion: 0,
        });
        await repository.insertVariantAttribute(tx, {
          variant_id: child.id,
          caracteristica_id: 'size',
          nombre_snapshot: 'Size',
          valor_id: 'M',
          valor: 'M',
          es_identificador: true,
        });
        return row;
      });
      const reads = new PostgresCatalogRepository(database);
      const query = {
        canal: 'MARKETPLACE' as const,
        q: marker,
        pagina: 1,
        tamanio: 20,
        orden: 'NOMBRE_ASC' as const,
      };
      expect((await reads.listCandidates(query)).items).toHaveLength(0);
      const page = await reads.listCandidates(
        { ...query, estado: 'BORRADOR' },
        true,
      );
      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({
        product_id: parent.id,
        images: ['https://example.test/demo-variant.jpg'],
      });
      expect(
        await reads.findCandidateByProductId(parent.id, 'MARKETPLACE', true),
      ).toMatchObject({
        product_id: parent.id,
        images: ['https://example.test/demo-variant.jpg'],
      });
      expect(
        await reads.findCandidateByProductId(parent.id, 'MARKETPLACE'),
      ).toBeNull();
    });

    it('PERF-49: compares the frozen N+1 and batched preview on the same PostgreSQL snapshot fixtures', async () => {
      const marker = 'PERF-' + randomUUID();
      const missingPrice = new Set<string>();
      await transactions.run(async (tx) => {
        for (let i = 0; i < 36; i++) {
          const row = await repository.insertProduct(tx, {
            ...productInput(marker + '-' + i),
            nombre: marker + '-' + String(Math.floor(i / 2)).padStart(2, '0'),
            categoria_id: i % 2 ? marker : marker + '-other',
            marca_id: i % 3 ? marker : marker + '-other',
            tiene_variantes: i % 3 === 0,
          });
          if (i % 7 === 0) missingPrice.add(row.id);
          await repository.insertProductImage(tx, {
            product_id: row.id,
            url: 'https://placehold.co/placeholder.png',
            posicion: 0,
          });
          if (i % 3 !== 0) {
            await repository.insertProductImage(tx, {
              product_id: row.id,
              url: 'https://example.test/secondary.png',
              posicion: 0,
            });
            await repository.insertProductImage(tx, {
              product_id: row.id,
              url: 'https://example.test/principal.png',
              posicion: 2,
              principal: true,
            });
            // Preview excludes placeholder subdomains; internal read-demo does not.
            await repository.insertProductImage(tx, {
              product_id: row.id,
              url: 'https://child.placehold.co/invalid.png',
              posicion: 3,
            });
          } else {
            const child = await repository.insertVariant(tx, {
              product_id: row.id,
              sku: marker + '-child-' + i,
              identifying_key: { size: { valor: i } },
            });
            await repository.insertVariantAttribute(tx, {
              variant_id: child.id,
              caracteristica_id: 'size',
              nombre_snapshot: 'Size',
              valor_id: null,
              valor: i,
              es_identificador: true,
            });
            for (let j = 0; j < (i === 3 ? 103 : 2); j++)
              await repository.insertVariantImage(tx, {
                variant_id: child.id,
                url:
                  i % 6 === 0
                    ? 'http://example.test/invalid.png'
                    : 'https://example.test/repeated.png',
                posicion: j,
              });
          }
          for (const caracteristica of ['z', 'a'])
            await repository.insertProductAttribute(tx, {
              product_id: row.id,
              caracteristica_id: caracteristica,
              nombre_snapshot: caracteristica,
              valor_id: null,
              valor: 'Cotton ' + i,
            });
        }
      });
      let queries = 0,
        sqlMs = 0;
      const instrumented = {
        read: <T>(work: (db: CatalogDatabase) => Promise<T>) =>
          database.read(async (db) => {
            const started = performance.now();
            try {
              return await work(
                new Proxy(db, {
                  get(target, key, receiver) {
                    if (key === 'transaction')
                      return (
                        callback: (tx: CatalogTransaction) => Promise<T>,
                        config: Parameters<CatalogDatabase['transaction']>[1],
                      ) =>
                        target.transaction(
                          (tx) =>
                            callback(
                              new Proxy(tx, {
                                get(t, k, r) {
                                  const member = Reflect.get(t, k, r);
                                  if (k === 'select' || k === 'execute')
                                    return (...args: unknown[]) => {
                                      queries++;
                                      return Reflect.apply(member, t, args);
                                    };
                                  return typeof member === 'function'
                                    ? member.bind(t)
                                    : member;
                                },
                              }),
                            ),
                          config,
                        );
                    return Reflect.get(target, key, receiver);
                  },
                }),
              );
            } finally {
              sqlMs += performance.now() - started;
            }
          }),
      } as Database;
      const versions = [
        new LegacyDemoList(instrumented),
        new PostgresCatalogRepository(instrumented),
      ];
      const base: ProductQuery = {
        canal: 'MARKETPLACE',
        q: marker,
        pagina: 1,
        tamanio: 4,
        orden: 'NOMBRE_ASC',
      };
      for (const tamanio of [4, 24])
        for (const orden of ['NOMBRE_ASC', 'NOMBRE_DESC'] as const)
          for (const pagina of [1, 2]) {
            const results = [];
            for (const [index, reads] of versions.entries()) {
              queries = 0;
              sqlMs = 0;
              let pricingMs = 0;
              const signals = new CatalogTelemetry();
              const measure = signals.measure.bind(signals);
              signals.measure = async (stage, work, correlation) => {
                const started = performance.now();
                try {
                  return await measure(stage, work, correlation);
                } finally {
                  if (stage === 'DEMO_PRICING')
                    pricingMs = performance.now() - started;
                }
              };
              const service = new CommercialService(
                reads,
                {} as TaxonomyClient,
                { enabled: false },
                { marketplaceDemoPreview: true } as CatalogConfig,
                {
                  currentPrice: async (id) => {
                    await pause(2);
                    return missingPrice.has(id)
                      ? null
                      : {
                          precio_regular: 10,
                          precio_oferta: null,
                          currency: 'PEN',
                        };
                  },
                },
                undefined,
                signals,
              );
              const started = performance.now();
              const response = await service.list({
                ...base,
                tamanio,
                orden,
                pagina,
              });
              const totalMs = performance.now() - started;
              results.push(response);
              expect(queries).toBe(index === 0 ? 79 : 4);
              process.stdout.write(
                JSON.stringify({
                  evidence: 'PERF-49-controlled-postgres-pricing-fixture',
                  environment: 'disposable PostgreSQL 17 Alpine over TLS',
                  candidateVolume: 36,
                  method:
                    'wall clock around repository and deterministic local Pricing fixture; SQL SELECT/execute calls instrumented',
                  version: index === 0 ? '6278b686-legacy' : 'candidate',
                  tamanio,
                  orden,
                  pagina,
                  queries,
                  sqlMs,
                  pricingMs,
                  totalMs,
                  items: response.items.length,
                  total: response.total,
                }) + '\n',
              );
            }
            expect(results[1]).toEqual(results[0]);
            expect(results[1].total).toBe(25);
          }
      for (const filter of [
        { categoriaId: marker },
        { marcaId: marker },
        { categoriaId: marker, marcaId: marker },
        { q: marker + '-absent' },
      ]) {
        expect(
          await versions[1].listDemoCandidates({ ...base, ...filter }, 100),
        ).toEqual(
          await versions[0].listDemoCandidates({ ...base, ...filter }, 100),
        );
      }
      await expect(versions[0].listDemoCandidates(base, 35)).rejects.toThrow();
      expect(await versions[1].listDemoCandidates(base, 35)).toHaveLength(30);
      expect((await versions[1].listCandidates(base)).items).toEqual([]);
    }, 30000);

    it('JOINT-01: commits aggregate/Outbox, transports requested/results through a real broker, deduplicates Inbox and reconnects', async () => {
      // Seed an internal BORRADOR coordination fixture, not a mocked HTTP or Taxonomy flow.
      const correlation = randomUUID(),
        operation = randomUUID(),
        messageId = randomUUID(),
        sku = '000-JOINT-' + randomUUID();
      const product = await transactions.run(async (tx) => {
        const row = await repository.insertProduct(tx, productInput(sku));
        const data = { product_id: row.id, sku, variant_id: null };
        await repository.insertActivationCheck(tx, {
          product_id: row.id,
          sku,
          dependency: 'INVENTORY',
          operation_id: operation,
          correlation_id: correlation,
          state: 'PENDING',
          request_payload: data,
        });
        await repository.insertOutboxMessage(tx, {
          message_id: messageId,
          event_name: 'inventory.sku.initialization.requested',
          kind: 'command',
          correlation_id: correlation,
          operation_id: operation,
          occurred_at: new Date(),
          payload: data,
        });
        return row;
      });
      const signals = new CatalogTelemetry();
      jointRuntime = new CatalogAmqpRuntime(
        new CatalogMessageService(database, signals),
        jointBroker.settings,
      );
      jointRuntime.onModuleInit();
      const requested = await jointBroker.next('po.inventario.q');
      expect(JSON.parse(requested.content.toString()).message_id).toBe(
        messageId,
      );
      const result = {
        message_id: randomUUID(),
        schema_version: 1,
        occurred_at: new Date().toISOString(),
        correlation_id: correlation,
        operation_id: operation,
        causation_id: messageId,
        producer: 'inventory-svc',
        kind: 'result',
        name: 'inventory.sku.initialization.completed',
        data: {
          product_id: product.id,
          sku,
          variant_id: null,
          status: 'INITIALIZED',
          completed_at: new Date().toISOString(),
        },
      };
      await jointBroker.result('inventory', result);
      async function completed() {
        const [row] = await database.read((db) =>
          db
            .select()
            .from(activationChecks)
            .where(eq(activationChecks.operation_id, operation)),
        );
        return row.state === 'COMPLETED';
      }
      const deadline = Date.now() + 15000;
      while (!(await completed())) {
        if (Date.now() > deadline)
          throw new Error('Joint result not committed');
        await pause(50);
      }
      await jointBroker.result('inventory', result);
      const replayDeadline = Date.now() + 15000;
      while (!signals.snapshot().INBOX_DUPLICATE) {
        if (Date.now() > replayDeadline)
          throw new Error('Joint replay not processed');
        await pause(50);
      }
      const seen = await database.read((db) =>
        db.execute(
          sql`SELECT count(*)::int AS n FROM catalog.inbox WHERE message_id=${result.message_id}`,
        ),
      );
      expect(seen.rows[0]?.n).toBe(1);
      const [published] = await database.read((db) =>
        db.select().from(outbox).where(eq(outbox.message_id, messageId)),
      );
      expect(published.published_at).not.toBeNull();
      jointBroker.stop();
      const followupId = randomUUID();
      await transactions.run(async (tx) => {
        const pending = await repository.insertProduct(
          tx,
          productInput('AFTER-OUTAGE-' + randomUUID()),
        );
        const nextOperation = randomUUID(),
          data = {
            product_id: pending.id,
            sku: pending.sku_base,
            variant_id: null,
          };
        await repository.insertActivationCheck(tx, {
          product_id: pending.id,
          sku: pending.sku_base,
          dependency: 'INVENTORY',
          operation_id: nextOperation,
          correlation_id: correlation,
          state: 'PENDING',
          request_payload: data,
        });
        return repository.insertOutboxMessage(tx, {
          message_id: followupId,
          event_name: 'inventory.sku.initialization.requested',
          kind: 'command',
          correlation_id: correlation,
          operation_id: nextOperation,
          occurred_at: new Date(),
          payload: data,
        });
      });
      const [pending] = await database.read((db) =>
        db.select().from(outbox).where(eq(outbox.message_id, followupId)),
      );
      expect(pending.published_at).toBeNull();
      await jointBroker.resume();
      expect(
        JSON.parse(
          (await jointBroker.next('po.inventario.q')).content.toString(),
        ).message_id,
      ).toBe(followupId);
      await jointRuntime.onModuleDestroy();
      jointRuntime = undefined;
    }, 90000);

    it('PG-FAULT-01: statement timeout rolls back the transaction and the same pool recovers', async () => {
      const sku = 'TIMEOUT-' + randomUUID();
      await expect(
        transactions.run(async (tx) => {
          await repository.insertProduct(tx, productInput(sku));
          await tx.execute(sql`SET LOCAL statement_timeout='20ms'`);
          await tx.execute(sql`SELECT pg_sleep(0.1)`);
        }),
      ).rejects.toMatchObject({ failure: 'connection', sqlState: '57014' });
      expect(
        await database.read((db) =>
          db.select().from(products).where(eq(products.sku_base, sku)),
        ),
      ).toHaveLength(0);
      await expect(database.verifyIdentity()).resolves.toBeUndefined();
    });

    it('PG-FAULT-02: pool saturation times out safely and the same test pool recovers after release', async () => {
      // Dedicated small pool only in this fault-injection test; same disposable PG instance.
      const saturated = new Database({
        ...persistenceSettings,
        pool: {
          ...persistenceSettings.pool,
          max: 1,
          connectionTimeoutMillis: 1000,
        },
      });
      let release!: () => void, ready!: () => void;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        acquired = new Promise<void>((resolve) => {
          ready = resolve;
        });
      const blocker = saturated.transaction(async () => {
        ready();
        await gate;
      });
      try {
        await acquired;
        await expect(saturated.verifyIdentity()).rejects.toMatchObject({
          failure: 'connection',
        });
        release();
        await blocker;
        await expect(saturated.verifyIdentity()).resolves.toBeUndefined();
      } finally {
        release();
        await blocker;
        await saturated.onModuleDestroy();
      }
    });

    it('persists a product, trigger-created SKU identity, and exact numeric profile values', async () => {
      const sku = 'SKU-' + randomUUID();
      const product = await transactions.run(async (tx) => {
        const row = await repository.insertProduct(tx, productInput(sku));
        const identity = await repository.findSkuIdentity(tx, sku);
        if (!identity) throw new Error('Trigger-created SKU identity missing');
        await repository.insertPhysicalProfile(tx, {
          sku_identity_id: identity.id,
          peso_kg: '12345678901234567890.123456789',
          largo_cm: '1.25',
          ancho_cm: '2.50',
          alto_cm: '3.75',
        });
        return row;
      });
      const profile = await database.read((db) =>
        db
          .select({ peso_kg: skuPhysicalProfiles.peso_kg })
          .from(skuPhysicalProfiles)
          .innerJoin(
            skuIdentity,
            sql`${skuIdentity.id} = ${skuPhysicalProfiles.sku_identity_id}`,
          )
          .where(sql`${skuIdentity.sku} = ${sku}`),
      );
      expect(product.id).toBeTruthy();
      expect(profile[0]?.peso_kg).toBe('12345678901234567890.123456789');
    });

    it('rolls back operation failures and reports deferred aggregate constraints at commit', async () => {
      const rolledBackSku = 'SKU-' + randomUUID();
      const rollbackFailure = new Error('force rollback');
      await expect(
        transactions.run(async (tx) => {
          await repository.insertProduct(tx, productInput(rolledBackSku));
          throw rollbackFailure;
        }),
      ).rejects.toBe(rollbackFailure);
      const [missing] = await database.read((db) =>
        db
          .select({ id: products.id })
          .from(products)
          .where(sql`${products.sku_base} = ${rolledBackSku}`),
      );
      expect(missing).toBeUndefined();

      const deferredSku = 'SKU-' + randomUUID();
      await expect(
        transactions.run(async (tx) => {
          await repository.insertProduct(tx, {
            ...productInput(deferredSku),
            estado: 'ACTIVO',
          });
        }),
      ).rejects.toMatchObject({ failure: 'deferred_constraint' });
    });

    it('classifies unique, foreign-key, and check violations without exposing driver text', async () => {
      const sku = 'SKU-' + randomUUID();
      const parent = await transactions.run(async (tx) => {
        return repository.insertProduct(tx, productInput(sku));
      });
      await expect(
        transactions.run(async (tx) => {
          await repository.insertProduct(tx, productInput(sku));
        }),
      ).rejects.toMatchObject({ failure: 'unique' });
      await expect(
        transactions.run(async (tx) => {
          await repository.insertVariant(tx, {
            product_id: parent.id,
            sku,
            identifying_key: { size: { value_id: 'M' } },
          });
        }),
      ).rejects.toMatchObject({ failure: 'unique' });
      await expect(
        transactions.run(async (tx) => {
          await repository.insertVariant(tx, {
            product_id: randomUUID(),
            sku: 'SKU-' + randomUUID(),
            identifying_key: { size: { value_id: 'M' } },
          });
        }),
      ).rejects.toMatchObject({ failure: 'foreign_key' });
      await expect(
        transactions.run(async (tx) => {
          await repository.insertProduct(tx, {
            ...productInput(''),
            nombre: '',
          });
        }),
      ).rejects.toMatchObject({ failure: 'check' });
      const notNullError = await transactions
        .run(async (tx) => {
          await tx.execute(sql`
            UPDATE catalog.products SET nombre = ${null} WHERE id = ${parent.id}
          `);
        })
        .catch((error: unknown) => error);
      expect(notNullError).toMatchObject({
        failure: 'not_null',
        sqlState: '23502',
        message: 'Falló una operación de persistencia de Catálogo',
      });
      expect(JSON.stringify(notNullError)).not.toContain('UPDATE');
      expect(JSON.stringify(notNullError)).not.toContain('catalog.products');
      expect(JSON.stringify(notNullError)).not.toContain(parent.id);
      await expect(
        database.read((db) =>
          db.execute(sql`SELECT 'INVALID'::catalog.estado_producto`),
        ),
      ).rejects.toMatchObject({ failure: 'other' });
    });

    it('serializes concurrent SKU reservations through PostgreSQL uniqueness', async () => {
      const sku = 'SKU-' + randomUUID();
      const attempts = await Promise.allSettled([
        transactions.run(async (tx) => {
          await repository.insertProduct(tx, productInput(sku));
        }),
        transactions.run(async (tx) => {
          await repository.insertProduct(tx, productInput(sku));
        }),
      ]);
      expect(
        attempts.filter((attempt) => attempt.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        attempts.filter(
          (attempt) =>
            attempt.status === 'rejected' &&
            attempt.reason instanceof CatalogPersistenceError &&
            attempt.reason.failure === 'unique',
        ),
      ).toHaveLength(1);
    });

    it('validates the DATA-002 batch in disposable PostgreSQL', () => {
      const catalogDirectory = resolve('scripts/seed/mcp/catalog');
      const manifest = JSON.parse(
        readFileSync(
          join(catalogDirectory, '002_manifest_catalogo.json'),
          'utf8',
        ),
      ) as {
        taxonomy: {
          brands: Record<string, string>;
          types: Record<string, string>;
          categories: Record<string, string>;
          characteristics: Record<string, string>;
          values: Record<string, Record<string, string>>;
        };
      };
      const sqlLiteral = (value: string) =>
        "'" + value.replaceAll("'", "''") + "'";
      const rows = (values: string[]) => values.join(',\n');
      const brandRows = Object.entries(manifest.taxonomy.brands).map(
        ([name, id]) => `(${sqlLiteral(id)}, ${sqlLiteral(name)}, 'ACTIVO')`,
      );
      const typeRows = Object.entries(manifest.taxonomy.types).map(
        ([name, id]) => `(${sqlLiteral(id)}, ${sqlLiteral(name)}, 'ACTIVO')`,
      );
      const categoryRows = Object.entries(manifest.taxonomy.categories).map(
        ([name, id]) =>
          `(${sqlLiteral(id)}, ${sqlLiteral(name)}, NULL, 'ACTIVO')`,
      );
      const characteristicRows = Object.entries(
        manifest.taxonomy.characteristics,
      ).map(
        ([name, id]) => `(${sqlLiteral(id)}, ${sqlLiteral(name)}, 'ACTIVO')`,
      );
      const valueRows = Object.entries(manifest.taxonomy.values).flatMap(
        ([characteristic, values]) =>
          Object.entries(values).map(
            ([name, id]) =>
              `(${sqlLiteral(id)}, ${sqlLiteral(manifest.taxonomy.characteristics[characteristic]!)}, ${sqlLiteral(name)}, 'ACTIVO')`,
          ),
      );
      const relationRows = Object.values(manifest.taxonomy.types).flatMap(
        (typeId) =>
          Object.values(manifest.taxonomy.characteristics).map(
            (characteristicId) =>
              `(${sqlLiteral(typeId)}, ${sqlLiteral(characteristicId)}, true, 'ACTIVO')`,
          ),
      );
      const taxonomyFixture = `
        CREATE SCHEMA taxonomy;
        CREATE SCHEMA storage;
        CREATE TYPE taxonomy.estado_entidad AS ENUM ('ACTIVO', 'INACTIVO');
        CREATE TABLE taxonomy.brands (id uuid PRIMARY KEY, nombre text NOT NULL, estado taxonomy.estado_entidad NOT NULL);
        CREATE TABLE taxonomy.product_types (id uuid PRIMARY KEY, nombre text NOT NULL, estado taxonomy.estado_entidad NOT NULL);
        CREATE TABLE taxonomy.categories (id uuid PRIMARY KEY, nombre text NOT NULL, categoria_padre_id uuid, estado taxonomy.estado_entidad NOT NULL);
        CREATE TABLE taxonomy.characteristics (id uuid PRIMARY KEY, nombre text NOT NULL, estado taxonomy.estado_entidad NOT NULL);
        CREATE TABLE taxonomy.characteristic_values (id uuid PRIMARY KEY, caracteristica_id uuid NOT NULL, nombre text NOT NULL, estado taxonomy.estado_entidad NOT NULL);
        CREATE TABLE taxonomy.product_type_characteristics (tipo_producto_id uuid NOT NULL, caracteristica_id uuid NOT NULL, obligatoria boolean NOT NULL, estado taxonomy.estado_entidad NOT NULL);
        CREATE TABLE storage.objects (name text NOT NULL, mime_type text, metadata jsonb, bucket_id text NOT NULL);
        INSERT INTO taxonomy.brands (id, nombre, estado) VALUES ${rows(brandRows)};
        INSERT INTO taxonomy.product_types (id, nombre, estado) VALUES ${rows(typeRows)};
        INSERT INTO taxonomy.categories (id, nombre, categoria_padre_id, estado) VALUES ${rows(categoryRows)};
        INSERT INTO taxonomy.characteristics (id, nombre, estado) VALUES ${rows(characteristicRows)};
        INSERT INTO taxonomy.characteristic_values (id, caracteristica_id, nombre, estado) VALUES ${rows(valueRows)};
        INSERT INTO taxonomy.product_type_characteristics (tipo_producto_id, caracteristica_id, obligatoria, estado) VALUES ${rows(relationRows)};
        GRANT USAGE ON SCHEMA taxonomy TO po_catalog_owner;
        GRANT SELECT ON ALL TABLES IN SCHEMA taxonomy TO po_catalog_owner;
      `;
      command(
        'docker',
        [
          'exec',
          '-i',
          container,
          'psql',
          '-U',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
        ],
        taxonomyFixture,
      );

      const preflightSql = readFileSync(
        join(catalogDirectory, '001_preflight_readonly.sql'),
        'utf8',
      );
      const runSql = (input: string) =>
        spawnSync(
          'docker',
          [
            'exec',
            '-i',
            container,
            'psql',
            '-X',
            '-q',
            '-U',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
          ],
          {
            encoding: 'utf8',
            input,
            timeout: 120000,
            windowsHide: true,
          },
        );
      const preflight = command(
        'docker',
        [
          'exec',
          '-i',
          container,
          'psql',
          '-X',
          '-At',
          '-U',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
        ],
        preflightSql,
      );
      expect(preflight).not.toMatch(
        /FALTA_INACTIVA_O_CARACTERISTICA_INCORRECTA|RELACION_FALTA_O_INACTIVA|DATA002_PREFLIGHT_BLOCKED/,
      );

      const batch = readFileSync(
        join(catalogDirectory, '003_carga_catalogo.sql'),
        'utf8',
      );
      const existingProductCount = command('docker', [
        'exec',
        '-i',
        container,
        'psql',
        '-X',
        '-At',
        '-U',
        'postgres',
        '-c',
        'SELECT count(*) FROM catalog.products',
      ]);
      const expectPreflightToBlock = (
        mutation: string,
        restoration: string,
      ) => {
        command(
          'docker',
          [
            'exec',
            '-i',
            container,
            'psql',
            '-X',
            '-q',
            '-U',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
          ],
          mutation,
        );
        for (const sqlText of [preflightSql, batch]) {
          const result = runSql(sqlText);
          expect(result.error).toBeUndefined();
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain('DATA002_PREFLIGHT_BLOCKED');
        }
        expect(
          command('docker', [
            'exec',
            '-i',
            container,
            'psql',
            '-X',
            '-At',
            '-U',
            'postgres',
            '-c',
            'SELECT count(*) FROM catalog.products',
          ]),
        ).toBe(existingProductCount);
        command(
          'docker',
          [
            'exec',
            '-i',
            container,
            'psql',
            '-X',
            '-q',
            '-U',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
          ],
          restoration,
        );
      };
      const brandEntry = Object.entries(manifest.taxonomy.brands).find(
        ([, id]) => id === 'd05cc621-2d16-faa3-f620-19fb3173737c',
      );
      expect(brandEntry).toBeDefined();
      expectPreflightToBlock(
        "DELETE FROM taxonomy.brands WHERE id = 'd05cc621-2d16-faa3-f620-19fb3173737c';",
        `INSERT INTO taxonomy.brands (id, nombre, estado) VALUES (${sqlLiteral(brandEntry![1])}, ${sqlLiteral(brandEntry![0])}, 'ACTIVO');`,
      );
      expectPreflightToBlock(
        "UPDATE taxonomy.product_types SET estado = 'INACTIVO' WHERE id = 'b023a151-d69f-ff9a-483a-678eefe6842e';",
        "UPDATE taxonomy.product_types SET estado = 'ACTIVO' WHERE id = 'b023a151-d69f-ff9a-483a-678eefe6842e';",
      );
      expectPreflightToBlock(
        "UPDATE taxonomy.product_type_characteristics SET estado = 'INACTIVO' WHERE tipo_producto_id = 'b023a151-d69f-ff9a-483a-678eefe6842e' AND caracteristica_id = 'acee6db1-ba1c-f020-caf8-f439b09556ff';",
        "UPDATE taxonomy.product_type_characteristics SET estado = 'ACTIVO' WHERE tipo_producto_id = 'b023a151-d69f-ff9a-483a-678eefe6842e' AND caracteristica_id = 'acee6db1-ba1c-f020-caf8-f439b09556ff';",
      );
      const executeBatch = () =>
        command(
          'docker',
          [
            'exec',
            '-i',
            container,
            'psql',
            '-X',
            '-q',
            '-U',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
          ],
          `SET ROLE po_catalog_owner;\n${batch}`,
        );
      executeBatch();
      executeBatch();

      const postcheck = command(
        'docker',
        [
          'exec',
          '-i',
          container,
          'psql',
          '-X',
          '-At',
          '-F',
          '|',
          '-U',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
        ],
        readFileSync(
          join(catalogDirectory, '004_postcheck_readonly.sql'),
          'utf8',
        ),
      );
      const postcheckRows = postcheck
        .split(/\r?\n/)
        .filter((row) => row.length > 0);
      expect(postcheckRows).toHaveLength(12);
      expect(postcheckRows.every((row) => row.endsWith('|PASS'))).toBe(true);
      expect(postcheckRows).toContain('productos|15|15|PASS');
      expect(postcheckRows).toContain('variantes|45|45|PASS');
      expect(postcheckRows).toContain('payloads_jsonb_validos|0|0|PASS');

      const conflict = spawnSync(
        'docker',
        [
          'exec',
          '-i',
          container,
          'psql',
          '-X',
          '-q',
          '-U',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
        ],
        {
          encoding: 'utf8',
          input: `UPDATE catalog.products SET descripcion = 'different payload' WHERE id = '96c6972f-2bd2-5528-8028-5293fe719db9';\nSET ROLE po_catalog_owner;\n${batch}`,
          timeout: 120000,
          windowsHide: true,
        },
      );
      expect(conflict.error).toBeUndefined();
      expect(conflict.status).not.toBe(0);
      expect(conflict.stderr).toContain(
        'DATA-002 contenido diferente en catalog.products',
      );
    });

    // These provider tests use authoritative master fixtures, never shared Taxonomy or Supabase writes.
    function mutationService(
      creationPolicy: CatalogProductCreationPolicy = {
        resolve: async (_input, id) => ({
          slug: 'fixture-' + id,
          moneda: 'PEN',
        }),
      },
      masterOverrides: Partial<CatalogMasterClient> = {},
    ) {
      return new CatalogMutationService(
        transactions,
        repository,
        {
          masters: async () => ({ schemaVersion: 1 }),
          attributes: async (_type: string, values: Attribute[]) => values,
          ...masterOverrides,
        } as unknown as CatalogMasterClient,
        creationPolicy,
      );
    }
    const actor = {
      authorization: 'Bearer isolated-master-fixture',
      correlationId: randomUUID(),
    };
    const fullProfile = {
      pesoKg: 1.5,
      dimensionesCm: { largo: 10, ancho: 20, alto: 30 },
    };
    function createRequest(hasVariants = false) {
      return {
        nombre: 'Mutation fixture',
        descripcion: 'Disposable',
        categoriaId: 'category-fixture',
        tipoProductoId: 'type-fixture',
        marcaId: 'brand-fixture',
        skuBase: '000-' + randomUUID(),
        tieneVariantes: hasVariants,
        precioBaseInicial: 20,
        imagenes: [{ url: 'https://example.test/product' }],
        ...(hasVariants ? {} : { perfilFisico: fullProfile }),
      };
    }
    function bulkRow(product = createRequest(), rowNumber = 2): BulkRow {
      return {
        row_number: rowNumber,
        row_operation_id: randomUUID(),
        producto_id: null,
        sku_base: product.skuBase,
        product,
        variant_id: null,
        variant: null,
      };
    }
    function bulkCommand(
      rows: BulkRow[],
      mode = 'ALTA',
      version: 1 | 2 = 1,
    ): CatalogEnvelope {
      const operation = randomUUID();
      return {
        message_id: randomUUID(),
        schema_version: version,
        occurred_at: new Date().toISOString(),
        correlation_id: randomUUID(),
        causation_id: null,
        operation_id: operation,
        producer: 'bulk-svc',
        kind: 'command',
        name: 'catalog.bulk.upsert.requested',
        data: {
          batch_id: randomUUID(),
          batch_operation_id: operation,
          template_version: 2,
          mode,
          rows,
        },
      };
    }
    function bulkHandler(mutations = mutationService()) {
      const identity = new CatalogBulkIdentity(
        undefined,
        new CatalogTokenVerifier(undefined),
      );
      vi.spyOn(identity, 'authorization').mockResolvedValue(
        actor.authorization,
      );
      return new CatalogBulkService(database, mutations, identity);
    }
    async function bulkReply(command: CatalogEnvelope) {
      return database.read(
        async (db) =>
          (
            await db
              .select()
              .from(outbox)
              .where(
                and(
                  eq(outbox.causation_id, command.message_id),
                  sql`${outbox.event_name} LIKE 'catalog.bulk.upsert.%'`,
                ),
              )
          )[0]!,
      );
    }
    it('BULK: persists ALTA, concurrent delivery dedupe, row replay and payload conflicts before acknowledgement', async () => {
      const row = bulkRow(),
        message = bulkCommand([row]),
        service = bulkHandler();
      expect(
        (
          await Promise.all([
            service.consume(message),
            service.consume(message),
          ])
        ).sort(),
      ).toEqual(['APPLIED', 'DUPLICATE']);
      const result = await bulkReply(message),
        results = result.payload.results as BulkRowResult[];
      expect(results[0]).toMatchObject({
        status: 'COMPLETED',
        code: null,
        sku_base: row.sku_base,
      });
      const id = results[0].product_id!;
      expect(await requested(id)).toHaveLength(2);
      const replay = { ...message, message_id: randomUUID() };
      await service.consume(replay);
      expect((await bulkReply(replay)).payload).toEqual(result.payload);
      const rowReplay = bulkCommand([row]);
      rowReplay.data.batch_id = message.data.batch_id;
      await service.consume(rowReplay);
      expect((await bulkReply(rowReplay)).payload.results).toEqual(results);
      const conflict = bulkCommand([
        { ...row, product: { ...row.product, nombre: 'conflict' } },
      ]);
      conflict.data.batch_id = message.data.batch_id;
      await service.consume(conflict);
      expect((await bulkReply(conflict)).payload.results).toMatchObject([
        { status: 'REJECTED', code: 'IDEMPOTENCY_CONFLICT' },
      ]);
      expect(await requested(id)).toHaveLength(2);
      expect(
        await database.read((db) =>
          db.select().from(products).where(eq(products.sku_base, row.sku_base)),
        ),
      ).toHaveLength(1);
      const invalid = bulkCommand([bulkRow()]);
      invalid.data.template_version = 1;
      await service.consume(invalid);
      expect(await bulkReply(invalid)).toMatchObject({
        event_name: 'catalog.bulk.upsert.rejected',
        payload: { code: 'VALIDACION' },
      });
      const commandConflict = {
        ...message,
        message_id: randomUUID(),
        data: { ...message.data, template_version: 0 },
      };
      await service.consume(commandConflict);
      expect((await bulkReply(commandConflict)).payload.code).toBe(
        'IDEMPOTENCY_CONFLICT',
      );
    });
    it('BULK: reports a real slug UNIQUE as SLUG_DUPLICADO, never SKU_DUPLICADO, and preserves replay', async () => {
      const existing = await mutationService().createProduct(
        createRequest(),
        actor,
      );
      const duplicateSlug = bulkRow(),
        valid = bulkRow(createRequest(), 3);
      const mutations = mutationService({
        resolve: async (input, id) => ({
          slug:
            input.skuBase === duplicateSlug.sku_base
              ? existing.slug
              : 'fixture-' + id,
          moneda: 'PEN',
        }),
      });
      const handler = bulkHandler(mutations),
        message = bulkCommand([duplicateSlug, valid]);
      await handler.consume(message);
      const reply = await bulkReply(message);
      expect(reply.payload.results).toMatchObject([
        {
          row_operation_id: duplicateSlug.row_operation_id,
          status: 'REJECTED',
          code: 'SLUG_DUPLICADO',
        },
        {
          row_operation_id: valid.row_operation_id,
          status: 'COMPLETED',
          code: null,
        },
      ]);
      expect(
        await database.read((db) =>
          db
            .select()
            .from(products)
            .where(eq(products.sku_base, duplicateSlug.sku_base)),
        ),
      ).toEqual([]);
      expect(
        await database.read((db) =>
          db
            .select()
            .from(skuIdentity)
            .where(eq(skuIdentity.sku, duplicateSlug.sku_base)),
        ),
      ).toEqual([]);
      expect(await requested(existing.product_id)).toHaveLength(2);
      const replay = { ...message, message_id: randomUUID() };
      await handler.consume(replay);
      expect((await bulkReply(replay)).payload.results).toEqual(
        reply.payload.results,
      );
      expect(
        await database.read((db) =>
          db
            .select()
            .from(products)
            .where(eq(products.sku_base, valid.sku_base)),
        ),
      ).toHaveLength(1);
    });

    it('BULK: creates one parent per variant family, applies parent version once on update and rolls back rejected families', async () => {
      const parent = createRequest(true),
        sku = 'variant-' + randomUUID();
      const rows = ['S', 'M'].map((size, i) => ({
        ...bulkRow(parent, i + 2),
        variant: {
          sku: sku + size,
          atributosIdentificadores: [
            {
              caracteristica_id: 'size',
              nombre: 'Size',
              valor_id: size,
              valor: size,
            },
          ],
          imagenUrl: 'https://example.test/variant',
        },
      }));
      const service = bulkHandler(),
        message = bulkCommand(rows);
      await service.consume(message);
      const results = (await bulkReply(message)).payload
        .results as BulkRowResult[];
      expect(results).toMatchObject([
        { status: 'COMPLETED' },
        { status: 'COMPLETED' },
      ]);
      expect(results[0].product_id).toBe(results[1].product_id);
      const mixedReplay = bulkCommand(
        rows.map((r, i) =>
          i === 0
            ? {
                ...r,
                variant: {
                  ...r.variant,
                  imagenUrl: 'https://example.test/conflict',
                },
              }
            : r,
        ),
      );
      mixedReplay.data.batch_id = message.data.batch_id;
      await service.consume(mixedReplay);
      expect((await bulkReply(mixedReplay)).payload.results).toMatchObject([
        { status: 'REJECTED', code: 'IDEMPOTENCY_CONFLICT' },
        { status: 'COMPLETED', code: null },
      ]);

      const id = results[0].product_id!,
        reads = new PostgresCatalogRepository(database);
      const stored = await database.read(
        async (db) =>
          (await db.select().from(products).where(eq(products.id, id)))[0]!,
      );
      const children = await database.read((db) =>
        db.select().from(variants).where(eq(variants.product_id, id)),
      );
      expect(stored.catalog_version).toBe(0n);
      expect(children).toHaveLength(2);
      expect(await requested(id)).toHaveLength(3);
      const updateRows: BulkRow[] = children.map((v, i) => ({
        row_number: i + 2,
        row_operation_id: randomUUID(),
        producto_id: id,
        sku_base: parent.skuBase,
        product: {
          catalogVersion: Number(stored.catalog_version),
          descripcion: 'updated once',
        },
        variant_id: v.id,
        variant: {
          catalogVersion: Number(v.catalog_version),
          imagenUrl: 'https://example.test/updated',
        },
      }));
      const update = bulkCommand(updateRows, 'ACTUALIZACION');
      await service.consume(update);
      expect((await bulkReply(update)).payload.results).toMatchObject([
        { status: 'COMPLETED' },
        { status: 'COMPLETED' },
      ]);
      for (const child of children)
        expect(await reads.skuContext(child.sku)).toMatchObject({
          productId: id,
          isVariant: true,
        });
      const afterUpdate = await database.read(
        async (db) =>
          (await db.select().from(products).where(eq(products.id, id)))[0]!,
      );
      expect(afterUpdate.catalog_version).toBe(stored.catalog_version + 1n);
      const missingVersion = bulkCommand(
        updateRows.map((r) => ({
          ...r,
          row_operation_id: randomUUID(),
          variant: { imagenUrl: 'https://example.test/missing-version' },
        })),
        'ACTUALIZACION',
      );
      await service.consume(missingVersion);
      expect((await bulkReply(missingVersion)).payload.results).toMatchObject([
        { code: 'VALIDACION' },
        { code: 'VALIDACION' },
      ]);
      const stale = bulkCommand(
        updateRows.map((r) => ({ ...r, row_operation_id: randomUUID() })),
        'ACTUALIZACION',
      );
      await service.consume(stale);
      expect((await bulkReply(stale)).payload.results).toMatchObject([
        { code: 'VERSION_CONFLICT' },
        { code: 'VERSION_CONFLICT' },
      ]);
      const badParent = createRequest(true),
        valid = bulkRow();
      const bad = rows.map((r, i) => ({
        ...r,
        row_number: i + 3,
        row_operation_id: randomUUID(),
        sku_base: badParent.skuBase,
        product: badParent,
        variant: { ...r.variant, sku: 'duplicate-' + badParent.skuBase },
      }));
      const partial = bulkCommand([valid, ...bad]);
      await service.consume(partial);
      expect((await bulkReply(partial)).payload.results).toMatchObject([
        { status: 'COMPLETED' },
        { status: 'REJECTED', code: 'SKU_DUPLICADO' },
        { status: 'REJECTED', code: 'SKU_DUPLICADO' },
      ]);
      expect(
        await database.read((db) =>
          db
            .select()
            .from(products)
            .where(eq(products.sku_base, badParent.skuBase)),
        ),
      ).toHaveLength(0);
    });
    it.each([
      ['unavailability', new ServiceUnavailableException()],
      [
        'unmapped UNIQUE',
        new CatalogPersistenceError('unique', '23505', 'uq_outbox_message_id'),
      ],
    ])(
      'BULK: %s rolls back aggregate, preparation and receipts; redelivery can then commit',
      async (_label, failure) => {
        const mutations = mutationService(),
          original = mutations.createProduct.bind(mutations);
        let count = 0;
        const injected = vi
          .spyOn(mutations, 'createProduct')
          .mockImplementation(async (...args) => {
            if (++count === 2) throw failure;
            return original(...args);
          });
        const rows = [bulkRow(), bulkRow(createRequest(), 3)],
          message = bulkCommand(rows),
          service = bulkHandler(mutations);
        await expect(service.consume(message)).rejects.toBe(failure);
        expect(await bulkReply(message)).toBeUndefined();
        for (const row of rows)
          expect(
            await database.read((db) =>
              db
                .select()
                .from(products)
                .where(eq(products.sku_base, row.sku_base)),
            ),
          ).toHaveLength(0);
        injected.mockRestore();
        await service.consume(message);
        expect((await bulkReply(message)).payload.results).toMatchObject([
          { status: 'COMPLETED' },
          { status: 'COMPLETED' },
        ]);
      },
    );
    it('BULK-JOINT: real Bulk importer/Outbox/Inbox and Catalog transactions over disposable RabbitMQ and TLS PostgreSQL', async () => {
      command(
        'docker',
        [
          'exec',
          '-i',
          container,
          'psql',
          '-U',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
        ],
        `CREATE ROLE po_bulk_owner NOLOGIN; CREATE ROLE bulk_fixture_app LOGIN PASSWORD 'isolated-bulk-password'; CREATE SCHEMA bulk AUTHORIZATION po_bulk_owner; SET ROLE po_bulk_owner; ${readFileSync(resolve('apps/catalog-svc/test/fixtures/0001_create_bulk_persistence.sql'), 'utf8')}
GRANT USAGE ON SCHEMA bulk TO bulk_fixture_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA bulk TO bulk_fixture_app; GRANT USAGE ON ALL SEQUENCES IN SCHEMA bulk TO bulk_fixture_app;`,
      );
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({ type: 'module' }),
      );
      const build = join(directory, 'bulk-build');
      command(process.execPath, [
        resolve('node_modules/typescript/bin/tsc'),
        '-p',
        resolve('apps/bulk-svc/tsconfig.app.json'),
        '--outDir',
        build,
        '--tsBuildInfoFile',
        join(directory, 'bulk.tsbuildinfo'),
      ]);
      symlinkSync(
        resolve('node_modules'),
        join(directory, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const bulk = bulkHandler(),
        messages = new CatalogMessageService(
          database,
          new CatalogTelemetry(),
          bulk,
        );
      jointRuntime = new CatalogAmqpRuntime(messages, jointBroker.settings);
      jointRuntime.onModuleInit();
      const sku = 'BULK-JOINT-' + randomUUID(),
        batch = randomUUID();
      try {
        const child = spawn(
          process.execPath,
          [resolve('apps/catalog-svc/test/support/bulk-peer.mjs')],
          {
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              NODE_ENV: 'test',
            },
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        child.stdin.end(
          JSON.stringify({
            build,
            port: Number(port),
            ca: caFile,
            broker: jointBroker.bulkUrl,
            sku,
            batch,
            correlation: randomUUID(),
          }),
        );
        const output: string[] = [],
          diagnostics: string[] = [];
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (data) => output.push(String(data)));
        const exit = await new Promise<number | null>((done, reject) => {
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error('Disposable Bulk peer timeout'));
          }, 90000);
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once('exit', (code) => {
            clearTimeout(timer);
            done(code);
          });
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (data) => {
            const safe = String(data).match(
              /Disposable Bulk peer failed at [a-z-]+ \([A-Z0-9_]+\)\./,
            );
            if (safe) diagnostics.push(safe[0]);
          });
        });
        if (exit !== 0) {
          try {
            const rejected = await jointBroker.next('po.catalogo.q.dlq');
            if (
              rejected.properties.headers?.['x-catalog-failure'] ===
                'INVALID_OR_BLOCKED_CONTRACT' &&
              !rejected.properties.headers?.['x-original-producer-user']
            )
              diagnostics.push('BLOCKED_BULK_AMQP_USER_ID_MISSING');
          } catch {
            diagnostics.push('NO_DURABLE_TRANSPORT_REJECTION_OBSERVED');
          }
        }
        expect(
          exit,
          'Bulk process must durably consume the real Catalog result: ' +
            diagnostics.join(' '),
        ).toBe(0);
        const line = output
          .join('')
          .split('\n')
          .find((line) => line.startsWith('BULK_FIXTURE_RESULT:'));
        expect(line).toBeDefined();
        const result = JSON.parse(line!.slice('BULK_FIXTURE_RESULT:'.length));
        expect(result).toMatchObject({
          inbox: 1,
          rows: [
            {
              applied: ['CATALOGO'],
              status: 'PROCESSING',
              steps: expect.arrayContaining([
                { domain: 'CATALOGO', status: 'COMPLETED' },
                { domain: 'PRICING', status: 'PENDING' },
                { domain: 'INVENTARIO', status: 'PENDING' },
              ]),
            },
          ],
        });
        const parents = await database.read((db) =>
          db.select().from(products).where(eq(products.sku_base, sku)),
        );
        expect(parents).toHaveLength(1);
        expect(await requested(parents[0].id)).toHaveLength(2);
        const replies = await database.read((db) =>
          db
            .select()
            .from(outbox)
            .where(
              and(
                eq(outbox.event_name, 'catalog.bulk.upsert.completed'),
                sql`${outbox.payload}->>'batch_id' = ${batch}`,
              ),
            ),
        );
        expect(replies).toHaveLength(1);
        expect(replies[0].published_at).not.toBeNull();
        // RabbitMQ queue statistics may lag the confirmed process shutdown.
        // Preserve the zero-delivery assertion, allowing only bounded drainage.
        await expect
          .poll(() => jointBroker.bulkQueueStats(), {
            timeout: 15000,
            interval: 500,
          })
          .toMatch(/po\.masivos\.q\s+0\s+0/);
        await expect
          .poll(() => jointBroker.bulkQueueStats(), {
            timeout: 15000,
            interval: 500,
          })
          .toMatch(/po\.catalogo\.q\s+0\s+0/);
      } finally {
        await jointRuntime.onModuleDestroy();
        jointRuntime = undefined;
      }
    }, 150000);
    it('BULK-v2: resolves opaque SKU under parent lock, validates selectors/versions, serializes concurrent updates and replays original receipts', async () => {
      const product = createRequest(true),
        handler = bulkHandler();
      const rows = ['A', 'B'].map((size, i) => ({
        ...bulkRow(product, i + 2),
        variant: {
          sku: ' 000,/ñ-' + randomUUID(),
          atributosIdentificadores: [
            {
              caracteristica_id: 'size',
              nombre: 'Size',
              valor_id: size,
              valor: size,
            },
          ],
          imagenUrl: 'https://example.test/bulk-v2',
          perfilFisico: fullProfile,
        },
      }));
      const alta = bulkCommand(rows, 'ALTA', 2);
      await handler.consume(parseCatalogMessage(alta));
      const altaReply = await bulkReply(alta);
      expect(altaReply.schema_version).toBe(1);
      const parentId = (altaReply.payload.results as BulkRowResult[])[0]
        .product_id!;
      const parents = () =>
        database.read((db) =>
          db.select().from(products).where(eq(products.id, parentId)),
        );
      const children = () =>
        database.read((db) =>
          db.select().from(variants).where(eq(variants.product_id, parentId)),
        );
      const initialParent = (await parents())[0],
        initialChildren = await children();
      const a = initialChildren.find((v) => v.sku === rows[0].variant.sku)!,
        b = initialChildren.find((v) => v.sku === rows[1].variant.sku)!;
      const updateRow = (
        selector: { variant_id?: string | null; sku_variante?: string | null },
        child = a,
      ): BulkRow => ({
        row_number: 2,
        row_operation_id: randomUUID(),
        producto_id: parentId,
        sku_base: product.skuBase,
        product: {
          catalogVersion: Number(initialParent.catalog_version),
          nombre: 'Bulk v2 updated',
        },
        variant: {
          catalogVersion: Number(child.catalog_version),
          imagenUrl: 'https://example.test/updated-v2',
        },
        ...selector,
      });
      const foreignParent = await mutationService().createProduct(
        createRequest(true),
        actor,
      );
      const foreign = await mutationService().createVariant(
        foreignParent.product_id,
        {
          sku: 'foreign-' + randomUUID(),
          atributosIdentificadores: [
            {
              caracteristica_id: 'size',
              nombre: 'Size',
              valor_id: 'F',
              valor: 'F',
            },
          ],
          imagenUrl: 'https://example.test/foreign',
          perfilFisico: fullProfile,
        },
        actor,
      );
      for (const [row, expected] of [
        [
          updateRow({ sku_variante: 'missing-' + randomUUID() }),
          'VARIANTE_NO_ENCONTRADA',
        ],
        [updateRow({ sku_variante: foreign.sku }), 'VARIANTE_NO_ENCONTRADA'],
        [updateRow({ sku_variante: a.sku, variant_id: b.id }), 'VALIDACION'],
        [
          {
            ...updateRow({ sku_variante: a.sku }),
            variant: { catalogVersion: Number(a.catalog_version) + 1 },
          },
          'VERSION_CONFLICT',
        ],
      ] as const) {
        const message = bulkCommand([row], 'ACTUALIZACION', 2);
        await handler.consume(parseCatalogMessage(message));
        expect((await bulkReply(message)).payload.results).toMatchObject([
          { status: 'REJECTED', code: expected },
        ]);
      }
      const duplicate = bulkCommand(
        [
          updateRow({ variant_id: a.id }),
          { ...updateRow({ sku_variante: a.sku }), row_number: 3 },
        ],
        'ACTUALIZACION',
        2,
      );
      await handler.consume(duplicate);
      expect((await bulkReply(duplicate)).payload.results).toMatchObject([
        { code: 'VALIDACION' },
        { code: 'VALIDACION' },
      ]);
      expect(await parents()).toEqual([initialParent]);
      expect(await children()).toEqual(initialChildren);
      const first = bulkCommand(
        [updateRow({ sku_variante: a.sku })],
        'ACTUALIZACION',
        2,
      );
      const second = bulkCommand(
        [updateRow({ sku_variante: a.sku })],
        'ACTUALIZACION',
        2,
      );
      const original = canonicalBulk(first);
      const dispositions = await Promise.all([
        handler.consume(parseCatalogMessage(first)),
        handler.consume(parseCatalogMessage(first)),
        handler.consume(parseCatalogMessage(second)),
      ]);
      expect(dispositions.sort()).toEqual(['APPLIED', 'APPLIED', 'DUPLICATE']);
      const replies = [await bulkReply(first), await bulkReply(second)];
      expect(
        replies
          .map((r) => (r.payload.results as BulkRowResult[])[0].code)
          .sort(),
      ).toEqual([null, 'VERSION_CONFLICT'].sort());
      const winner =
        (replies[0].payload.results as BulkRowResult[])[0].status ===
        'COMPLETED'
          ? first
          : second;
      expect(canonicalBulk(first)).toBe(original);
      expect((await parents())[0].catalog_version).toBe(
        initialParent.catalog_version + 1n,
      );
      const after = await children();
      expect(after.find((v) => v.id === a.id)!.catalog_version).toBe(
        a.catalog_version + 1n,
      );
      const two = [
        updateRow({ variant_id: b.id }, b),
        {
          ...updateRow({ variant_id: a.id, sku_variante: a.sku }),
          row_number: 3,
        },
      ];
      for (const row of two)
        row.product.catalogVersion = Number(initialParent.catalog_version + 1n);
      two[1].variant!.catalogVersion = Number(a.catalog_version + 1n);
      const multi = bulkCommand(two, 'ACTUALIZACION', 2);
      await handler.consume(parseCatalogMessage(multi));
      expect((await bulkReply(multi)).payload.results).toMatchObject([
        { status: 'COMPLETED' },
        { status: 'COMPLETED' },
      ]);
      const updated = (await parents())[0];
      expect(updated.catalog_version).toBe(initialParent.catalog_version + 2n);
      const replay = { ...winner, message_id: randomUUID() };
      await handler.consume(parseCatalogMessage(replay));
      expect((await bulkReply(replay)).payload.results).toEqual(
        (await bulkReply(winner)).payload.results,
      );
      expect((await parents())[0]).toEqual(updated);
      const changed = bulkCommand(
        [{ ...(winner.data.rows as BulkRow[])[0], variant_id: a.id }],
        'ACTUALIZACION',
        2,
      );
      changed.data.batch_id = winner.data.batch_id;
      await handler.consume(changed);
      expect((await bulkReply(changed)).payload.results).toMatchObject([
        { code: 'IDEMPOTENCY_CONFLICT' },
      ]);
      const simple = await mutationService().createProduct(
        createRequest(),
        actor,
      );
      const simpleUpdate = bulkCommand(
        [
          {
            row_number: 2,
            row_operation_id: randomUUID(),
            producto_id: simple.product_id,
            sku_base: simple.sku_base,
            product: {
              catalogVersion: simple.catalog_version,
              nombre: 'Simple v2',
            },
            variant: null,
          },
        ],
        'ACTUALIZACION',
        2,
      );
      await handler.consume(parseCatalogMessage(simpleUpdate));
      expect((await bulkReply(simpleUpdate)).payload.results).toMatchObject([
        { status: 'COMPLETED' },
      ]);
    });

    it('BULK-CONSUMER-v2: real RabbitMQ/PG, SKU resolution and replay (producer fixture; Bulk app remains v1)', async () => {
      const messages = new CatalogMessageService(
        database,
        new CatalogTelemetry(),
        bulkHandler(),
      );
      jointRuntime = new CatalogAmqpRuntime(messages, jointBroker.settings);
      jointRuntime.onModuleInit();
      const product = createRequest(true),
        sku = ' 000,/ñ-broker-' + randomUUID();
      const alta = bulkCommand(
        [
          {
            ...bulkRow(product),
            variant: {
              sku,
              atributosIdentificadores: [
                {
                  caracteristica_id: 'size',
                  nombre: 'Size',
                  valor_id: 'B',
                  valor: 'B',
                },
              ],
              imagenUrl: 'https://example.test/broker-v2',
              perfilFisico: fullProfile,
            },
          },
        ],
        'ALTA',
        2,
      );
      const nextReply = async (
        command: CatalogEnvelope,
      ): Promise<CatalogEnvelope> => {
        for (let i = 0; i < 100; i++) {
          const message = JSON.parse(
            (await jointBroker.next('po.masivos.q')).content.toString('utf8'),
          ) as CatalogEnvelope;
          if (message.causation_id === command.message_id) return message;
        }
        throw new Error('No matching consumer-v2 result');
      };
      try {
        await jointBroker.bulkCommand(alta);
        const created = await nextReply(alta);
        expect(created.schema_version).toBe(1);
        const parentId = (created.data.results as BulkRowResult[])[0]
          .product_id!;
        const child = (
          await database.read((db) =>
            db.select().from(variants).where(eq(variants.product_id, parentId)),
          )
        )[0];
        const parent = (
          await database.read((db) =>
            db.select().from(products).where(eq(products.id, parentId)),
          )
        )[0];
        const update = bulkCommand(
          [
            {
              row_number: 2,
              row_operation_id: randomUUID(),
              producto_id: parentId,
              sku_base: product.skuBase,
              product: {
                catalogVersion: Number(parent.catalog_version),
                nombre: 'Broker v2 updated',
              },
              variant_id: null,
              sku_variante: sku,
              variant: {
                catalogVersion: Number(child.catalog_version),
                imagenUrl: 'https://example.test/broker-updated',
              },
            },
          ],
          'ACTUALIZACION',
          2,
        );
        const original = canonicalBulk(update);
        await jointBroker.bulkCommand(update);
        const completed = await nextReply(update);
        expect(completed.schema_version).toBe(1);
        expect(completed.data.results).toMatchObject([
          { status: 'COMPLETED', code: null },
        ]);
        const replay = { ...update, message_id: randomUUID() };
        await jointBroker.bulkCommand(replay);
        expect((await nextReply(replay)).data.results).toEqual(
          completed.data.results,
        );
        expect(canonicalBulk(update)).toBe(original);
        const after = (
          await database.read((db) =>
            db.select().from(variants).where(eq(variants.id, child.id)),
          )
        )[0];
        expect(after.catalog_version).toBe(child.catalog_version + 1n);
        expect(await requested(parentId)).toHaveLength(2);
      } finally {
        await jointRuntime.onModuleDestroy();
        jointRuntime = undefined;
      }
    }, 60000);

    async function requested(productId: string) {
      return database.read((db) =>
        db
          .select()
          .from(outbox)
          .where(
            and(
              sql`${outbox.payload}->>'product_id' = ${productId}`,
              sql`${outbox.event_name} IN ('pricing.product.initialization.requested','inventory.sku.initialization.requested')`,
            ),
          ),
      );
    }
    function resultFor(row: typeof outbox.$inferSelect, rejected = false) {
      const pricing = row.event_name.startsWith('pricing.');
      return parseCatalogMessage({
        message_id: randomUUID(),
        schema_version: 1,
        occurred_at: new Date().toISOString(),
        correlation_id: row.correlation_id,
        operation_id: row.operation_id,
        causation_id: row.message_id,
        producer: pricing ? 'pricing-svc' : 'inventory-svc',
        kind: 'result',
        name: row.event_name.replace(
          'requested',
          rejected ? 'rejected' : 'completed',
        ),
        data: {
          product_id: row.payload.product_id,
          ...(pricing
            ? { sku_base: row.payload.sku_base }
            : {
                sku: row.payload.sku,
                variant_id: row.payload.variant_id ?? null,
              }),
          status: rejected ? 'REJECTED' : pricing ? 'READY' : 'INITIALIZED',
          completed_at: new Date().toISOString(),
          code: rejected ? 'FIXTURE_REJECTED' : null,
        },
      });
    }
    async function complete(
      productId: string,
      dependency?: 'pricing' | 'inventory',
    ) {
      const messages = new CatalogMessageService(database);
      for (const row of await requested(productId))
        if (!dependency || row.event_name.startsWith(dependency + '.'))
          await messages.consume(resultFor(row));
    }
    it.each([false, true])(
      'HTTP-50: all 18 operations with PostgreSQL TLS; restricted demo=%s (Taxonomy/results fixtures)',
      async (restrictedDemo) => {
        const http = new CatalogGatewayHarness();
        await http.start(
          persistenceSettings,
          { timeoutMs: 300000 },
          restrictedDemo,
        );
        try {
          const call = async (
            method: string,
            path: string,
            body: unknown,
            status: number,
            code?: string,
          ) => {
            const response = await http.call(
              method,
              path,
              body,
              restrictedDemo ? null : http.token(),
              restrictedDemo,
            );
            expect(
              response.status,
              method + ' ' + path + ': ' + JSON.stringify(response.body),
            ).toBe(status);
            expect(response.correlation).toBe(http.correlation);
            if (code) expect(response.body.code).toBe(code);
            return response.body as Record<string, unknown>;
          };
          const input = createRequest();
          input.nombre = 'HTTP-50-' + randomUUID();
          const product = await call('POST', '/productos', input, 201);
          const id = String(product.product_id),
            path = '/productos/' + id;
          expect(product).toMatchObject({
            status: 'BORRADOR',
            sku_base: input.skuBase,
            catalog_version: 0,
          });
          await call('POST', '/productos', input, 409, 'SKU_DUPLICADO');
          await call('POST', '/productos', {}, 400, 'VALIDACION');
          const updated = await call(
            'PATCH',
            path,
            {
              descripcion: 'HTTP update',
              catalogVersion: product.catalog_version,
            },
            200,
          );
          expect(Number(updated.catalog_version)).toBeGreaterThan(
            Number(product.catalog_version),
          );
          await call(
            'PATCH',
            path,
            { nombre: 'stale', catalogVersion: product.catalog_version },
            409,
            'VERSION_CONFLICT',
          );
          await call('POST', path + '/activar', {}, 422, 'DATOS_INCOMPLETOS');
          const prep = await call('GET', path + '/preparacion', undefined, 200);
          expect(prep.pricing).toMatchObject({
            status: 'PENDING',
            manual_retry_allowed: false,
          });
          await call(
            'POST',
            path + '/preparacion/reintentar',
            { dependencia: 'PRICING' },
            409,
            'PREPARACION_NO_REINTENTABLE',
          );
          // Explicit fixture of a confirmed, expired publication. No broker send or
          // completion is inferred from this timestamp; results are applied below.
          await transactions.run((tx) =>
            tx
              .update(outbox)
              .set({ published_at: new Date(Date.now() - 300001) })
              .where(
                and(
                  sql`${outbox.payload}->>'product_id' = ${id}`,
                  eq(
                    outbox.event_name,
                    'pricing.product.initialization.requested',
                  ),
                ),
              ),
          );
          const original = (await requested(id)).find((row) =>
            row.event_name.startsWith('pricing.'),
          )!;
          const accepted = await call(
            'POST',
            path + '/preparacion/reintentar',
            { dependencia: 'PRICING' },
            202,
          );
          expect(accepted).toMatchObject({
            operation_id: original.operation_id,
            status: 'ACCEPTED',
            correlation_id: http.correlation,
          });
          await call(
            'POST',
            path + '/preparacion/reintentar',
            { dependencia: 'PRICING' },
            409,
            'PREPARACION_NO_REINTENTABLE',
          );
          expect(
            (await requested(id)).filter((row) =>
              row.event_name.startsWith('pricing.'),
            ),
          ).toHaveLength(2);
          await complete(id);
          await call('POST', path + '/activar', {}, 200);
          const detail = await call('GET', path, undefined, 200);
          expect(detail).toMatchObject({
            product_id: id,
            sku_base: input.skuBase,
            marca: { marca_id: input.marcaId },
          });
          await call(
            'GET',
            '/productos/por-slug/' + product.slug,
            undefined,
            200,
          );
          const page = await call(
            'GET',
            '/productos?q=' +
              encodeURIComponent(input.nombre) +
              '&pagina=1&tamanio=1&estado=ACTIVO',
            undefined,
            200,
          );
          expect(page).toMatchObject({
            pagina: 1,
            tamanio: 1,
            total: 1,
            items: [{ product_id: id }],
          });
          await call(
            'GET',
            '/productos/' + randomUUID(),
            undefined,
            404,
            'PRODUCTO_NO_ENCONTRADO',
          );
          await call('POST', path + '/desactivar', {}, 200);
          await call('GET', path, undefined, 404, 'PRODUCTO_NO_ENCONTRADO');
          await call('POST', path + '/reactivar', {}, 200);

          const parent = await call(
            'POST',
            '/productos',
            createRequest(true),
            201,
          );
          const parentId = String(parent.product_id),
            parentPath = '/productos/' + parentId;
          const variantInput = {
            sku: '000-HTTP-50-' + randomUUID(),
            atributosIdentificadores: [
              {
                caracteristica_id: 'size',
                nombre: 'Size',
                valor_id: null,
                valor: 'M',
              },
            ],
            imagenUrl: 'https://example.test/variant.jpg',
            perfilFisico: fullProfile,
          };
          const child = await call(
            'POST',
            parentPath + '/variantes',
            variantInput,
            201,
          );
          const childPath = parentPath + '/variantes/' + child.variant_id;
          await call(
            'POST',
            parentPath + '/variantes',
            {
              ...variantInput,
              atributosIdentificadores: [
                { ...variantInput.atributosIdentificadores[0], valor: 'L' },
              ],
            },
            409,
            'SKU_DUPLICADO',
          );
          await call(
            'POST',
            parentPath + '/variantes',
            { ...variantInput, sku: randomUUID() },
            409,
            'COMBINACION_DUPLICADA',
          );
          const variantsPage = await call(
            'GET',
            parentPath + '/variantes?estado=BORRADOR&pagina=1&tamanio=1',
            undefined,
            200,
          );
          expect(variantsPage).toMatchObject({
            meta: { pagina: 1, tamanio: 1, total: 1, totalPaginas: 1 },
            items: [{ sku: variantInput.sku }],
          });
          await call('GET', childPath, undefined, 200);
          const edited = await call(
            'PATCH',
            childPath,
            {
              imagenUrl: 'https://example.test/updated.jpg',
              catalogVersion: child.catalog_version,
            },
            200,
          );
          expect(edited.sku).toBe(variantInput.sku);
          await call(
            'POST',
            childPath + '/activar',
            undefined,
            422,
            'DATOS_INCOMPLETOS',
          );
          await complete(parentId);
          await call('POST', childPath + '/activar', undefined, 200);
          await call('POST', parentPath + '/activar', {}, 200);
          await call('POST', childPath + '/desactivar', undefined, 200);
          expect(
            await database.read(
              async (db) =>
                (
                  await db
                    .select({ estado: products.estado })
                    .from(products)
                    .where(eq(products.id, parentId))
                )[0],
            ),
          ).toEqual({ estado: 'INACTIVO' });
          await call('POST', childPath + '/reactivar', undefined, 200);
          await call('POST', parentPath + '/reactivar', {}, 200);
          await call(
            'POST',
            childPath + '/preparacion/reintentar',
            undefined,
            409,
            'PREPARACION_NO_REINTENTABLE',
          );
          http.taxonomyAvailable = false;
          await call(
            'PATCH',
            path,
            { descripcion: 'must roll back' },
            503,
            'SERVICIO_NO_DISPONIBLE',
          );
          expect(
            await database.read(
              async (db) =>
                (
                  await db
                    .select({ description: products.descripcion })
                    .from(products)
                    .where(eq(products.id, id))
                )[0],
            ),
          ).toEqual({ description: 'HTTP update' });
        } finally {
          await http.close();
        }
      },
      120000,
    );
    it('Q-06: preserves historical NULL, corrects drafts with optimistic concurrency and never clears publication', async () => {
      const service = mutationService();
      const historical = '00000000-0000-4000-8000-000000000049';
      const read = async (id: string) =>
        database.read(
          async (db) =>
            (await db.select().from(products).where(eq(products.id, id)))[0]!,
        );
      expect((await read(historical)).publicado_alguna_vez).toBeNull();
      await expect(
        service.update(
          historical,
          undefined,
          { tipoProductoId: 'new', catalogVersion: 0 },
          actor,
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'CAMBIO_ESTRUCTURAL_NO_PERMITIDO' },
      });
      const product = await service.createProduct(
        {
          ...createRequest(),
          atributos: [
            {
              caracteristica_id: 'material',
              nombre: 'Material',
              valor_id: null,
              valor: 'cotton',
            },
          ],
        },
        actor,
      );
      expect((await read(product.product_id)).publicado_alguna_vez).toBe(false);
      await expect(
        service.state(product.product_id, undefined, 'activate', {}, actor),
      ).rejects.toMatchObject({ status: 422 });
      expect((await read(product.product_id)).publicado_alguna_vez).toBe(false);
      const corrected = await service.update(
        product.product_id,
        undefined,
        {
          tipoProductoId: 'corrected-type',
          catalogVersion: product.catalog_version,
        },
        actor,
      );
      expect(corrected).toMatchObject({
        product_id: product.product_id,
        sku_base: product.sku_base,
        slug: product.slug,
        tipo_producto_id: 'corrected-type',
        attributes: [{ valor: 'cotton' }],
      });
      const incompatibleService = mutationService(undefined, {
        attributes: async (type: string, values: Attribute[]) => {
          if (type.startsWith('incompatible-'))
            throw new HttpException(
              { code: 'ATRIBUTO_IDENTIFICADOR_INVALIDO' },
              422,
            );
          return values;
        },
      });
      const beforeIncompatible = await read(product.product_id);
      const incompatibleVersion = Number(beforeIncompatible.catalog_version);
      await expect(
        incompatibleService.update(
          product.product_id,
          undefined,
          {
            tipoProductoId: 'incompatible-persisted',
            catalogVersion: incompatibleVersion,
          },
          actor,
        ),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'VALIDACION' },
      });
      await expect(
        incompatibleService.update(
          product.product_id,
          undefined,
          {
            tipoProductoId: 'incompatible-supplied',
            catalogVersion: incompatibleVersion,
            atributos: [
              {
                caracteristica_id: 'material',
                nombre: 'Material',
                valor_id: null,
                valor: 'linen',
              },
            ],
          },
          actor,
        ),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'VALIDACION' },
      });
      expect(await read(product.product_id)).toMatchObject({
        tipo_producto_id: beforeIncompatible.tipo_producto_id,
        catalog_version: beforeIncompatible.catalog_version,
      });
      const inactiveTypeService = mutationService(undefined, {
        masters: async (value: { tipo_producto_id: string }) => {
          if (value.tipo_producto_id === 'inactive-type')
            throw new HttpException({ code: 'TIPO_PRODUCTO_INVALIDO' }, 422);
          return { schemaVersion: 1 };
        },
      });
      await expect(
        inactiveTypeService.update(
          product.product_id,
          undefined,
          {
            tipoProductoId: 'inactive-type',
            catalogVersion: incompatibleVersion,
          },
          actor,
        ),
      ).rejects.toMatchObject({
        status: 422,
        response: { code: 'TIPO_PRODUCTO_INVALIDO' },
      });
      const concurrent = await service.createProduct(createRequest(), actor);
      const concurrentUpdates = await Promise.allSettled([
        service.update(
          concurrent.product_id,
          undefined,
          { tipoProductoId: 'concurrent-type-a', catalogVersion: 0 },
          actor,
        ),
        service.update(
          concurrent.product_id,
          undefined,
          { tipoProductoId: 'concurrent-type-b', catalogVersion: 0 },
          actor,
        ),
      ]);
      expect(
        concurrentUpdates.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        concurrentUpdates.filter(
          (result) =>
            result.status === 'rejected' &&
            result.reason?.response?.code === 'VERSION_CONFLICT',
        ),
      ).toHaveLength(1);
      await expect(
        service.update(
          product.product_id,
          undefined,
          { tipoProductoId: 'other', catalogVersion: product.catalog_version },
          actor,
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'VERSION_CONFLICT' },
      });
      await complete(product.product_id);
      await service.state(product.product_id, undefined, 'activate', {}, actor);
      expect((await read(product.product_id)).publicado_alguna_vez).toBe(true);
      await service.state(
        product.product_id,
        undefined,
        'deactivate',
        {},
        actor,
      );
      expect((await read(product.product_id)).publicado_alguna_vez).toBe(true);
      await expect(
        transactions.run((tx) =>
          tx
            .update(products)
            .set({ publicado_alguna_vez: false })
            .where(eq(products.id, product.product_id)),
        ),
      ).rejects.toMatchObject({ failure: 'check' });
      await expect(
        service.update(
          product.product_id,
          undefined,
          {
            tipoProductoId: 'after-publication',
            catalogVersion: Number(
              (await read(product.product_id)).catalog_version,
            ),
          },
          actor,
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'CAMBIO_ESTRUCTURAL_NO_PERMITIDO' },
      });
      expect((await read(product.product_id)).tipo_producto_id).toBe(
        'corrected-type',
      );
    });
    function masterMessage(
      type: string,
      id: string,
      operation: string = randomUUID(),
      version = 7,
      name = 'taxonomy.master.deactivation.check.requested',
      extra: Record<string, unknown> = {},
      correlationId: string = randomUUID(),
    ) {
      return parseCatalogMessage({
        message_id: randomUUID(),
        schema_version: 1,
        occurred_at: new Date().toISOString(),
        correlation_id: correlationId,
        operation_id: operation,
        causation_id: randomUUID(),
        producer: 'taxonomy-svc',
        kind: name.endsWith('.requested')
          ? 'command'
          : name.endsWith('.rejected')
            ? 'result'
            : 'event',
        name,
        data: {
          entity_type: type,
          entity_id: id,
          version,
          ...(type === 'PRODUCT_TYPE_CHARACTERISTIC'
            ? {
                tipo_producto_id: 'legacy-fixture-type',
                caracteristica_id: 'legacy-fixture-char',
                ...(name === 'taxonomy.master.deactivated'
                  ? { schema_version_resultante: version + 1 }
                  : {}),
              }
            : {}),
          ...(name.endsWith('.rejected') ? { reason: 'TIMEOUT' } : {}),
          ...extra,
        },
      });
    }
    const masterTypes = [
      'CATEGORY',
      'BRAND',
      'PRODUCT_TYPE',
      'CHARACTERISTIC_VALUE',
      'PRODUCT_TYPE_CHARACTERISTIC',
    ];
    const masterEvents = [
      'taxonomy.master.deactivated',
      'taxonomy.master.deactivation.rejected',
      'taxonomy.master.deactivation.check.requested',
    ];
    async function masterState(operationId: string) {
      return database.read(async (db) => ({
        barriers: await db
          .select()
          .from(masterBarriers)
          .where(eq(masterBarriers.operation_id, operationId)),
        responses: await db
          .select()
          .from(outbox)
          .where(eq(outbox.operation_id, operationId)),
        products: await db.select().from(products).orderBy(products.id),
        checks: await db
          .select()
          .from(activationChecks)
          .orderBy(activationChecks.id),
      }));
    }
    async function expectUnprovenMasterMessage(
      request: CatalogEnvelope,
      received: CatalogEnvelope,
    ) {
      const telemetry = new CatalogTelemetry();
      const record = vi.spyOn(telemetry, 'record');
      const messages = new CatalogMessageService(database, telemetry);
      const before = await masterState(request.operation_id!);
      expect(before.barriers[0].is_blocking).toBe(true);
      expect(await messages.consume(received)).toBe('STALE');
      expect(await masterState(request.operation_id!)).toEqual(before);
      const stored = await database.read((db) =>
        db
          .select()
          .from(inbox)
          .where(eq(inbox.message_id, received.message_id)),
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        handler: 'catalog.master-barriers.v1',
        event_name: received.name,
        operation_id: request.operation_id,
        correlation_id: received.correlation_id,
        result: 'STALE',
      });
      expect(record).toHaveBeenCalledExactlyOnceWith(
        'MASTER_BARRIER_UNPROVEN_FINAL',
        { operationId: request.operation_id, messageId: received.message_id },
      );
      // Redelivery of the ignored envelope remains idempotent and cannot emit a response.
      expect(await messages.consume(received)).toBe('DUPLICATE');
      expect(await masterState(request.operation_id!)).toEqual(before);
    }
    describe.each(masterTypes)('correlación persistida de %s', (type) => {
      it.each(masterEvents)(
        '%s con otra correlación no modifica el negocio',
        async (name) => {
          const request = masterMessage(type, 'correlation-' + randomUUID());
          const messages = new CatalogMessageService(database);
          expect(await messages.consume(request)).toBe('APPLIED');
          const received = masterMessage(
            type,
            request.data.entity_id as string,
            request.operation_id!,
            7,
            name,
          );
          expect(received.correlation_id).not.toBe(request.correlation_id);
          await expectUnprovenMasterMessage(request, received);
          // An ignored envelope does not prevent a subsequent correctly correlated final.
          expect(
            await messages.consume({
              ...received,
              message_id: randomUUID(),
              correlation_id: request.correlation_id,
            }),
          ).toBe('APPLIED');
          expect(
            (await masterState(request.operation_id!)).barriers[0].is_blocking,
          ).toBe(name.endsWith('.check.requested'));
        },
      );
      it.each(masterEvents.slice(0, 2))(
        '%s conserva CLEAR, reintentos y duplicados válidos',
        async (name) => {
          const request = masterMessage(
            type,
            'valid-correlation-' + randomUUID(),
          );
          const messages = new CatalogMessageService(database);
          expect(await messages.consume(request)).toBe('APPLIED');
          const initial = await masterState(request.operation_id!);
          expect(initial.barriers[0].is_blocking).toBe(true);
          expect(initial.responses).toHaveLength(1);
          expect(initial.responses[0].payload.result).toBe('CLEAR');
          expect(await messages.consume(request)).toBe('DUPLICATE');
          expect(
            await messages.consume({ ...request, message_id: randomUUID() }),
          ).toBe('APPLIED');
          expect(await masterState(request.operation_id!)).toEqual(initial);
          const final = masterMessage(
            type,
            request.data.entity_id as string,
            request.operation_id!,
            7,
            name,
            {},
            request.correlation_id,
          );
          expect(await messages.consume(final)).toBe('APPLIED');
          const completed = await masterState(request.operation_id!);
          expect(completed.barriers[0]).toMatchObject({
            is_blocking: false,
            payload: { request, final },
          });
          expect(completed.responses).toEqual(initial.responses);
          expect(await messages.consume(final)).toBe('DUPLICATE');
          expect(
            await messages.consume({ ...final, message_id: randomUUID() }),
          ).toBe('TERMINAL');
          expect(
            await messages.consume({ ...request, message_id: randomUUID() }),
          ).toBe('TERMINAL');
          // Correlation is also required once the barrier has already been released.
          for (const message of [request, final]) {
            expect(
              await messages.consume({
                ...message,
                message_id: randomUUID(),
                correlation_id: randomUUID(),
              }),
            ).toBe('STALE');
          }
          expect(await masterState(request.operation_id!)).toEqual(completed);
        },
      );
    });
    describe.each([
      ['sin solicitud', undefined],
      ['solicitud nula', null],
      ['solicitud escalar', 'invalid-request'],
      ['solicitud array', []],
      ['sin correlación', {}],
      ['correlación nula', { correlation_id: null }],
      ['correlación vacía', { correlation_id: '' }],
      ['correlación de otro tipo', { correlation_id: 7 }],
    ])('barrera con %s', (_label, storedRequest) => {
      it.each(masterEvents)(
        '%s no es verificable y permanece STALE',
        async (name) => {
          const request = masterMessage(
            'CATEGORY',
            'legacy-correlation-' + randomUUID(),
          );
          const messages = new CatalogMessageService(database);
          expect(await messages.consume(request)).toBe('APPLIED');
          await transactions.run((tx) =>
            tx
              .update(masterBarriers)
              .set({ payload: { request: storedRequest, result: 'CLEAR' } })
              .where(eq(masterBarriers.operation_id, request.operation_id!)),
          );
          await expectUnprovenMasterMessage(
            request,
            masterMessage(
              'CATEGORY',
              request.data.entity_id as string,
              request.operation_id!,
              7,
              name,
              {},
              request.correlation_id,
            ),
          );
        },
      );
    });
    function cleanupMasterBarrier(operationId: string) {
      if (!UUID.test(operationId))
        throw new Error('Invalid isolated fixture operation');
      command(
        'docker',
        [
          'exec',
          '-i',
          container,
          'psql',
          '-U',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
        ],
        `SET ROLE po_catalog_owner; DELETE FROM catalog.master_barriers WHERE operation_id='${operationId}'::uuid;`,
      );
    }
    it('master barriers: CLEAR/IN_USE for four entities, durable dedupe, stale finals and matching rejection release', async () => {
      const service = mutationService(),
        messages = new CatalogMessageService(database);
      const marker = 'master-' + randomUUID();
      const product = await service.createProduct(
        {
          ...createRequest(),
          categoriaId: marker,
          marcaId: marker,
          tipoProductoId: marker,
          atributos: [
            {
              caracteristica_id: 'char',
              nombre: 'Value',
              valor_id: marker,
              valor: 'value',
            },
          ],
        },
        actor,
      );
      await complete(product.product_id);
      await service.state(product.product_id, undefined, 'activate', {}, actor);
      for (const type of [
        'CATEGORY',
        'BRAND',
        'PRODUCT_TYPE',
        'CHARACTERISTIC_VALUE',
      ]) {
        const command = masterMessage(type, marker);
        expect(
          await Promise.all([
            messages.consume(command),
            messages.consume(command),
          ]).then((results) => results.sort()),
        ).toEqual(['APPLIED', 'DUPLICATE']);
        await expect(
          messages.consume({
            ...command,
            data: { ...command.data, version: 8 },
          }),
        ).rejects.toThrow('INVALID_CATALOG_MESSAGE');
        const responses = await database.read((db) =>
          db
            .select()
            .from(outbox)
            .where(eq(outbox.operation_id, command.operation_id!)),
        );
        expect(responses).toHaveLength(1);
        expect(responses[0]).toMatchObject({
          event_name: 'catalog.master.deactivation.checked',
          kind: 'result',
          correlation_id: command.correlation_id,
          causation_id: command.message_id,
          operation_id: command.operation_id,
        });
        expect(responses[0].payload).toMatchObject({
          entity_type: type,
          entity_id: marker,
          version: 7,
          result: 'IN_USE',
        });
        await messages.consume({ ...command, message_id: randomUUID() });
        expect(
          await database.read((db) =>
            db
              .select()
              .from(outbox)
              .where(eq(outbox.operation_id, command.operation_id!)),
          ),
        ).toHaveLength(1);
        expect(
          await messages.consume(
            masterMessage(
              type,
              marker,
              command.operation_id!,
              8,
              'taxonomy.master.deactivated',
              {},
              command.correlation_id,
            ),
          ),
        ).toBe('STALE');
        expect(await messages.consume(masterMessage(type, marker))).toBe(
          'STALE',
        );
        const barrier = async () =>
          database.read(
            async (db) =>
              (
                await db
                  .select()
                  .from(masterBarriers)
                  .where(eq(masterBarriers.operation_id, command.operation_id!))
              )[0],
          );
        expect((await barrier())!.is_blocking).toBe(true);
        await service.update(
          product.product_id,
          undefined,
          { nombre: 'Independent edit' },
          actor,
        );
        await messages.consume(
          masterMessage(
            type,
            marker,
            command.operation_id!,
            7,
            'taxonomy.master.deactivation.rejected',
            {},
            command.correlation_id,
          ),
        );
        expect((await barrier())!.is_blocking).toBe(false);
        expect(
          await messages.consume({ ...command, message_id: randomUUID() }),
        ).toBe('TERMINAL');
        const clear = masterMessage(type, 'unreferenced-' + randomUUID());
        await messages.consume(clear);
        const [response] = await database.read((db) =>
          db
            .select()
            .from(outbox)
            .where(eq(outbox.operation_id, clear.operation_id!)),
        );
        expect(response.payload.result).toBe('CLEAR');
        const [pending] = await database.read((db) =>
          db
            .select()
            .from(masterBarriers)
            .where(eq(masterBarriers.operation_id, clear.operation_id!)),
        );
        expect(pending.is_blocking).toBe(true);
        await messages.consume(
          masterMessage(
            type,
            clear.data.entity_id as string,
            clear.operation_id!,
            7,
            'taxonomy.master.deactivated',
            {},
            clear.correlation_id,
          ),
        );
      }
    });
    it('master barriers: active variant values block even with a draft parent; inactive references do not', async () => {
      const service = mutationService(),
        messages = new CatalogMessageService(database),
        marker = 'value-' + randomUUID();
      const parent = await service.createProduct(createRequest(true), actor);
      const variant = await service.createVariant(
        parent.product_id,
        {
          sku: '000-' + marker,
          atributosIdentificadores: [
            {
              caracteristica_id: 'size',
              nombre: 'Size',
              valor_id: marker,
              valor: 'M',
            },
          ],
          imagenUrl: 'https://example.test/variant',
          perfilFisico: fullProfile,
        },
        actor,
      );
      await complete(parent.product_id);
      await service.state(
        parent.product_id,
        variant.variant_id,
        'activate',
        {},
        actor,
      );
      const check = masterMessage('CHARACTERISTIC_VALUE', marker);
      await messages.consume(check);
      const [response] = await database.read((db) =>
        db
          .select()
          .from(outbox)
          .where(eq(outbox.operation_id, check.operation_id!)),
      );
      expect(response.payload.result).toBe('IN_USE');
      await messages.consume(
        masterMessage(
          'CHARACTERISTIC_VALUE',
          marker,
          check.operation_id!,
          7,
          'taxonomy.master.deactivation.rejected',
          {},
          check.correlation_id,
        ),
      );
      await service.state(
        parent.product_id,
        variant.variant_id,
        'deactivate',
        {},
        actor,
      );
      const clear = masterMessage('CHARACTERISTIC_VALUE', marker);
      await messages.consume(clear);
      const [unused] = await database.read((db) =>
        db
          .select()
          .from(outbox)
          .where(eq(outbox.operation_id, clear.operation_id!)),
      );
      expect(unused.payload.result).toBe('CLEAR');
      await expect(
        service.state(
          parent.product_id,
          variant.variant_id,
          'reactivate',
          {},
          actor,
        ),
      ).rejects.toMatchObject({ status: 503 });
      await messages.consume(
        masterMessage(
          'CHARACTERISTIC_VALUE',
          marker,
          clear.operation_id!,
          7,
          'taxonomy.master.deactivated',
          {},
          clear.correlation_id,
        ),
      );
    });
    it('master barrier advisory locks serialize activation before the check and prevent new writes after CLEAR', async () => {
      const service = mutationService(),
        messages = new CatalogMessageService(database),
        marker = 'race-' + randomUUID();
      const product = await service.createProduct(
        { ...createRequest(), categoriaId: marker },
        actor,
      );
      await complete(product.product_id);
      let release!: () => void, locked!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve)),
        ready = new Promise<void>((resolve) => (locked = resolve));
      const writer = transactions.run(async (tx) => {
        await assertMasterReferences(tx, [{ type: 'CATEGORY', id: marker }]);
        locked();
        await gate;
        await tx
          .update(products)
          .set({ estado: 'ACTIVO' })
          .where(eq(products.id, product.product_id));
      });
      await ready;
      const check = masterMessage('CATEGORY', marker),
        checkResult = messages.consume(check);
      release();
      await writer;
      await checkResult;
      const [response] = await database.read((db) =>
        db
          .select()
          .from(outbox)
          .where(eq(outbox.operation_id, check.operation_id!)),
      );
      expect(response.payload.result).toBe('IN_USE');
      await messages.consume(
        masterMessage(
          'CATEGORY',
          marker,
          check.operation_id!,
          7,
          'taxonomy.master.deactivation.rejected',
          {},
          check.correlation_id,
        ),
      );
      const blocked = 'blocked-' + randomUUID(),
        command = masterMessage('CATEGORY', blocked);
      let releaseBarrier!: () => void, barrierReady!: () => void;
      const barrierGate = new Promise<void>(
          (resolve) => (releaseBarrier = resolve),
        ),
        installed = new Promise<void>((resolve) => (barrierReady = resolve));
      const install = transactions.run(async (tx) => {
        await lockMasterReferences(tx, [{ type: 'CATEGORY', id: blocked }]);
        await tx.insert(masterBarriers).values({
          master_type: 'CATEGORY',
          master_id: blocked,
          operation_id: command.operation_id!,
          source_version: 7n,
          payload: { request: command },
        });
        barrierReady();
        await barrierGate;
      });
      await installed;
      const pending = service.createProduct(
        { ...createRequest(), categoriaId: blocked },
        actor,
      );
      const rejection = expect(pending).rejects.toMatchObject({ status: 503 });
      releaseBarrier();
      await install;
      await rejection;
      await messages.consume(
        masterMessage(
          'CATEGORY',
          blocked,
          command.operation_id!,
          7,
          'taxonomy.master.deactivated',
          {},
          command.correlation_id,
        ),
      );
    });
    it('unresolved PRODUCT_TYPE_CHARACTERISTIC stays blocking, emits no CLEAR and cannot be released by a final event', async () => {
      const messages = new CatalogMessageService(database),
        service = mutationService();
      const product = await service.createProduct(createRequest(), actor);
      const command = masterMessage(
        'PRODUCT_TYPE_CHARACTERISTIC',
        'opaque-association-' + randomUUID(),
      );
      try {
        await transactions.run((tx) =>
          tx.insert(masterBarriers).values({
            master_type: 'PRODUCT_TYPE_CHARACTERISTIC',
            master_id: command.data.entity_id as string,
            operation_id: command.operation_id!,
            source_version: 7n,
            payload: {
              request: {
                ...command,
                data: {
                  entity_type: command.data.entity_type,
                  entity_id: command.data.entity_id,
                  version: 7,
                },
              },
              unresolved_association: true,
            },
          }),
        );
        expect(await messages.consume(command)).toBe('STALE');
        expect(
          await database.read((db) =>
            db
              .select()
              .from(outbox)
              .where(eq(outbox.operation_id, command.operation_id!)),
          ),
        ).toEqual([]);
        expect(
          await messages.consume(
            masterMessage(
              'PRODUCT_TYPE_CHARACTERISTIC',
              command.data.entity_id as string,
              command.operation_id!,
              7,
              'taxonomy.master.deactivated',
              {},
              command.correlation_id,
            ),
          ),
        ).toBe('STALE');
        const [barrier] = await database.read((db) =>
          db
            .select()
            .from(masterBarriers)
            .where(eq(masterBarriers.operation_id, command.operation_id!)),
        );
        expect(barrier.is_blocking).toBe(true);
        await expect(
          service.createProduct(createRequest(), actor),
        ).rejects.toMatchObject({ status: 503 });
        await service.update(
          product.product_id,
          undefined,
          { nombre: 'Independent' },
          actor,
        );
      } finally {
        // Only this test's unresolved fixture, on the disposable database.
        cleanupMasterBarrier(command.operation_id!);
      }
    });
    it('approved association coordinates scope barriers and preserve the captured aggregate version through finalization', async () => {
      const service = mutationService(),
        messages = new CatalogMessageService(database);
      const type = 'association-type-' + randomUUID(),
        characteristic = 'association-char-' + randomUUID();
      const coords = {
        tipo_producto_id: type,
        caracteristica_id: characteristic,
      };
      const product = await service.createProduct(
        {
          ...createRequest(),
          tipoProductoId: type,
          atributos: [
            {
              caracteristica_id: characteristic,
              nombre: 'Attribute',
              valor_id: null,
              valor: 'value',
            },
          ],
        },
        actor,
      );
      // Draft use alone is clear, but activation and introducing this reference must wait for the final.
      const check = masterMessage(
        'PRODUCT_TYPE_CHARACTERISTIC',
        'association-' + randomUUID(),
        randomUUID(),
        7,
        'taxonomy.master.deactivation.check.requested',
        coords,
      );
      try {
        expect(await messages.consume(check)).toBe('APPLIED');
        const [response] = await database.read((db) =>
          db
            .select()
            .from(outbox)
            .where(eq(outbox.operation_id, check.operation_id!)),
        );
        expect(response.payload).toMatchObject({
          ...coords,
          result: 'CLEAR',
          version: 7,
        });
        await complete(product.product_id);
        await expect(
          service.state(product.product_id, undefined, 'activate', {}, actor),
        ).rejects.toMatchObject({ status: 503 });
        await expect(
          service.createProduct(
            {
              ...createRequest(),
              tipoProductoId: type,
              atributos: [
                {
                  caracteristica_id: characteristic,
                  nombre: 'Attribute',
                  valor_id: null,
                  valor: 'new',
                },
              ],
            },
            actor,
          ),
        ).rejects.toMatchObject({ status: 503 });
        await service.createProduct(
          {
            ...createRequest(),
            tipoProductoId: type,
            atributos: [
              {
                caracteristica_id: 'independent',
                nombre: 'Other',
                valor_id: null,
                valor: 'value',
              },
            ],
          },
          actor,
        );
        await service.createProduct(
          {
            ...createRequest(),
            tipoProductoId: 'other-type',
            atributos: [
              {
                caracteristica_id: characteristic,
                nombre: 'Attribute',
                valor_id: null,
                valor: 'value',
              },
            ],
          },
          actor,
        );
        const mismatched = masterMessage(
          'PRODUCT_TYPE_CHARACTERISTIC',
          check.data.entity_id as string,
          check.operation_id!,
          7,
          'taxonomy.master.deactivated',
          {
            ...coords,
            caracteristica_id: 'different',
            schema_version_resultante: 9,
          },
          check.correlation_id,
        );
        expect(await messages.consume(mismatched)).toBe('STALE');
        expect(
          await messages.consume({
            ...check,
            message_id: randomUUID(),
            data: { ...check.data, caracteristica_id: 'different' },
          }),
        ).toBe('STALE');
        const final = masterMessage(
          'PRODUCT_TYPE_CHARACTERISTIC',
          check.data.entity_id as string,
          check.operation_id!,
          7,
          'taxonomy.master.deactivated',
          { ...coords, schema_version_resultante: 9 },
          check.correlation_id,
        );
        expect(await messages.consume(final)).toBe('APPLIED');
        const [barrier] = await database.read((db) =>
          db
            .select()
            .from(masterBarriers)
            .where(eq(masterBarriers.operation_id, check.operation_id!)),
        );
        expect(barrier).toMatchObject({
          is_blocking: false,
          source_version: 7n,
        });
        expect(barrier.payload).toMatchObject({
          request: { data: coords },
          final: { data: { version: 7, schema_version_resultante: 9 } },
        });
        expect(
          await messages.consume({ ...check, message_id: randomUUID() }),
        ).toBe('TERMINAL');
        await service.state(
          product.product_id,
          undefined,
          'activate',
          {},
          actor,
        );
        const active = masterMessage(
          'PRODUCT_TYPE_CHARACTERISTIC',
          check.data.entity_id as string,
          randomUUID(),
          9,
          'taxonomy.master.deactivation.check.requested',
          coords,
        );
        await messages.consume(active);
        const [inUse] = await database.read((db) =>
          db
            .select()
            .from(outbox)
            .where(eq(outbox.operation_id, active.operation_id!)),
        );
        expect(inUse.payload.result).toBe('IN_USE');
        await messages.consume(
          masterMessage(
            'PRODUCT_TYPE_CHARACTERISTIC',
            active.data.entity_id as string,
            active.operation_id!,
            9,
            'taxonomy.master.deactivation.rejected',
            coords,
            active.correlation_id,
          ),
        );
      } finally {
        cleanupMasterBarrier(check.operation_id!);
      }
    });
    it('association usage includes an active child of a draft parent and does not block on inactive identifying references alone', async () => {
      const service = mutationService(),
        messages = new CatalogMessageService(database),
        type = 'variant-assoc-' + randomUUID();
      const parent = await service.createProduct(
        { ...createRequest(true), tipoProductoId: type },
        actor,
      );
      const child = await service.createVariant(
        parent.product_id,
        {
          sku: '000-' + randomUUID(),
          atributosIdentificadores: [
            {
              caracteristica_id: 'size',
              nombre: 'Size',
              valor_id: 'M',
              valor: 'M',
            },
          ],
          imagenUrl: 'https://example.test/variant',
          perfilFisico: fullProfile,
        },
        actor,
      );
      await complete(parent.product_id);
      await service.state(
        parent.product_id,
        child.variant_id,
        'activate',
        {},
        actor,
      );
      const coords = { tipo_producto_id: type, caracteristica_id: 'size' };
      const check = masterMessage(
        'PRODUCT_TYPE_CHARACTERISTIC',
        'variant-association-' + randomUUID(),
        randomUUID(),
        7,
        'taxonomy.master.deactivation.check.requested',
        coords,
      );
      await messages.consume(check);
      const [response] = await database.read((db) =>
        db
          .select()
          .from(outbox)
          .where(eq(outbox.operation_id, check.operation_id!)),
      );
      expect(response.payload.result).toBe('IN_USE');
      await service.state(
        parent.product_id,
        child.variant_id,
        'deactivate',
        {},
        actor,
      );
      await messages.consume(
        masterMessage(
          'PRODUCT_TYPE_CHARACTERISTIC',
          check.data.entity_id as string,
          check.operation_id!,
          7,
          'taxonomy.master.deactivation.rejected',
          coords,
          check.correlation_id,
        ),
      );
      const clear = masterMessage(
        'PRODUCT_TYPE_CHARACTERISTIC',
        check.data.entity_id as string,
        randomUUID(),
        7,
        'taxonomy.master.deactivation.check.requested',
        coords,
      );
      await messages.consume(clear);
      const [unused] = await database.read((db) =>
        db
          .select()
          .from(outbox)
          .where(eq(outbox.operation_id, clear.operation_id!)),
      );
      expect(unused.payload.result).toBe('CLEAR');
      await expect(
        service.state(
          parent.product_id,
          child.variant_id,
          'reactivate',
          {},
          actor,
        ),
      ).rejects.toMatchObject({ status: 503 });
      await messages.consume(
        masterMessage(
          'PRODUCT_TYPE_CHARACTERISTIC',
          clear.data.entity_id as string,
          clear.operation_id!,
          7,
          'taxonomy.master.deactivated',
          { ...coords, schema_version_resultante: 8 },
          clear.correlation_id,
        ),
      );
    });
    it('PERF-49-COMMERCIAL: hydrates SQL pages with four SELECT and unchanged detail projections', async () => {
      const service = mutationService();
      const marker = 'commercial-perf-' + randomUUID();
      const reads = new PostgresCatalogRepository(database);
      const expected: ProductSummary[] = [];
      for (let i = 0; i < 30; i++) {
        const product = await service.createProduct(
          {
            ...createRequest(),
            nombre: marker + '-' + String(Math.floor(i / 2)).padStart(2, '0'),
            categoriaId: i % 2 ? marker : marker + '-other',
            marcaId: i % 3 ? marker : marker + '-other',
            imagenes: [
              { url: 'https://placehold.co/legacy.png', principal: false },
              { url: 'https://example.test/repeated.png', principal: false },
              { url: 'https://example.test/repeated.png', principal: true },
            ],
            atributos: [
              {
                caracteristica_id: 'z',
                nombre: 'Z',
                valor_id: null,
                valor: { nested: [i, false] },
              },
              {
                caracteristica_id: 'a',
                nombre: 'A',
                valor_id: '0001',
                valor: 'Cotton',
              },
            ],
          },
          actor,
        );
        await complete(product.product_id);
        await service.state(
          product.product_id,
          undefined,
          'activate',
          {},
          actor,
        );
        const detail = await reads.findCandidateByProductId(
          product.product_id,
          'MARKETPLACE',
        );
        expect(detail).not.toBeNull();
        const { variants: _children, ...summary } = detail!;
        expected.push(summary);
      }
      let selects = 0;
      const counted = {
        read: <T>(work: (connection: CatalogDatabase) => Promise<T>) =>
          database.read((db) =>
            work(
              new Proxy(db, {
                get(target, key, receiver) {
                  if (key === 'transaction')
                    return (
                      callback: (tx: CatalogTransaction) => Promise<T>,
                      config: Parameters<CatalogDatabase['transaction']>[1],
                    ) =>
                      target.transaction(
                        (tx) =>
                          callback(
                            new Proxy(tx, {
                              get(t, k, r) {
                                const member = Reflect.get(t, k, r);
                                if (k === 'select')
                                  return (...args: unknown[]) => {
                                    selects++;
                                    return Reflect.apply(member, t, args);
                                  };
                                return typeof member === 'function'
                                  ? member.bind(t)
                                  : member;
                              },
                            }),
                          ),
                        config,
                      );
                  return Reflect.get(target, key, receiver);
                },
              }),
            ),
          ),
      } as Database;
      const batched = new PostgresCatalogRepository(counted);
      for (const tamanio of [4, 24])
        for (const pagina of [1, 2, 9])
          for (const orden of ['NOMBRE_ASC', 'NOMBRE_DESC'] as const)
            for (const filter of [
              {},
              { categoriaId: marker },
              { marcaId: marker },
              { categoriaId: marker, marcaId: marker },
            ]) {
              const ordered = expected
                .filter(
                  (p) =>
                    (!('categoriaId' in filter) ||
                      p.categoria_id === filter.categoriaId) &&
                    (!('marcaId' in filter) || p.marca_id === filter.marcaId),
                )
                .sort((a, b) => {
                  const byName = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
                  return (
                    (orden === 'NOMBRE_DESC' ? -byName : byName) ||
                    (a.product_id < b.product_id ? -1 : 1)
                  );
                });
              selects = 0;
              const page = await batched.listCandidates({
                canal: 'MARKETPLACE',
                q: marker,
                tamanio,
                pagina,
                orden,
                ...filter,
              });
              expect(page).toEqual({
                items: ordered.slice((pagina - 1) * tamanio, pagina * tamanio),
                total: ordered.length,
                tamanio,
                pagina,
              });
              expect(selects).toBe(page.items.length ? 4 : 2);
            }
      const restricted = expected.slice(0, 2);
      const page = await batched.listCandidates(
        {
          canal: 'MARKETPLACE',
          q: marker,
          tamanio: 24,
          pagina: 1,
          orden: 'NOMBRE_ASC',
        },
        false,
        restricted.map((p) => p.product_id),
      );
      expect(page.total).toBe(2);
      expect(new Set(page.items.map((p) => p.product_id))).toEqual(
        new Set(restricted.map((p) => p.product_id)),
      );
      process.stdout.write(
        JSON.stringify({
          evidence: 'PERF-49-COMMERCIAL',
          products: 30,
          cases: 48,
          selectCountNonempty: 4,
          selectCountEmpty: 2,
          projection: 'matches-unchanged-detail-reader',
        }) + '\n',
      );
    }, 30000);

    it('D-CAT-05/06: filters global eligibility before count/pagination in every channel without candidate tables', async () => {
      const service = mutationService();
      const marker = 'eligibility-' + randomUUID();
      const visible: string[] = [];
      const hidden: { product_id: string; slug: string }[] = [];
      // Identical names exercise the deterministic product-id tie breaker.
      for (const state of [
        'ACTIVO',
        'BORRADOR',
        'INACTIVO',
        'ACTIVO',
      ] as const) {
        const product = await service.createProduct(
          { ...createRequest(), nombre: marker },
          actor,
        );
        if (state !== 'BORRADOR') {
          await complete(product.product_id);
          await service.state(
            product.product_id,
            undefined,
            'activate',
            {},
            actor,
          );
        }
        if (state === 'INACTIVO')
          await service.state(
            product.product_id,
            undefined,
            'deactivate',
            {},
            actor,
          );
        if (state === 'ACTIVO') visible.push(product.product_id);
        else hidden.push(product);
      }
      const reads = new PostgresCatalogRepository(database);
      visible.sort();
      const intentsBefore = await database.read((db) =>
        db.select().from(outbox),
      );
      for (const canal of [
        'MARKETPLACE',
        'CHATBOT',
        'RETAIL',
        'VENTAS',
      ] as const) {
        const query = {
          canal,
          q: marker,
          pagina: 1,
          tamanio: 1,
          orden: 'NOMBRE_ASC' as const,
        };
        for (const pagina of [1, 2, 3]) {
          const page = await reads.listCandidates({ ...query, pagina });
          expect(page.total).toBe(2);
          expect(page.items.map((p) => p.product_id)).toEqual(
            pagina <= 2 ? [visible[pagina - 1]] : [],
          );
        }
        for (const product of hidden) {
          expect(
            await reads.findCandidateBySlug(product.slug, canal),
          ).toBeNull();
          expect(
            await reads.findCandidateByProductId(product.product_id, canal),
          ).toBeNull();
        }
        const simple = await reads.findCandidateByProductId(visible[0], canal);
        expect(simple).toMatchObject({ tiene_variantes: false, variants: [] });
        expect(await reads.findCandidateBySlug(simple!.slug, canal)).toEqual(
          simple,
        );
        expect(
          await reads.listCandidates({ ...query, q: 'missing-' + marker }),
        ).toMatchObject({ items: [], total: 0 });
        for (const estado of ['BORRADOR', 'INACTIVO'] as const)
          expect(
            await reads.listCandidates({ ...query, estado }),
          ).toMatchObject({ total: 1 });
      }
      expect(await database.read((db) => db.select().from(outbox))).toEqual(
        intentsBefore,
      );
    });
    it('D-CAT-01..04: persists multiple exact codes, rejects concurrent/history reuse and preserves retirement audit', async () => {
      const service = mutationService();
      const simple = await service.createProduct(createRequest(), actor);
      const other = await service.createProduct(createRequest(), actor);
      const barcode = new BarcodeRepository(database);
      const code = '000-Barcode-' + randomUUID();
      await barcode.register(code, simple.sku_base, 'registered-actor');
      await barcode.register(
        ' ' + code + ' ',
        simple.sku_base,
        'registered-actor',
      );
      expect(await barcode.resolve(code)).toBeNull();
      const reads = new PostgresCatalogRepository(database);
      expect(await reads.skuContext(simple.sku_base)).toMatchObject({
        productId: simple.product_id,
        active: false,
        eligible: false,
        isVariant: false,
      });
      await complete(simple.product_id);
      await service.state(simple.product_id, undefined, 'activate', {}, actor);
      expect(await barcode.resolve(code)).toBe(simple.sku_base);
      expect(await reads.skuContext(simple.sku_base)).toMatchObject({
        active: true,
        eligible: true,
      });
      expect(await barcode.resolve(' ' + code + ' ')).toBe(simple.sku_base);
      expect(await barcode.resolve(code.toLowerCase())).toBeNull();
      const duplicate = 'concurrent-' + randomUUID();
      const results = await Promise.allSettled([
        barcode.register(duplicate, simple.sku_base, 'actor-a'),
        barcode.register(duplicate, other.sku_base, 'actor-b'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { code: 'BARCODE_ALREADY_REGISTERED' },
      });
      const retired = await barcode.retire(code, 'retired-actor');
      expect(retired).toMatchObject({
        created_by: 'registered-actor',
        retired_by: 'retired-actor',
      });
      expect(await barcode.retire(code, 'another-actor')).toEqual(retired);
      expect(await barcode.resolve(code)).toBeNull();
      await expect(
        barcode.register(code, other.sku_base, 'actor'),
      ).rejects.toMatchObject({ code: 'BARCODE_ALREADY_REGISTERED' });
      await expect(
        database.transaction((tx) =>
          tx.execute(
            sql`UPDATE catalog.sku_barcodes SET retired_at = NULL, retired_by = NULL WHERE codigo_barras = ${code}`,
          ),
        ),
      ).rejects.toMatchObject({ failure: 'check' });
      await service.state(
        simple.product_id,
        undefined,
        'deactivate',
        {},
        actor,
      );
      expect(await barcode.resolve(' ' + code + ' ')).toBeNull();
      await service.state(
        simple.product_id,
        undefined,
        'reactivate',
        {},
        actor,
      );
      expect(await barcode.resolve(' ' + code + ' ')).toBe(simple.sku_base);
      expect(await barcode.resolve(code)).toBeNull();
      expect(
        (await barcode.list(simple.sku_base)).find(
          (r) => r.codigo_barras === code,
        ),
      ).toEqual(retired);
      await expect(
        barcode.register('unknown-' + code, 'nonexistent-sku', 'actor'),
      ).rejects.toMatchObject({ code: 'SKU_NOT_SELLABLE' });
      await expect(
        database.transaction((tx) =>
          tx.execute(
            sql`UPDATE catalog.sku_barcodes SET codigo_barras = ${'new'} WHERE codigo_barras = ${code}`,
          ),
        ),
      ).rejects.toMatchObject({ sqlState: '42501' });
      await expect(
        database.transaction((tx) =>
          tx.execute(
            sql`DELETE FROM catalog.sku_barcodes WHERE codigo_barras = ${code}`,
          ),
        ),
      ).rejects.toMatchObject({ sqlState: '42501' });
      const ownerMutation = `SET ROLE po_catalog_owner; UPDATE catalog.sku_barcodes SET sku_identity_id = (SELECT id FROM catalog.sku_identity WHERE sku = '${other.sku_base}') WHERE codigo_barras = '${code}';`;
      expect(() =>
        command(
          'docker',
          [
            'exec',
            '-i',
            container,
            'psql',
            '-U',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
          ],
          ownerMutation,
        ),
      ).toThrow();
      expect(
        (await barcode.list(simple.sku_base)).find(
          (r) => r.codigo_barras === code,
        ),
      ).toEqual(retired);
    });

    it('D-CAT-01..04/PF: variant identity and eligibility exclude parent base and inactive children before monetary pagination', async () => {
      const service = mutationService();
      const marker = 'price-' + randomUUID();
      const parent = await service.createProduct(
        { ...createRequest(true), nombre: marker },
        actor,
      );
      const barcode = new BarcodeRepository(database);
      await expect(
        barcode.register('base-' + randomUUID(), parent.sku_base, 'actor'),
      ).rejects.toMatchObject({ code: 'SKU_NOT_SELLABLE' });
      const children = [];
      for (const size of ['one', 'two'])
        children.push(
          await service.createVariant(
            parent.product_id,
            {
              sku: 'PF-' + randomUUID(),
              atributosIdentificadores: [
                {
                  caracteristica_id: 'size',
                  nombre: 'Size',
                  valor_id: size,
                  valor: size,
                },
              ],
              imagenUrl: 'https://example.test/variant',
              perfilFisico: fullProfile,
            },
            actor,
          ),
        );
      const [active, draft] = children;
      const code = '000-variant-' + randomUUID();
      await barcode.register(code, active.sku, 'actor');
      await complete(parent.product_id);
      await service.state(
        parent.product_id,
        active.variant_id,
        'activate',
        undefined,
        actor,
      );
      expect(await barcode.resolve(code)).toBeNull();
      const reads = new PostgresCatalogRepository(database);
      expect(await reads.skuContext(active.sku)).toMatchObject({
        active: true,
        eligible: false,
      });
      await service.state(parent.product_id, undefined, 'activate', {}, actor);
      expect(await barcode.resolve(code)).toBe(active.sku);
      const query = {
        canal: 'RETAIL' as const,
        q: marker,
        pagina: 1,
        tamanio: 1,
        orden: 'NOMBRE_ASC' as const,
      };
      expect(await reads.skuContext(parent.sku_base)).toMatchObject({
        productId: parent.product_id,
        isVariant: false,
        active: true,
        eligible: false,
      });
      expect(await reads.skuContext('missing-' + randomUUID())).toBeNull();
      expect(await reads.skuContext(active.sku)).toMatchObject({
        productId: parent.product_id,
        isVariant: true,
        active: true,
        eligible: true,
      });
      expect(await reads.skuContext(draft.sku)).toMatchObject({
        active: false,
        eligible: false,
      });
      expect(await reads.priceCandidates(query)).toEqual([
        { productId: parent.product_id, sku: active.sku },
      ]);
      expect(
        await reads.listCandidates(query, false, [parent.product_id]),
      ).toMatchObject({ total: 1, items: [{ product_id: parent.product_id }] });
      expect(
        await reads.listCandidates({ ...query, pagina: 2 }, false, [
          parent.product_id,
        ]),
      ).toMatchObject({ total: 1, items: [] });
      expect(await reads.listCandidates(query, false, [])).toMatchObject({
        total: 0,
        items: [],
      });
      expect(await reads.priceCandidates(query)).not.toContainEqual({
        productId: parent.product_id,
        sku: draft.sku,
      });
      await service.state(
        parent.product_id,
        active.variant_id,
        'deactivate',
        undefined,
        actor,
      );
      expect(await barcode.resolve(code)).toBeNull();
      await service.state(
        parent.product_id,
        active.variant_id,
        'reactivate',
        undefined,
        actor,
      );
      expect(await barcode.resolve(code)).toBeNull();
      await service.state(
        parent.product_id,
        undefined,
        'reactivate',
        {},
        actor,
      );
      expect(await barcode.resolve(code)).toBe(active.sku);
      await barcode.retire(code, 'actor');
      expect(await barcode.resolve(code)).toBeNull();
    });

    it('creates simple and variant products atomically with the correct preparation and Outbox intents', async () => {
      const service = mutationService(),
        body = createRequest(),
        simple = await service.createProduct(body, actor);
      expect(simple).toMatchObject({
        status: 'BORRADOR',
        sku_base: body.skuBase,
        pricing_preparado: false,
        inventario_inicializado: false,
      });
      expect(
        (await requested(simple.product_id)).map((r) => r.event_name).sort(),
      ).toEqual([
        'inventory.sku.initialization.requested',
        'pricing.product.initialization.requested',
      ]);
      await expect(service.createProduct(body, actor)).rejects.toMatchObject({
        status: 409,
        response: { code: 'SKU_DUPLICADO' },
      });
      const parent = await service.createProduct(createRequest(true), actor);
      expect(
        (await requested(parent.product_id)).map((r) => r.event_name),
      ).toEqual(['pricing.product.initialization.requested']);
      const variantInput = {
        sku: '000-V-' + randomUUID(),
        atributosIdentificadores: [
          {
            caracteristica_id: 'size',
            nombre: 'Size',
            valor_id: 'M',
            valor: 'M',
          },
        ],
        imagenUrl: 'https://example.test/variant',
        perfilFisico: fullProfile,
      };
      const child = await service.createVariant(
        parent.product_id,
        variantInput,
        actor,
      );
      expect(child).toMatchObject({
        sku: variantInput.sku,
        status: 'BORRADOR',
      });
      const rows = await requested(parent.product_id);
      expect(
        rows.filter((r) => r.event_name.startsWith('pricing.')),
      ).toHaveLength(1);
      expect(
        rows.filter(
          (r) =>
            r.payload.variant_id === child.variant_id &&
            r.event_name.startsWith('inventory.'),
        ),
      ).toHaveLength(1);
      await expect(
        service.createVariant(
          parent.product_id,
          { ...variantInput, sku: 'new-' + randomUUID() },
          actor,
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'COMBINACION_DUPLICADA' },
      });
      await expect(
        service.createVariant(simple.product_id, variantInput, actor),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'PRODUCTO_NO_ADMITE_VARIANTES' },
      });
    });
    it('keeps a partial simple draft and rejects activation until its physical profile is complete', async () => {
      const service = mutationService();
      const product = await service.createProduct(
        {
          ...createRequest(),
          perfilFisico: { pesoKg: 1 },
        },
        actor,
      );
      expect(product).toMatchObject({ status: 'BORRADOR', catalog_version: 0 });
      await complete(product.product_id);
      await expect(
        service.state(product.product_id, undefined, 'activate', {}, actor),
      ).rejects.toMatchObject({ status: 422 });
      const unchanged = await transactions.run(async (tx) =>
        repository.aggregate(
          tx,
          (await repository.lockProduct(tx, product.product_id))!,
        ),
      );
      expect(unchanged).toMatchObject({
        estado: 'BORRADOR',
        catalog_version: 0n,
      });
      expect(unchanged.profile).toMatchObject({
        pesoKg: '1',
        largo: null,
        ancho: null,
        alto: null,
      });
      await service.update(
        product.product_id,
        undefined,
        { perfilFisico: fullProfile },
        actor,
      );
      await expect(
        service.state(product.product_id, undefined, 'activate', {}, actor),
      ).resolves.toMatchObject({ status: 'ACTIVO' });
    });

    it('ignores unprepared draft/inactive siblings and rolls back incomplete active variant edits', async () => {
      const service = mutationService();
      const parent = await service.createProduct(createRequest(true), actor);
      const children = [];
      for (const size of ['ready', 'ready-2', 'draft', 'rejected']) {
        children.push(
          await service.createVariant(
            parent.product_id,
            {
              sku: 'V-' + randomUUID(),
              atributosIdentificadores: [
                {
                  caracteristica_id: 'size',
                  nombre: 'Size',
                  valor_id: size,
                  valor: size,
                },
              ],
              imagenUrl: 'https://example.test/variant',
              perfilFisico: size.startsWith('ready')
                ? fullProfile
                : { pesoKg: 1 },
            },
            actor,
          ),
        );
      }
      const [ready, ready2, draft, rejected] = children;
      if (!ready || !ready2 || !draft || !rejected)
        throw new Error('Missing variant fixture');
      const messages = new CatalogMessageService(database);
      for (const row of await requested(parent.product_id)) {
        if (
          row.event_name.startsWith('pricing.') ||
          row.payload.variant_id === ready.variant_id ||
          row.payload.variant_id === ready2.variant_id
        )
          await messages.consume(resultFor(row));
        else if (row.payload.variant_id === rejected.variant_id)
          await messages.consume(resultFor(row, true));
      }
      await service.state(
        parent.product_id,
        rejected.variant_id,
        'deactivate',
        undefined,
        actor,
      );
      await expect(
        service.state(
          parent.product_id,
          rejected.variant_id,
          'reactivate',
          undefined,
          actor,
        ),
      ).rejects.toMatchObject({ status: 422 });
      await service.state(
        parent.product_id,
        ready.variant_id,
        'activate',
        undefined,
        actor,
      );
      await service.state(
        parent.product_id,
        ready2.variant_id,
        'activate',
        undefined,
        actor,
      );
      await service.state(parent.product_id, undefined, 'activate', {}, actor);
      const snapshot = () =>
        transactions.run(async (tx) =>
          repository.aggregate(
            tx,
            (await repository.lockProduct(tx, parent.product_id))!,
          ),
        );
      const before = await snapshot();
      await expect(
        service.update(
          parent.product_id,
          ready.variant_id,
          {
            perfilFisico: { pesoKg: 1 },
            catalogVersion: 1,
          },
          actor,
        ),
      ).rejects.toMatchObject({ status: 400 });
      const after = await snapshot();
      expect(after).toEqual(before);
      expect(after.estado).toBe('ACTIVO');
      const reads = new PostgresCatalogRepository(database);
      for (const canal of [
        'MARKETPLACE',
        'CHATBOT',
        'RETAIL',
        'VENTAS',
      ] as const) {
        const detail = await reads.findCandidateByProductId(
          parent.product_id,
          canal,
        );
        expect(detail?.variants.map((v) => v.variant_id)).toEqual(
          [ready.variant_id, ready2.variant_id].sort(),
        );
        expect(detail?.sku_base).toBe(parent.sku_base);
        expect(await reads.findCandidateBySlug(parent.slug, canal)).toEqual(
          detail,
        );
      }
      expect(
        after.children.find((c) => c.id === ready.variant_id)?.estado,
      ).toBe('ACTIVA');
      expect(
        after.children.find((c) => c.id === draft.variant_id)?.estado,
      ).toBe('BORRADOR');
      expect(
        after.children.find((c) => c.id === rejected.variant_id)?.estado,
      ).toBe('INACTIVA');
      const preparation = await new CatalogQueryRepository(
        database,
      ).productPreparation(parent.product_id);
      expect(
        preparation?.variantes.find((v) => v.variant_id === draft.variant_id)
          ?.inventario,
      ).toMatchObject({ status: 'PENDING', manual_retry_allowed: false });
      expect(
        preparation?.variantes.find((v) => v.variant_id === rejected.variant_id)
          ?.inventario,
      ).toMatchObject({
        status: 'REJECTED',
        manual_retry_allowed: false,
        code: 'FIXTURE_REJECTED',
      });
      const intents = await requested(parent.product_id);
      expect(
        intents.filter((r) => r.event_name.startsWith('pricing.')),
      ).toHaveLength(1);
      expect(
        intents.filter((r) => r.event_name.startsWith('inventory.')),
      ).toHaveLength(4);
      const queries = new CatalogQueryRepository(database);
      const draftPage = await queries.listVariants(
        parent.product_id,
        1,
        1,
        'BORRADOR',
      );
      expect(draftPage?.meta).toEqual({
        pagina: 1,
        tamanio: 1,
        total: 1,
        totalPaginas: 1,
      });
      expect(draftPage?.items.map((v) => v.variant_id)).toEqual([
        draft.variant_id,
      ]);
      expect(
        await queries.listVariants(parent.product_id, 3, 1, 'ACTIVA'),
      ).toMatchObject({ items: [], meta: { total: 2, totalPaginas: 2 } });
      expect(
        await queries.findVariant(randomUUID(), ready.variant_id),
      ).toBeNull();
      await expect(
        queries.physicalData([ready.sku, draft.sku]),
      ).rejects.toMatchObject({
        status: 422,
        response: {
          code: 'DATOS_FISICOS_INCOMPLETOS',
          details: { skusAfectados: [draft.sku] },
        },
      });
      expect(await snapshot()).toEqual(after);
      expect(await requested(parent.product_id)).toEqual(intents);
    });

    it('validates completed preparation and rolls back invalid active edits including versions', async () => {
      const service = mutationService(),
        product = await service.createProduct(createRequest(), actor);
      await expect(
        service.state(product.product_id, undefined, 'activate', {}, actor),
      ).rejects.toMatchObject({ status: 422 });
      await complete(product.product_id);
      expect(
        await service.state(
          product.product_id,
          undefined,
          'activate',
          { catalogVersion: 0 },
          actor,
        ),
      ).toMatchObject({ status: 'ACTIVO', catalog_version: 1 });
      await expect(
        service.update(
          product.product_id,
          undefined,
          { catalogVersion: 0, nombre: 'stale' },
          actor,
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'VERSION_CONFLICT' },
      });
      await expect(
        service.update(
          product.product_id,
          undefined,
          { perfilFisico: null, catalogVersion: 1 },
          actor,
        ),
      ).rejects.toMatchObject({ status: 400 });
      const [persisted] = await database.read((db) =>
        db.select().from(products).where(eq(products.id, product.product_id)),
      );
      expect(persisted).toMatchObject({
        estado: 'ACTIVO',
        catalog_version: 1n,
        nombre: 'Mutation fixture',
      });
      expect(
        await service.update(
          product.product_id,
          undefined,
          { descripcion: 'Valid edit', catalogVersion: 1 },
          actor,
        ),
      ).toMatchObject({ status: 'ACTIVO', catalog_version: 2 });
    });
    it('persists the exact product deactivation event once under concurrent retries', async () => {
      const service = mutationService();
      const product = await service.createProduct(createRequest(), actor);
      await complete(product.product_id, 'pricing');
      await complete(product.product_id, 'inventory');
      await service.state(product.product_id, undefined, 'activate', {}, actor);
      const rollbackFixtureSql = (statement: string) =>
        command(
          'docker',
          [
            'exec',
            '-i',
            container,
            'psql',
            '-U',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
          ],
          statement,
        );
      rollbackFixtureSql(`
          CREATE OR REPLACE FUNCTION catalog.test_reject_product_deactivation()
          RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.event_name = 'catalog.product.deactivated' THEN
              RAISE EXCEPTION 'disposable Outbox rollback fixture';
            END IF;
            RETURN NEW;
          END $$;
        `);
      rollbackFixtureSql(`
          CREATE TRIGGER test_reject_product_deactivation
          BEFORE INSERT ON catalog.outbox FOR EACH ROW
          EXECUTE FUNCTION catalog.test_reject_product_deactivation();
        `);
      await expect(
        service.state(product.product_id, undefined, 'deactivate', {}, actor),
      ).rejects.toBeDefined();
      expect(
        (
          await database.read((db) =>
            db
              .select()
              .from(products)
              .where(eq(products.id, product.product_id)),
          )
        )[0]?.estado,
      ).toBe('ACTIVO');
      rollbackFixtureSql(
        'DROP TRIGGER test_reject_product_deactivation ON catalog.outbox',
      );
      rollbackFixtureSql(
        'DROP FUNCTION catalog.test_reject_product_deactivation()',
      );
      const attempts = await Promise.allSettled([
        service.state(product.product_id, undefined, 'deactivate', {}, actor),
        service.state(product.product_id, undefined, 'deactivate', {}, actor),
      ]);
      expect(attempts.every((attempt) => attempt.status === 'fulfilled')).toBe(
        true,
      );
      const [persisted] = await database.read((db) =>
        db.select().from(products).where(eq(products.id, product.product_id)),
      );
      const events = await database.read((db) =>
        db
          .select()
          .from(outbox)
          .where(
            and(
              eq(outbox.event_name, 'catalog.product.deactivated'),
              sql`${outbox.payload}->>'product_id' = ${product.product_id}`,
            ),
          ),
      );
      expect(events).toHaveLength(1);
      expect(Object.keys(events[0]!.payload).sort()).toEqual([
        'changed_at',
        'product_id',
        'product_version',
      ]);
      expect(events[0]!.payload).toEqual({
        product_id: product.product_id,
        product_version: Number(persisted!.catalog_version),
        changed_at: persisted!.updated_at.toISOString(),
      });
      expect(events[0]!.correlation_id).toBe(actor.correlationId);
    });

    it('serializes last-variant deactivation and preserves independent parent/child reactivation', async () => {
      const service = mutationService(),
        parent = await service.createProduct(createRequest(true), actor);
      const child = await service.createVariant(
        parent.product_id,
        {
          sku: '000-V-' + randomUUID(),
          atributosIdentificadores: [
            {
              caracteristica_id: 'size',
              nombre: 'Size',
              valor_id: 'L',
              valor: 'L',
            },
          ],
          imagenUrl: 'https://example.test/variant',
          perfilFisico: fullProfile,
        },
        actor,
      );
      await complete(parent.product_id, 'inventory');
      expect(
        await service.state(
          parent.product_id,
          child.variant_id,
          'activate',
          undefined,
          actor,
        ),
      ).toMatchObject({ status: 'ACTIVA' });
      await expect(
        service.state(parent.product_id, undefined, 'activate', {}, actor),
      ).rejects.toMatchObject({ status: 422 });
      await complete(parent.product_id, 'pricing');
      await service.state(parent.product_id, undefined, 'activate', {}, actor);
      await service.state(
        parent.product_id,
        child.variant_id,
        'deactivate',
        undefined,
        actor,
      );
      const snapshot = await transactions.run(async (tx) =>
        repository.aggregate(
          tx,
          (await repository.lockProduct(tx, parent.product_id))!,
        ),
      );
      expect(snapshot.estado).toBe('INACTIVO');
      expect(snapshot.children[0]?.estado).toBe('INACTIVA');
      const events = await database.read((db) =>
        db
          .select()
          .from(outbox)
          .where(sql`${outbox.payload}->>'product_id' = ${parent.product_id}`),
      );
      expect(
        events.filter((e) => e.event_name.endsWith('.deactivated')),
      ).toHaveLength(2);
      const skuEvent = events.find(
          (event) => event.event_name === 'catalog.sku.deactivated',
        )!,
        productEvent = events.find(
          (event) => event.event_name === 'catalog.product.deactivated',
        )!;
      expect(Object.keys(skuEvent.payload).sort()).toEqual([
        'changed_at',
        'product_id',
        'sku',
        'sku_version',
      ]);
      expect(skuEvent.payload).toMatchObject({
        product_id: parent.product_id,
        sku: child.sku,
        sku_version: Number(snapshot.children[0]!.catalog_version),
        changed_at: snapshot.children[0]!.updated_at.toISOString(),
      });
      expect(Object.keys(productEvent.payload).sort()).toEqual([
        'changed_at',
        'product_id',
        'product_version',
      ]);
      expect(productEvent.payload).toMatchObject({
        product_id: parent.product_id,
        product_version: Number(snapshot.catalog_version),
        changed_at: snapshot.updated_at.toISOString(),
      });
      expect(skuEvent.correlation_id).toBe(actor.correlationId);
      expect(productEvent.correlation_id).toBe(actor.correlationId);
      const versionsBeforeRepeat = [
        snapshot.catalog_version,
        snapshot.children[0]!.catalog_version,
      ];
      await service.state(
        parent.product_id,
        child.variant_id,
        'deactivate',
        undefined,
        actor,
      );
      const repeatSnapshot = await transactions.run(async (tx) =>
        repository.aggregate(
          tx,
          (await repository.lockProduct(tx, parent.product_id))!,
        ),
      );
      expect([
        repeatSnapshot.catalog_version,
        repeatSnapshot.children[0]!.catalog_version,
      ]).toEqual(versionsBeforeRepeat);
      const repeatedEvents = await database.read((db) =>
        db
          .select()
          .from(outbox)
          .where(sql`${outbox.payload}->>'product_id' = ${parent.product_id}`),
      );
      expect(
        repeatedEvents.filter((event) =>
          event.event_name.endsWith('.deactivated'),
        ),
      ).toHaveLength(2);
      await service.state(
        parent.product_id,
        child.variant_id,
        'reactivate',
        undefined,
        actor,
      );
      const [stillInactive] = await database.read((db) =>
        db.select().from(products).where(eq(products.id, parent.product_id)),
      );
      expect(stillInactive.estado).toBe('INACTIVO');
      const reads = new PostgresCatalogRepository(database);
      expect(
        await reads.findCandidateByProductId(parent.product_id, 'MARKETPLACE'),
      ).toBeNull();
      expect(await reads.findCandidateBySlug(parent.slug)).toBeNull();
      await service.state(
        parent.product_id,
        undefined,
        'reactivate',
        {},
        actor,
      );
      const deactivated = await service.state(
        parent.product_id,
        undefined,
        'deactivate',
        {},
        actor,
      );
      expect(deactivated).toMatchObject({
        status: 'INACTIVO',
        variants: [expect.objectContaining({ status: 'ACTIVA' })],
      });
      expect(
        await reads.findCandidateByProductId(parent.product_id, 'MARKETPLACE'),
      ).toBeNull();
    });
    it('admits only one manual retry, rejects stale results and keeps COMPLETED terminal with Inbox dedupe', async () => {
      vi.stubEnv('CATALOG_PREPARATION_TIMEOUT_MS', '1');
      try {
        const service = mutationService(),
          product = await service.createProduct(createRequest(), actor),
          messages = new CatalogMessageService(database);
        const original = (await requested(product.product_id)).find((r) =>
          r.event_name.startsWith('inventory.'),
        )!;
        await database.read((db) =>
          db
            .update(outbox)
            .set({ published_at: new Date(Date.now() - 10000) })
            .where(eq(outbox.id, original.id)),
        );
        const attempts = await Promise.allSettled([
          service.retry(
            product.product_id,
            undefined,
            { dependencia: 'INVENTARIO' },
            actor,
          ),
          service.retry(
            product.product_id,
            undefined,
            { dependencia: 'INVENTARIO' },
            actor,
          ),
        ]);
        expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(
          1,
        );
        expect(attempts.find((a) => a.status === 'rejected')).toMatchObject({
          reason: {
            status: 409,
            response: { code: 'PREPARACION_NO_REINTENTABLE' },
          },
        });
        const active = activeAttempt(
          (await requested(product.product_id)).filter(
            (r) => r.operation_id === original.operation_id,
          ),
        )!;
        expect(active.message_id).not.toBe(original.message_id);
        expect(active.operation_id).toBe(original.operation_id);
        expect(await messages.consume(resultFor(original))).toBe('STALE');
        const success = resultFor(active);
        expect(await messages.consume(success)).toBe('APPLIED');
        expect(await messages.consume(success)).toBe('DUPLICATE');
        expect(await messages.consume(resultFor(active, true))).toBe(
          'TERMINAL',
        );
        const [check] = await database.read((db) =>
          db
            .select()
            .from(activationChecks)
            .where(eq(activationChecks.operation_id, original.operation_id!)),
        );
        expect(check.state).toBe('COMPLETED');
        await expect(
          service.retry(
            product.product_id,
            undefined,
            { dependencia: 'INVENTARIO' },
            actor,
          ),
        ).rejects.toMatchObject({ status: 409 });
      } finally {
        vi.unstubAllEnvs();
      }
    });
    it('keeps Outbox pending without confirm and permits parallel relays without claiming one row twice', async () => {
      const service = mutationService(),
        product = await service.createProduct(createRequest(), actor),
        messages = new CatalogMessageService(database);
      // Other tests leave pending records intentionally; a failed relay must preserve its selected immutable envelope.
      expect(
        await messages.relayOne({
          publish: async () => {
            throw new Error('fixture unconfirmed');
          },
        }),
      ).toBe('PENDING');
      const seen = new Set<string>();
      const publish = async (
        message: import('../src/catalog-messages.js').CatalogEnvelope,
      ) => {
        expect(seen.has(message.message_id)).toBe(false);
        seen.add(message.message_id);
      };
      await Promise.all([
        messages.relayOne({ publish }),
        messages.relayOne({ publish }),
      ]);
      expect(seen.size).toBe(2);
      expect((await requested(product.product_id)).length).toBe(2);
    });

    it('OPEN-09-PROVIDER: signed service JWT → real Catalog HTTP → PostgreSQL TLS, effective states, integral batches, 422 and 503', async () => {
      const service = mutationService(),
        http = new CatalogGatewayHarness();
      const expected = new Map<string, string>(),
        parentIds: string[] = [],
        childIds: string[] = [],
        bases: string[] = [];
      for (const state of ['ACTIVO', 'INACTIVO', 'BORRADOR']) {
        const simple = await service.createProduct(
          { ...createRequest(), skuBase: '000,/ñ-' + state + randomUUID() },
          actor,
        );
        parentIds.push(simple.product_id);
        expected.set(simple.sku_base, state);
        if (state !== 'BORRADOR') {
          await complete(simple.product_id);
          await service.state(
            simple.product_id,
            undefined,
            'activate',
            {},
            actor,
          );
          if (state === 'INACTIVO')
            await service.state(
              simple.product_id,
              undefined,
              'deactivate',
              {},
              actor,
            );
        }
        const parent = await service.createProduct(createRequest(true), actor);
        parentIds.push(parent.product_id);
        bases.push(parent.sku_base);
        const children = [];
        for (const [index, ownState] of [
          'ACTIVA',
          'INACTIVA',
          'BORRADOR',
        ].entries()) {
          const child = await service.createVariant(
            parent.product_id,
            {
              sku: '000Var,/ñ-' + state + ownState + randomUUID(),
              atributosIdentificadores: [
                {
                  caracteristica_id: 'size',
                  nombre: 'Size',
                  valor_id: String(index),
                  valor: String(index),
                },
              ],
              imagenUrl: 'https://example.test/g2-variant',
              perfilFisico: fullProfile,
            },
            actor,
          );
          children.push(child);
          childIds.push(child.variant_id);
          expected.set(
            child.sku,
            ownState === 'ACTIVA'
              ? state
              : ownState === 'INACTIVA'
                ? 'INACTIVO'
                : 'BORRADOR',
          );
        }
        await complete(parent.product_id);
        for (const child of children.slice(0, 2))
          await service.state(
            parent.product_id,
            child.variant_id,
            'activate',
            undefined,
            actor,
          );
        await service.state(
          parent.product_id,
          children[1].variant_id,
          'deactivate',
          undefined,
          actor,
        );
        if (state !== 'BORRADOR') {
          await service.state(
            parent.product_id,
            undefined,
            'activate',
            {},
            actor,
          );
          if (state === 'INACTIVO')
            await service.state(
              parent.product_id,
              undefined,
              'deactivate',
              {},
              actor,
            );
        }
      }
      const incomplete = await service.createProduct(
        { ...createRequest(), perfilFisico: { pesoKg: 1 } },
        actor,
      );
      const partial = await service.createVariant(
        parentIds.at(-1)!,
        {
          sku: 'incomplete-' + randomUUID(),
          atributosIdentificadores: [
            {
              caracteristica_id: 'size',
              nombre: 'Size',
              valor_id: 'partial',
              valor: 'partial',
            },
          ],
          imagenUrl: 'https://example.test/g2-partial',
          perfilFisico: { pesoKg: 1 },
        },
        actor,
      );
      const snapshot = async () =>
        database.read(async (db) => ({
          parents: (await db.select().from(products)).filter((p) =>
            parentIds.includes(p.id),
          ),
          children: (await db.select().from(variants)).filter((v) =>
            childIds.includes(v.id),
          ),
        }));
      const before = await snapshot();
      await http.start(persistenceSettings);
      const claims = {
        tipo: 'servicio',
        sub: 'modulo-despacho',
        aud: 'api-productos',
        scope: 'productos:fisicos:leer',
        roles: undefined,
      };
      const bearer = http.token(claims),
        path = '/productos/datos-fisicos/consulta';
      const call = (skus: string[], token: string | null = bearer) =>
        http.call('POST', path, { skus }, token, true);
      const absent = Array.from(
        { length: 100 - expected.size },
        (_, i) => 'missing-' + i,
      );
      const skus = [...expected.keys(), ...absent];
      const assertComplete = (result: Awaited<ReturnType<typeof call>>) => {
        expect(result.status).toBe(200);
        expect(result.correlation).toBe(http.correlation);
        expect(result.type).toContain('application/json');
        expect(result.body.noEncontrados).toEqual(absent);
        expect(result.body.productos).toHaveLength(expected.size);
        for (const item of result.body.productos as Array<{
          sku: string;
          estado: string;
        }>)
          expect(item).toEqual({
            sku: item.sku,
            estado: expected.get(item.sku),
            ...fullProfile,
            actualizadoEn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          });
        const classified = [
          ...result.body.productos.map((p: { sku: string }) => p.sku),
          ...result.body.noEncontrados,
        ];
        expect(classified).toHaveLength(100);
        expect(new Set(classified)).toEqual(new Set(skus));
      };
      try {
        assertComplete(await call(skus));
        for (const batch of [
          [bases[0]],
          [bases[1], ...skus.slice(0, 3)],
          [incomplete.sku_base, bases[2], 'missing'],
          [bases[2], bases[0], bases[1]],
          [incomplete.sku_base, bases[1], partial.sku, bases[0], skus[0]],
        ]) {
          const result = await call(batch);
          expect(result.status).toBe(422);
          expect(result.type).toContain('application/problem+json');
          expect(result.body.code).toBe('SKU_INVALIDO');
          expect(result.body.details).toEqual({
            skusAfectados: batch.filter((sku) => bases.includes(sku)),
          });
          expect(result.body).not.toHaveProperty('productos');
        }
        const invalidProfile = await call([
          skus[0],
          incomplete.sku_base,
          partial.sku,
          'missing',
        ]);
        expect(invalidProfile.status).toBe(422);
        expect(invalidProfile.body).toMatchObject({
          code: 'DATOS_FISICOS_INCOMPLETOS',
          details: { skusAfectados: [incomplete.sku_base, partial.sku] },
          correlationId: http.correlation,
        });
        for (const batch of [[], [skus[0], skus[0]], [...skus, 'overflow']]) {
          const result = await call(batch);
          expect(result.status).toBe(422);
          expect(result.body.code).toBe('SKU_INVALIDO');
          expect(result.body).not.toHaveProperty('details');
        }
        expect((await call([skus[0]], null)).status).toBe(401);
        for (const [patch, status] of [
          [{ aud: 'other' }, 401],
          [{ scope: 'catalogo:leer' }, 403],
          [{ sub: 'modulo-productos' }, 403],
        ] as const)
          expect(
            (await call([skus[0]], http.token({ ...claims, ...patch }))).status,
          ).toBe(status);
        const permissions = (grant: boolean) =>
          command(
            'docker',
            [
              'exec',
              '-i',
              container,
              'psql',
              '-U',
              'postgres',
              '-v',
              'ON_ERROR_STOP=1',
            ],
            grant
              ? 'GRANT SELECT ON catalog.sku_identity TO catalog_app;'
              : 'REVOKE SELECT ON catalog.sku_identity FROM catalog_app;',
          );
        try {
          // Actual PostgreSQL permission failure; no repository/provider replacement.
          permissions(false);
          const unavailable = await call(skus);
          expect(unavailable.status).toBe(503);
          expect(unavailable.type).toContain('application/problem+json');
          expect(unavailable.body).toMatchObject({
            code: 'SERVICIO_NO_DISPONIBLE',
            status: 503,
            correlationId: http.correlation,
          });
          expect(JSON.stringify(unavailable.body)).not.toMatch(
            /SELECT|sku_identity|permission|password|catalog_app/,
          );
        } finally {
          permissions(true);
        }
        assertComplete(await call(skus));
        expect(await snapshot()).toEqual(before);
      } finally {
        await http.close();
      }
    }, 90000);

    it('OPEN-09: reads simple and variant physical profiles in all three states without mutation', async () => {
      const service = mutationService(),
        queries = new CatalogQueryRepository(database);
      const body = { ...createRequest(), skuBase: '000AbC,/ñ-' + randomUUID() };
      const simple = await service.createProduct(body, actor);
      const parent = await service.createProduct(createRequest(true), actor);
      const child = await service.createVariant(
        parent.product_id,
        {
          sku: '000Variant,/ñ-' + randomUUID(),
          atributosIdentificadores: [
            {
              caracteristica_id: 'size',
              nombre: 'Size',
              valor_id: 'S',
              valor: 'S',
            },
          ],
          imagenUrl: 'https://example.test/variant',
          perfilFisico: fullProfile,
        },
        actor,
      );
      const skus = [body.skuBase, child.sku, 'missing'];
      async function assertState(estado: string) {
        const result = await queries.physicalData(skus);
        expect(result).toMatchObject({
          productos: [
            { sku: body.skuBase, estado, ...fullProfile },
            { sku: child.sku, estado, ...fullProfile },
          ],
          noEncontrados: ['missing'],
        });
        expect(
          [
            ...result.productos.map((p) => p.sku),
            ...result.noEncontrados,
          ].sort(),
        ).toEqual([...skus].sort());
      }
      await assertState('BORRADOR');
      await complete(simple.product_id);
      await complete(parent.product_id);
      await service.state(simple.product_id, undefined, 'activate', {}, actor);
      await service.state(
        parent.product_id,
        child.variant_id,
        'activate',
        undefined,
        actor,
      );
      await service.state(parent.product_id, undefined, 'activate', {}, actor);
      await assertState('ACTIVO');
      await service.state(
        simple.product_id,
        undefined,
        'deactivate',
        {},
        actor,
      );
      await service.state(
        parent.product_id,
        child.variant_id,
        'deactivate',
        undefined,
        actor,
      );
      await assertState('INACTIVO');
      const before = await requested(simple.product_id);
      const absent = Array.from({ length: 98 }, (_, i) => 'absent-' + i);
      const result = await queries.physicalData([
        body.skuBase,
        child.sku,
        ...absent,
      ]);
      expect(result.productos).toHaveLength(2);
      expect(result.noEncontrados).toEqual(absent);
      expect(await requested(simple.product_id)).toEqual(before);
      const incomplete = await service.createProduct(
        { ...createRequest(), perfilFisico: { pesoKg: 1 } },
        actor,
      );
      const partialVariant = await service.createVariant(
        parent.product_id,
        {
          sku: 'partial-' + randomUUID(),
          imagenUrl: 'https://example.test/partial-variant',
          atributosIdentificadores: [
            {
              caracteristica_id: 'size',
              nombre: 'Size',
              valor_id: 'M',
              valor: 'M',
            },
          ],
        },
        actor,
      );
      await expect(
        queries.physicalData([
          body.skuBase,
          incomplete.sku_base,
          partialVariant.sku,
          'missing',
        ]),
      ).rejects.toMatchObject({
        status: 422,
        response: {
          code: 'DATOS_FISICOS_INCOMPLETOS',
          details: { skusAfectados: [incomplete.sku_base, partialVariant.sku] },
        },
      });
    });

    it('reads contractual preparation, variants and physical SKU data from the committed aggregate', async () => {
      const service = mutationService(),
        simpleBody = createRequest(),
        simple = await service.createProduct(simpleBody, actor);
      await complete(simple.product_id);
      await service.state(simple.product_id, undefined, 'activate', {}, actor);
      const parentBody = createRequest(true),
        parent = await service.createProduct(parentBody, actor);
      const child = await service.createVariant(
        parent.product_id,
        {
          sku: '000-' + randomUUID(),
          atributosIdentificadores: [
            {
              caracteristica_id: 'size',
              nombre: 'Size',
              valor_id: 'S',
              valor: 'S',
            },
          ],
          atributosNoIdentificadores: [
            {
              caracteristica_id: 'material',
              nombre: 'Material',
              valor_id: null,
              valor: 'Cotton',
            },
          ],
          imagenUrl: 'https://example.test/variant',
          perfilFisico: fullProfile,
        },
        actor,
      );
      const inactive = await service.createVariant(
        parent.product_id,
        {
          sku: '000-' + randomUUID(),
          atributosIdentificadores: [
            {
              caracteristica_id: 'size',
              nombre: 'Size',
              valor_id: 'M',
              valor: 'M',
            },
          ],
          imagenUrl: 'https://example.test/inactive',
          perfilFisico: fullProfile,
        },
        actor,
      );
      const draft = await service.createVariant(
        parent.product_id,
        {
          sku: '000-' + randomUUID(),
          atributosIdentificadores: [
            {
              caracteristica_id: 'size',
              nombre: 'Size',
              valor_id: 'L',
              valor: 'L',
            },
          ],
          imagenUrl: 'https://example.test/draft',
          perfilFisico: { pesoKg: 1 },
        },
        actor,
      );
      await database.read(async (db) => {
        await db
          .update(variantImages)
          .set({ posicion: 2 })
          .where(
            and(
              eq(variantImages.variant_id, child.variant_id),
              eq(variantImages.url, 'https://example.test/variant'),
            ),
          );
        await db.insert(variantImages).values([
          {
            variant_id: child.variant_id,
            url: 'https://example.test/variant-second',
            posicion: 1,
          },
          {
            variant_id: child.variant_id,
            url: 'https://example.test/variant-first-extra',
            posicion: 0,
          },
        ]);
      });
      await complete(parent.product_id);
      await service.state(
        parent.product_id,
        child.variant_id,
        'activate',
        undefined,
        actor,
      );
      await service.state(
        parent.product_id,
        inactive.variant_id,
        'activate',
        undefined,
        actor,
      );
      await service.state(parent.product_id, undefined, 'activate', {}, actor);
      await service.state(
        parent.product_id,
        inactive.variant_id,
        'deactivate',
        undefined,
        actor,
      );
      let sqlSelectCount = 0;
      const countedDatabase = {
        read: <T>(work: (db: CatalogDatabase) => Promise<T>): Promise<T> =>
          database.read((db) =>
            work(
              new Proxy(db, {
                get(target, property, receiver) {
                  if (property !== 'transaction') {
                    const value = Reflect.get(target, property, receiver);
                    return typeof value === 'function'
                      ? value.bind(target)
                      : value;
                  }
                  return (
                    callback: (tx: CatalogTransaction) => Promise<unknown>,
                    config?: Parameters<CatalogDatabase['transaction']>[1],
                  ) =>
                    target.transaction(
                      (tx) =>
                        callback(
                          new Proxy(tx, {
                            get(txTarget, txProperty, txReceiver) {
                              if (txProperty === 'select') {
                                return (
                                  ...args: Parameters<
                                    CatalogTransaction['select']
                                  >
                                ) => {
                                  sqlSelectCount++;
                                  return txTarget.select(...args);
                                };
                              }
                              const value = Reflect.get(
                                txTarget,
                                txProperty,
                                txReceiver,
                              );
                              return typeof value === 'function'
                                ? value.bind(txTarget)
                                : value;
                            },
                          }),
                        ),
                      config,
                    );
                },
              }),
            ),
          ),
      } as unknown as Database;
      const queries = new CatalogQueryRepository(countedDatabase, {
        timeoutMs: 60000,
      });
      const physical = await queries.physicalData([
        simpleBody.skuBase,
        child.sku,
        'missing',
      ]);
      expect(physical.noEncontrados).toEqual(['missing']);
      await expect(
        queries.physicalData([parentBody.skuBase, child.sku, 'missing']),
      ).rejects.toMatchObject({
        status: 422,
        response: { code: 'SKU_INVALIDO' },
      });
      expect(physical.productos).toEqual([
        expect.objectContaining({
          sku: simpleBody.skuBase,
          estado: 'ACTIVO',
          pesoKg: 1.5,
          dimensionesCm: { largo: 10, ancho: 20, alto: 30 },
        }),
        expect.objectContaining({ sku: child.sku, estado: 'ACTIVO' }),
      ]);
      expect(await queries.productPreparation(parent.product_id)).toMatchObject(
        {
          inventario: null,
          pricing: { status: 'COMPLETED', manual_retry_allowed: false },
          variantes: expect.arrayContaining([
            {
              variant_id: child.variant_id,
              sku: child.sku,
              inventario: {
                status: 'COMPLETED',
                manual_retry_allowed: false,
                code: null,
              },
            },
            {
              variant_id: inactive.variant_id,
              sku: inactive.sku,
              inventario: {
                status: 'COMPLETED',
                manual_retry_allowed: false,
                code: null,
              },
            },
            {
              variant_id: draft.variant_id,
              sku: draft.sku,
              inventario: {
                status: 'COMPLETED',
                manual_retry_allowed: false,
                code: null,
              },
            },
          ]),
        },
      );
      sqlSelectCount = 0;
      const hydrated = await queries.listVariants(parent.product_id, 1, 20);
      // Real SELECT builders against the isolated PostgreSQL 17 fixture (not Drizzle result doubles).
      expect(sqlSelectCount).toBe(6);
      expect(hydrated?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            variant_id: child.variant_id,
            sku: child.sku,
            status: 'ACTIVA',
            identifying_attributes: [
              {
                caracteristica_id: 'size',
                nombre: 'Size',
                valor_id: 'S',
                valor: 'S',
              },
            ],
            non_identifying_attributes: [
              {
                caracteristica_id: 'material',
                nombre: 'Material',
                valor_id: null,
                valor: 'Cotton',
              },
            ],
            images: [
              'https://example.test/variant-first-extra',
              'https://example.test/variant-second',
              'https://example.test/variant',
            ],
            physical_profile: {
              sku: child.sku,
              estado: 'ACTIVO',
              pesoKg: 1.5,
              dimensionesCm: { largo: 10, ancho: 20, alto: 30 },
              actualizadoEn: expect.any(String),
            },
          }),
          expect.objectContaining({
            variant_id: inactive.variant_id,
            status: 'INACTIVA',
            physical_profile: expect.objectContaining({ estado: 'INACTIVO' }),
          }),
          expect.objectContaining({
            variant_id: draft.variant_id,
            status: 'BORRADOR',
            physical_profile: null,
          }),
        ]),
      );
      expect(hydrated?.items).toHaveLength(3);
      expect(hydrated?.meta).toEqual({
        pagina: 1,
        tamanio: 20,
        total: 3,
        totalPaginas: 1,
      });
      for (const item of hydrated?.items ?? [])
        expect(
          await queries.findVariant(parent.product_id, item.variant_id),
        ).toEqual(item);
      expect(
        await queries.listVariants(simple.product_id, 1, 20),
      ).toMatchObject({ items: [], meta: { total: 0, totalPaginas: 0 } });
      expect(
        await queries.findVariant(parent.product_id, child.variant_id),
      ).toMatchObject({
        variant_id: child.variant_id,
        physical_profile: { sku: child.sku },
      });
      expect(
        await queries.findVariant(simple.product_id, child.variant_id),
      ).toBeNull();
    });

    it('enforces runtime ownership, denies cross-schema access, and closes its pool', async () => {
      const roles = await database.read((db) =>
        db.execute(sql`
      SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
             has_schema_privilege(current_user, 'catalog', 'USAGE') AS catalog_usage
      FROM pg_roles r WHERE r.rolname = current_user
    `),
      );
      expect(roles.rows[0]).toMatchObject({
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        catalog_usage: true,
      });
      await expect(
        database.read((db) =>
          db.execute(sql`SELECT value FROM foreign_context.private_probe`),
        ),
      ).rejects.toMatchObject({ failure: 'other' });
      await expect(
        database.read((db) =>
          db.execute(sql`CREATE TABLE public.catalog_forbidden (id integer)`),
        ),
      ).rejects.toMatchObject({ failure: 'other' });

      const schemaTables = [
        'products',
        'variants',
        'sku_identity',
        'product_images',
        'variant_images',
        'product_attribute_values',
        'variant_attribute_values',
        'product_identifying_characteristics',
        'sku_physical_profiles',
        'activation_checks',
        'master_barriers',
        'outbox',
        'inbox',
      ];
      const mutableTables = new Set([
        'products',
        'variants',
        'product_images',
        'variant_images',
        'product_attribute_values',
        'variant_attribute_values',
        'product_identifying_characteristics',
        'sku_physical_profiles',
        'activation_checks',
        'master_barriers',
      ]);
      const deletableTables = new Set([
        'product_images',
        'variant_images',
        'product_attribute_values',
        'variant_attribute_values',
        'product_identifying_characteristics',
        'sku_physical_profiles',
      ]);
      const grants = await database.read((db) =>
        db.execute(sql`
          SELECT table_name,
            has_table_privilege(current_user, format('catalog.%I', table_name), 'SELECT') AS can_select,
            has_table_privilege(current_user, format('catalog.%I', table_name), 'INSERT') AS can_insert,
            has_table_privilege(current_user, format('catalog.%I', table_name), 'UPDATE') AS can_update,
            has_table_privilege(current_user, format('catalog.%I', table_name), 'DELETE') AS can_delete
          FROM (VALUES
            ('products'), ('variants'), ('sku_identity'), ('product_images'),
            ('variant_images'), ('product_attribute_values'),
            ('variant_attribute_values'), ('product_identifying_characteristics'),
            ('sku_physical_profiles'), ('activation_checks'), ('master_barriers'),
            ('outbox'), ('inbox')
          ) AS tables(table_name)
        `),
      );
      expect(grants.rows).toHaveLength(schemaTables.length);
      expect(grants.rows).toEqual(
        expect.arrayContaining(
          schemaTables.map((table_name) => ({
            table_name,
            can_select: true,
            can_insert: true,
            can_update: mutableTables.has(table_name),
            can_delete: deletableTables.has(table_name),
          })),
        ),
      );

      const outboxColumnGrants = await database.read((db) =>
        db.execute(sql`
          SELECT column_name,
            has_column_privilege(current_user, 'catalog.outbox', column_name, 'UPDATE') AS can_update
          FROM unnest(ARRAY['published_at', 'attempts', 'last_error', 'payload']::text[])
            AS columns(column_name)
        `),
      );
      expect(outboxColumnGrants.rows).toEqual(
        expect.arrayContaining([
          { column_name: 'published_at', can_update: true },
          { column_name: 'attempts', can_update: true },
          { column_name: 'last_error', can_update: true },
          { column_name: 'payload', can_update: false },
        ]),
      );

      const sku = 'SKU-' + randomUUID();
      const product = await transactions.run((tx) =>
        repository.insertProduct(tx, productInput(sku)),
      );
      await database.read((db) =>
        db.execute(sql`
          UPDATE catalog.products SET descripcion = 'Runtime permission fixture updated'
          WHERE id = ${product.id}
        `),
      );
      const updatedProduct = await database.read((db) =>
        db.execute(
          sql`SELECT descripcion FROM catalog.products WHERE id = ${product.id}`,
        ),
      );
      expect(updatedProduct.rows[0]?.descripcion).toBe(
        'Runtime permission fixture updated',
      );
      await expect(
        database.read((db) =>
          db.execute(
            sql`DELETE FROM catalog.products WHERE id = ${product.id}`,
          ),
        ),
      ).rejects.toMatchObject({ failure: 'other', sqlState: '42501' });
      await expect(
        database.read((db) =>
          db.execute(
            sql`UPDATE catalog.sku_identity SET sku = ${'SKU-' + randomUUID()} WHERE sku = ${sku}`,
          ),
        ),
      ).rejects.toMatchObject({ failure: 'other', sqlState: '42501' });
      await expect(
        database.read((db) =>
          db.execute(sql`DELETE FROM catalog.sku_identity WHERE sku = ${sku}`),
        ),
      ).rejects.toMatchObject({ failure: 'other', sqlState: '42501' });

      const imageId = randomUUID();
      await database.read((db) =>
        db.execute(sql`
          INSERT INTO catalog.product_images (id, product_id, url)
          VALUES (${imageId}, ${product.id}, 'https://example.test/catalog-fixture')
        `),
      );
      await database.read((db) =>
        db.execute(sql`
          UPDATE catalog.product_images
          SET url = 'https://example.test/catalog-fixture-updated'
          WHERE id = ${imageId}
        `),
      );
      await database.read((db) =>
        db.execute(
          sql`DELETE FROM catalog.product_images WHERE id = ${imageId}`,
        ),
      );

      const outboxMessageId = randomUUID();
      await database.read((db) =>
        db.execute(sql`
          INSERT INTO catalog.outbox
            (message_id, event_name, kind, correlation_id, occurred_at, payload)
          VALUES (
            ${outboxMessageId}, 'catalog.test', 'event', ${randomUUID()},
            now(), ${JSON.stringify({ immutable: true })}::jsonb
          )
        `),
      );
      await database.read((db) =>
        db.execute(sql`
          UPDATE catalog.outbox SET attempts = attempts + 1, last_error = 'fixture retry'
          WHERE message_id = ${outboxMessageId}
        `),
      );
      await database.read((db) =>
        db.execute(sql`
          UPDATE catalog.outbox SET published_at = now()
          WHERE message_id = ${outboxMessageId}
        `),
      );
      const outboxRow = await database.read((db) =>
        db.execute(
          sql`SELECT payload FROM catalog.outbox WHERE message_id = ${outboxMessageId}`,
        ),
      );
      expect(outboxRow.rows[0]?.payload).toEqual({ immutable: true });
      await expect(
        database.read((db) =>
          db.execute(sql`
            UPDATE catalog.outbox SET payload = ${JSON.stringify({ changed: true })}::jsonb
            WHERE message_id = ${outboxMessageId}
          `),
        ),
      ).rejects.toMatchObject({ failure: 'other', sqlState: '42501' });

      await database.onModuleDestroy();
      closed = true;
      await expect(database.read(async () => true)).rejects.toMatchObject({
        failure: 'connection',
      });
    });
  },
);
