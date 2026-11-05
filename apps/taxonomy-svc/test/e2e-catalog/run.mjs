import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import pg from 'pg';
import { connect } from 'amqplib';
import { Test } from '@nestjs/testing';
let iniciarTaxonomySvc, DeactivationIntentService, TaxonomyAmqpRuntime;
let AppModule, CatalogConfig, CATALOG_AMQP_SETTINGS, CatalogDatabase;

// Isolated, self-provisioned infrastructure only. Never accepts database or AMQP URLs.
const token = randomBytes(10).toString('hex');
const pgName = `g6-cross-pg-${token}`,
  rabbitName = `g6-cross-rabbit-${token}`;
const password = randomBytes(20).toString('hex');
const catalogPass = randomBytes(20).toString('hex');
const tmp = mkdtempSync(join(tmpdir(), 'g6-cross-e2e-'));
const key = join(tmp, 'server.key'),
  cert = join(tmp, 'server.crt');
const docsCheckout = () => {
  const candidates = [
    process.env.G6_E2E_DOCS_PATH,
    '../G6-Productos-Ofertas-docs',
    '../docs',
  ].filter((candidate) => typeof candidate === 'string' && candidate.trim());
  for (const candidate of candidates) {
    const root = resolve(candidate);
    if (
      !existsSync(join(root, '.git')) &&
      !existsSync(join(root, '.git', 'HEAD'))
    )
      continue;
    const gitRoot = spawnSync(
      'git',
      ['-C', root, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (gitRoot.error || gitRoot.status !== 0) continue;
    const checkoutRoot = resolve(gitRoot.stdout.trim());
    if (
      checkoutRoot !== root ||
      !existsSync(
        join(root, 'datos/taxonomy/migrations/0001_create_taxonomy.sql'),
      ) ||
      !existsSync(
        join(root, 'datos/catalog-svc/migrations/0001_create_catalog.sql'),
      )
    )
      continue;
    return root;
  }
  return undefined;
};
const reportPath = resolve(
  process.env.G6_E2E_EVIDENCE_PATH ??
    'apps/taxonomy-svc/test/e2e-catalog/evidence-latest.json',
);
const report = {
  taxonomySha: '',
  catalogSha: '',
  environment: 'PostgreSQL 17 + RabbitMQ 4.2.9, TLS, loopback, desechables',
  scenarios: {},
  finalState: {},
  logs: [],
  error: null,
};
let pgCreated = false,
  rabbitCreated = false,
  admin,
  rabbit,
  catalogApp,
  taxonomyApp;
let stage = 'inicialización';
const docker = (...args) => {
  const r = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  if (r.status !== 0) {
    const detalle = String(r.stderr || r.error?.message || '')
      .replaceAll(password, '[redactado]')
      .replaceAll(catalogPass, '[redactado]')
      .replace(
        /(amqps?:\/\/|postgres(?:ql)?:\/\/)[^\s/@]+@/gi,
        '$1[redactado]@',
      )
      .slice(0, 1000);
    throw new Error(`docker ${args[0]} falló: ${detalle}`);
  }
  return r.stdout.trim();
};
const git = (...args) => {
  const r = spawnSync('git', args, {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error('git falló');
  return r.stdout.trim();
};
const wait = async (name, check, ms = 30000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Tiempo de espera agotado: ${name}`);
};
const portOf = (name, port) => {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(
    docker('port', name, `${port}/tcp`),
  );
  if (!match) throw new Error('Puerto fuera de loopback');
  return Number(match[1]);
};
const freePort = async () => {
  const server = createServer();
  await new Promise((r, j) =>
    server.listen(0, '127.0.0.1', r).once('error', j),
  );
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
};
const row = async (query, params = []) =>
  (await admin.query(query, params)).rows;
try {
  process.env.NODE_ENV = 'test';
  report.taxonomySha = git('rev-parse', 'HEAD');
  const docsRoot = docsCheckout();
  if (!docsRoot)
    throw new Error(
      'Falta un checkout Git de Docs con las migraciones normativas de Taxonomy y Catalog',
    );
  const docs = join(docsRoot, 'datos');
  report.docsSha = git(
    '-C',
    docsRoot,
    'rev-parse',
    'HEAD',
  );
  if (
    git(
      '-C',
      docsRoot,
      'status',
      '--porcelain',
      '--',
      'datos/taxonomy/migrations',
      'datos/catalog-svc/migrations',
    )
  )
    throw new Error('Las migraciones oficiales tienen cambios locales');
  report.catalogSha = git(
    'log',
    '-1',
    '--format=%H',
    'HEAD',
    '--',
    'apps/catalog-svc',
  );
  if (!report.catalogSha)
    throw new Error(
      'Falta historia de Catalog; ejecutar git fetch --unshallow',
    );
  report.taxonomyTree = git('rev-parse', 'HEAD:apps/taxonomy-svc/src');
  report.catalogTree = git('rev-parse', 'HEAD:apps/catalog-svc');
  const relevant = [
    'apps/taxonomy-svc/src',
    'apps/taxonomy-svc/migrations',
    'apps/taxonomy-svc/tsconfig.app.json',
    'apps/catalog-svc/src',
    'apps/catalog-svc/migrations',
    'apps/catalog-svc/tsconfig.app.json',
    'libs',
    'package.json',
    'package-lock.json',
    'nest-cli.json',
    'tsconfig.json',
    'tsconfig.build.json',
  ];
  if (git('status', '--porcelain', '--untracked-files=all', '--', ...relevant))
    throw new Error(
      'El código o configuración de compilación tiene cambios locales',
    );
  report.runnerSha256 = createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest('hex');
  report.runnerMatchesCommit =
    git('hash-object', fileURLToPath(import.meta.url)) ===
    git('rev-parse', 'HEAD:apps/taxonomy-svc/test/e2e-catalog/run.mjs');
  stage = 'Compilación desde el código verificado';
  const nest = createRequire(import.meta.url).resolve(
    '@nestjs/cli/bin/nest.js',
  );
  for (const service of ['taxonomy-svc', 'catalog-svc']) {
    const build = spawnSync(process.execPath, [nest, 'build', service], {
      encoding: 'utf8',
      timeout: 180000,
      windowsHide: true,
    });
    if (build.status !== 0)
      throw new Error(
        `Falló la compilación ${service}: ${(build.stderr || build.stdout).slice(-3000)}`,
      );
  }
  if (
    git('status', '--porcelain', '--untracked-files=all', '--', ...relevant) ||
    git('rev-parse', 'HEAD') !== report.taxonomySha
  )
    throw new Error('El código cambió durante la compilación');
  ({ iniciarTaxonomySvc } =
    await import('../../../../dist/apps/taxonomy-svc/bootstrap.js'));
  ({ DeactivationIntentService } =
    await import('../../../../dist/apps/taxonomy-svc/domain/deactivation-intent.service.js'));
  ({ TaxonomyAmqpRuntime } =
    await import('../../../../dist/apps/taxonomy-svc/domain/taxonomy-amqp.runtime.js'));
  ({ AppModule } =
    await import('../../../../dist/apps/catalog-svc/app.module.js'));
  ({ CatalogConfig } =
    await import('../../../../dist/apps/catalog-svc/config.js'));
  ({ CATALOG_AMQP_SETTINGS } =
    await import('../../../../dist/apps/catalog-svc/catalog-amqp.js'));
  ({ Database: CatalogDatabase } =
    await import('../../../../dist/apps/catalog-svc/database.js'));
  report.build = 'PASS';
  const openssl =
    process.env.TAXONOMY_TEST_OPENSSL_BIN ??
    (process.platform === 'win32'
      ? [
          'C:/Program Files/Git/ucrt64/bin/openssl.exe',
          'C:/Program Files/Git/mingw64/bin/openssl.exe',
          'C:/Program Files/Git/usr/bin/openssl.exe',
        ].find((candidate) => existsSync(candidate)) ?? 'openssl'
      : 'openssl');
  const certRun = spawnSync(
    openssl,
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
    ],
    { stdio: 'ignore', timeout: 30000, windowsHide: true },
  );
  if (certRun.status !== 0)
    throw new Error('No fue posible generar certificado TLS desechable');
  stage = 'PostgreSQL desechable';
  docker(
    'run',
    '-d',
    '--name',
    pgName,
    '--label',
    `g6.cross.session=${token}`,
    '-p',
    '127.0.0.1::5432',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    'POSTGRES_DB=cross_test',
    'postgres:17-alpine',
  );
  pgCreated = true;
  await wait('PostgreSQL', () => {
    try {
      return docker(
        'exec',
        pgName,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'postgres',
        '-d',
        'cross_test',
      ).includes('accepting connections');
    } catch {
      return false;
    }
  });
  stage = 'Instalación de certificado TLS';
  docker('cp', key, `${pgName}:/tmp/server.key`);
  docker('cp', cert, `${pgName}:/tmp/server.crt`);
  docker(
    'exec',
    '--user',
    'root',
    pgName,
    'sh',
    '-c',
    'mv /tmp/server.key /var/lib/postgresql/server.key && mv /tmp/server.crt /var/lib/postgresql/server.crt && chown postgres:postgres /var/lib/postgresql/server.key /var/lib/postgresql/server.crt && chmod 600 /var/lib/postgresql/server.key',
  );
  stage = 'Configuración de TLS PostgreSQL';
  for (const cmd of [
    "ALTER SYSTEM SET ssl = 'on'",
    "ALTER SYSTEM SET ssl_cert_file = '/var/lib/postgresql/server.crt'",
    "ALTER SYSTEM SET ssl_key_file = '/var/lib/postgresql/server.key'",
  ])
    docker(
      'exec',
      pgName,
      'psql',
      '-U',
      'postgres',
      '-d',
      'cross_test',
      '-c',
      cmd,
    );
  stage = 'Reinicio de PostgreSQL con TLS';
  docker('restart', pgName);
  await wait('PostgreSQL TLS', () => {
    try {
      return docker(
        'exec',
        pgName,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'postgres',
        '-d',
        'cross_test',
      ).includes('accepting connections');
    } catch {
      return false;
    }
  });
  const pgPort = portOf(pgName, 5432),
    ca = readFileSync(cert, 'utf8');
  admin = new pg.Pool({
    host: '127.0.0.1',
    port: pgPort,
    user: 'postgres',
    password,
    database: 'cross_test',
    ssl: { ca, rejectUnauthorized: true, servername: 'localhost' },
    max: 3,
  });
  await admin.query(
    `CREATE ROLE po_catalog_owner NOLOGIN; CREATE ROLE po_taxonomy_owner NOLOGIN; CREATE ROLE catalog_app LOGIN PASSWORD '${password}'; CREATE ROLE taxonomy_app LOGIN PASSWORD '${password}'; CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner; CREATE SCHEMA taxonomy AUTHORIZATION po_taxonomy_owner; CREATE EXTENSION IF NOT EXISTS pgcrypto;`,
  );
  stage = 'Migraciones oficiales aisladas';
  const migrate = async (owner, paths) => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL ROLE ${owner}`);
      for (const p of paths) await c.query(readFileSync(p, 'utf8'));
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  };
  await migrate('po_taxonomy_owner', [
    join(docs, 'taxonomy/migrations/0001_create_taxonomy.sql'),
    resolve(
      'apps/taxonomy-svc/migrations/0002_deactivation_source_version.sql',
    ),
    resolve(
      'apps/taxonomy-svc/migrations/0003_deactivation_timeout_setting.sql',
    ),
    resolve(
      'apps/taxonomy-svc/migrations/0004_product_type_pending_version.sql',
    ),
    resolve('apps/taxonomy-svc/migrations/0005_configurable_list_values.sql'),
  ]);
  await migrate('po_catalog_owner', [
    join(docs, 'catalog-svc/migrations/0001_create_catalog.sql'),
    resolve('apps/catalog-svc/migrations/0002_create_sku_barcodes.sql'),
    resolve('apps/catalog-svc/migrations/0003_product_publication_history.sql'),
  ]);
  stage = 'RabbitMQ desechable';
  docker(
    'run',
    '-d',
    '--name',
    rabbitName,
    '--label',
    `g6.cross.session=${token}`,
    '-p',
    '127.0.0.1::5672',
    '-e',
    'RABBITMQ_DEFAULT_USER=taxonomy_test',
    '-e',
    `RABBITMQ_DEFAULT_PASS=${password}`,
    '-e',
    'RABBITMQ_DEFAULT_VHOST=g6-productos-ofertas',
    '-e',
    'RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS=+S 2:2 +SDcpu 1 +SDio 1',
    '-e',
    'RABBITMQ_CTL_ERL_ARGS=+S 1:1 +SDcpu 1 +SDio 1',
    'rabbitmq:4.2.9-alpine',
  );
  rabbitCreated = true;
  await wait(
    'RabbitMQ',
    () => {
      try {
        docker(
          'exec',
          '--user',
          'rabbitmq',
          rabbitName,
          'rabbitmq-diagnostics',
          '-q',
          'check_running',
        );
        return true;
      } catch {
        return false;
      }
    },
    60000,
  );
  docker(
    'exec',
    '--user',
    'rabbitmq',
    rabbitName,
    'rabbitmqctl',
    'add_user',
    'catalog_test',
    catalogPass,
  );
  docker(
    'exec',
    '--user',
    'rabbitmq',
    rabbitName,
    'rabbitmqctl',
    'set_permissions',
    '-p',
    'g6-productos-ofertas',
    'catalog_test',
    '.*',
    '.*',
    '.*',
  );
  const rabbitPort = portOf(rabbitName, 5672),
    base = `127.0.0.1:${rabbitPort}/g6-productos-ofertas`;
  const taxonomyUrl = `amqp://taxonomy_test:${password}@${base}`,
    catalogUrl = `amqp://catalog_test:${catalogPass}@${base}`;
  rabbit = await connect(taxonomyUrl);
  const ch = await rabbit.createChannel();
  for (const exchange of ['po.comandos.x', 'po.eventos.x', 'po.resultados.x'])
    await ch.assertExchange(exchange, 'topic', { durable: true });
  for (const q of ['po.catalogo.q', 'po.taxonomia.q', 'cross.audit.q'])
    await ch.assertQueue(q, { durable: true });
  for (const [q, x, k] of [
    [
      'po.catalogo.q',
      'po.comandos.x',
      'taxonomy.master.deactivation.check.requested',
    ],
    ['po.catalogo.q', 'po.eventos.x', 'taxonomy.master.deactivated'],
    [
      'po.catalogo.q',
      'po.resultados.x',
      'taxonomy.master.deactivation.rejected',
    ],
    [
      'po.taxonomia.q',
      'po.resultados.x',
      'catalog.master.deactivation.checked',
    ],
    ['cross.audit.q', 'po.resultados.x', 'catalog.master.deactivation.checked'],
  ])
    await ch.bindQueue(q, x, k);
  stage = 'Arranque servicios reales';
  const common = {
    NODE_ENV: 'test',
    PGHOST: 'localhost',
    G6_CONNECT_HOST: '127.0.0.1',
    PGPORT: String(pgPort),
    PGDATABASE: 'cross_test',
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: cert,
    G6_CONNECTION_MODE: 'direct',
  };
  const taxEnv = {
    ...common,
    PGUSER: 'taxonomy_app',
    PGPASSWORD: password,
    G6_EXPECTED_ROLE: 'taxonomy_app',
    G6_DATABASE_SCHEMA: 'taxonomy',
    PORT: String(await freePort()),
    RABBITMQ_URL: taxonomyUrl,
    TAXONOMY_CATALOG_AMQP_USER: 'catalog_test',
  };
  const catEnv = {
    ...common,
    PGUSER: 'catalog_app',
    PGPASSWORD: password,
    G6_EXPECTED_ROLE: 'catalog_app',
    G6_DATABASE_SCHEMA: 'catalog',
    CATALOG_AMQP_ENABLED: 'true',
    PORT: String(await freePort()),
    RABBITMQ_URL: catalogUrl,
    CATALOG_AMQP_PRODUCER_USERS: JSON.stringify({
      'taxonomy-svc': 'taxonomy_test',
      'inventory-svc': 'inventory_test',
      'pricing-svc': 'pricing_test',
      'bulk-svc': 'bulk_test',
    }),
  };
  const config = new CatalogConfig(catEnv);
  const module = await Test.createTestingModule({
    imports: [AppModule.forRoot(config)],
  })
    .overrideProvider(CATALOG_AMQP_SETTINGS)
    .useValue({ ...config.amqp, isolatedTestRecovery: true })
    .compile();
  catalogApp = module.createNestApplication();
  await catalogApp.get(CatalogDatabase).verifyIdentity();
  await catalogApp.listen(0, '127.0.0.1');
  taxonomyApp = (await iniciarTaxonomySvc({ env: taxEnv })).app;
  const runtime = () => taxonomyApp.get(TaxonomyAmqpRuntime),
    intents = () => taxonomyApp.get(DeactivationIntentService);
  await wait('consumer Taxonomy', () => runtime().disponible());
  await wait(
    'consumer Catalog',
    async () => (await ch.checkQueue('po.catalogo.q')).consumerCount === 1,
  );
  const ids = {
      clear: randomUUID(),
      inUse: randomUUID(),
      recover: randomUUID(),
      categoryClear: randomUUID(),
      categoryInUse: randomUUID(),
    },
    operations = {
      clear: randomUUID(),
      inUse: randomUUID(),
      recover: randomUUID(),
      categoryClear: randomUUID(),
      categoryInUse: randomUUID(),
    };
  report.operaciones = operations;
  report.entidades = ids;
  for (const name of ['clear', 'inUse', 'recover'])
    await admin.query('INSERT INTO taxonomy.brands(id,nombre) VALUES ($1,$2)', [
      ids[name],
      `E2E ${name} ${token}`,
    ]);
  for (const name of ['categoryClear', 'categoryInUse'])
    await admin.query(
      'INSERT INTO taxonomy.categories(id,nombre,nivel) VALUES ($1,$2,1)',
      [ids[name], `E2E ${name} ${token}`],
    );
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    const productId = randomUUID();
    await c.query(
      `INSERT INTO catalog.products(id,nombre,descripcion,categoria_id,tipo_producto_id,marca_id,sku_base,slug,tiene_variantes) VALUES($1,'E2E','E2E',$5,'type-e2e',$2,$3,$4,false)`,
      [
        productId,
        ids.inUse,
        `sku-${token}`,
        `slug-${token}`,
        ids.categoryInUse,
      ],
    );
    await c.query(
      "INSERT INTO catalog.product_images(product_id,url,principal) VALUES($1,'https://example.test/e2e',true)",
      [productId],
    );
    await c.query(
      'INSERT INTO catalog.sku_physical_profiles(sku_identity_id,peso_kg,largo_cm,ancho_cm,alto_cm) SELECT id,1,1,1,1 FROM catalog.sku_identity WHERE product_id=$1',
      [productId],
    );
    for (const dependency of ['PRICING', 'INVENTORY'])
      await c.query(
        "INSERT INTO catalog.activation_checks(product_id,sku,dependency,operation_id,correlation_id,request_payload,state,result_payload,result_message_id) VALUES($1,$2,$3,$4,$5,'{}','COMPLETED','{}',$6)",
        [
          productId,
          `sku-${token}`,
          dependency,
          randomUUID(),
          randomUUID(),
          randomUUID(),
        ],
      );
    await c.query("UPDATE catalog.products SET estado='ACTIVO' WHERE id=$1", [
      productId,
    ]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  const start = async (name) => {
    const correlationId = randomUUID();
    assert.equal(
      await intents().registrar({
        operationId: operations[name],
        correlationId,
        entityType: name.startsWith('category') ? 'CATEGORY' : 'BRAND',
        entityId: ids[name],
        version: 0,
      }),
      'REGISTRADA',
    );
    return correlationId;
  };
  const status = async (name) =>
    (
      await row(
        'SELECT status,reason FROM taxonomy.master_deactivation_operations WHERE operation_id=$1',
        [operations[name]],
      )
    )[0];
  for (const entityType of ['BRAND', 'CATEGORY']) {
    stage = `Correlación incorrecta ${entityType}`;
    const entityId = randomUUID(),
      operationId = randomUUID(),
      correlationId = randomUUID();
    const table = entityType === 'BRAND' ? 'brands' : 'categories';
    await admin.query(
      `INSERT INTO taxonomy.${table}(id,nombre) VALUES($1,$2)`,
      [entityId, `E2E causal ${entityType} ${token}`],
    );
    await admin.query('REVOKE INSERT ON taxonomy.inbox FROM taxonomy_app');
    assert.equal(
      await intents().registrar({
        operationId,
        correlationId,
        entityType,
        entityId,
        version: 0,
      }),
      'REGISTRADA',
    );
    await wait(
      `barrera ${entityType} y pausa`,
      async () =>
        !runtime().disponible() &&
        (
          await row(
            'SELECT is_blocking FROM catalog.master_barriers WHERE operation_id=$1',
            [operationId],
          )
        )[0]?.is_blocking === true,
    );
    const checked = (
      await row(
        "SELECT message_id, causation_id, payload FROM catalog.outbox WHERE operation_id=$1 AND event_name='catalog.master.deactivation.checked'",
        [operationId],
      )
    )[0];
    assert.ok(checked);
    const wrong = randomUUID(),
      badFinalId = randomUUID();
    const wrongFinal = {
      message_id: badFinalId,
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      correlation_id: wrong,
      operation_id: operationId,
      producer: 'taxonomy-svc',
      kind: 'event',
      name: 'taxonomy.master.deactivated',
      data: { entity_type: entityType, entity_id: entityId, version: 0 },
    };
    ch.publish(
      'po.eventos.x',
      wrongFinal.name,
      Buffer.from(JSON.stringify(wrongFinal)),
      {
        persistent: true,
        contentType: 'application/json',
        userId: 'taxonomy_test',
        messageId: badFinalId,
        correlationId: wrong,
      },
    );
    await wait(
      'Catalog registra STALE',
      async () =>
        (
          await row('SELECT result FROM catalog.inbox WHERE message_id=$1', [
            badFinalId,
          ])
        )[0]?.result === 'STALE',
    );
    assert.equal(
      (
        await row(
          'SELECT is_blocking FROM catalog.master_barriers WHERE operation_id=$1',
          [operationId],
        )
      )[0].is_blocking,
      true,
    );
    assert.equal(
      (
        await row(
          'SELECT count(*)::int AS n FROM catalog.outbox WHERE operation_id=$1',
          [operationId],
        )
      )[0].n,
      1,
    );
    await taxonomyApp.close();
    taxonomyApp = undefined;
    await wait(
      'respuesta legítima disponible',
      async () => (await ch.checkQueue('po.taxonomia.q')).messageCount >= 1,
    );
    const originalChecked = await ch.get('po.taxonomia.q', { noAck: false });
    assert.equal(
      JSON.parse(originalChecked.content.toString()).operation_id,
      operationId,
    );
    await admin.query('GRANT INSERT ON taxonomy.inbox TO taxonomy_app');
    const invalidId = randomUUID();
    const invalidChecked = {
      message_id: invalidId,
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      correlation_id: wrong,
      causation_id: checked.causation_id,
      operation_id: operationId,
      producer: 'catalog-svc',
      kind: 'result',
      name: 'catalog.master.deactivation.checked',
      data: checked.payload,
    };
    const catalogConnection = await connect(catalogUrl),
      publisher = await catalogConnection.createConfirmChannel();
    await new Promise((resolve, reject) =>
      publisher.publish(
        'po.resultados.x',
        invalidChecked.name,
        Buffer.from(JSON.stringify(invalidChecked)),
        {
          persistent: true,
          contentType: 'application/json',
          userId: 'catalog_test',
          messageId: invalidId,
          correlationId: wrong,
        },
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    taxonomyApp = (await iniciarTaxonomySvc({ env: taxEnv })).app;
    await wait(
      'Taxonomy ignora correlación incorrecta',
      async () =>
        (
          await row('SELECT result FROM taxonomy.inbox WHERE message_id=$1', [
            invalidId,
          ])
        )[0]?.result === 'IGNORED',
    );
    assert.equal(
      (
        await row(
          'SELECT status FROM taxonomy.master_deactivation_operations WHERE operation_id=$1',
          [operationId],
        )
      )[0].status,
      'IN_PROGRESS',
    );
    assert.equal(
      (
        await row(`SELECT estado FROM taxonomy.${table} WHERE id=$1`, [
          entityId,
        ])
      )[0].estado,
      'PENDING_DEACTIVATION',
    );
    assert.equal(
      (
        await row(
          'SELECT is_blocking FROM catalog.master_barriers WHERE operation_id=$1',
          [operationId],
        )
      )[0].is_blocking,
      true,
    );
    assert.equal(
      (
        await row(
          "SELECT count(*)::int AS n FROM taxonomy.outbox WHERE operation_id=$1 AND event_name IN ('taxonomy.master.deactivated','taxonomy.master.deactivation.rejected')",
          [operationId],
        )
      )[0].n,
      0,
    );
    ch.nack(originalChecked, false, true);
    await wait(
      'resultado legítimo procesado',
      async () =>
        (
          await row(
            'SELECT status FROM taxonomy.master_deactivation_operations WHERE operation_id=$1',
            [operationId],
          )
        )[0]?.status === 'COMPLETED',
    );
    await wait(
      'barrera liberada por resultado legítimo',
      async () =>
        (
          await row(
            'SELECT is_blocking FROM catalog.master_barriers WHERE operation_id=$1',
            [operationId],
          )
        )[0]?.is_blocking === false,
    );
    await new Promise((resolve, reject) =>
      publisher.publish(
        'po.resultados.x',
        'catalog.master.deactivation.checked',
        originalChecked.content,
        {
          persistent: true,
          contentType: 'application/json',
          userId: 'catalog_test',
          messageId: originalChecked.properties.messageId,
          correlationId: originalChecked.properties.correlationId,
        },
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    await wait(
      'duplicado consumido',
      async () => (await ch.checkQueue('po.taxonomia.q')).messageCount === 0,
    );
    assert.equal(
      (
        await row(
          'SELECT count(*)::int AS n FROM taxonomy.inbox WHERE message_id=$1',
          [originalChecked.properties.messageId],
        )
      )[0].n,
      1,
    );
    assert.equal(
      (
        await row(
          "SELECT count(*)::int AS n FROM taxonomy.outbox WHERE operation_id=$1 AND event_name='taxonomy.master.deactivated'",
          [operationId],
        )
      )[0].n,
      1,
    );
    report.scenarios[`CORRELACION_${entityType}`] = {
      operation_id: operationId,
      entity_id: entityId,
      catalogo: 'STALE',
      taxonomy: 'IGNORED',
      barrera_antes: true,
      barrera_final: false,
      estado_final: 'COMPLETED',
      duplicado_inbox: 1,
      taxonomy_db: {
        operacion: (
          await row(
            'SELECT status, reason, source_version FROM taxonomy.master_deactivation_operations WHERE operation_id=$1',
            [operationId],
          )
        )[0],
        entidad: (
          await row(
            `SELECT estado, taxonomy_version FROM taxonomy.${table} WHERE id=$1`,
            [entityId],
          )
        )[0],
        inbox: await row(
          'SELECT message_id, result FROM taxonomy.inbox WHERE message_id = ANY($1::uuid[]) ORDER BY message_id',
          [[invalidId, originalChecked.properties.messageId]],
        ),
        outbox: await row(
          'SELECT event_name, published_at IS NOT NULL AS publicado FROM taxonomy.outbox WHERE operation_id=$1 ORDER BY event_name',
          [operationId],
        ),
      },
      catalog_db: {
        barrera: (
          await row(
            'SELECT master_type, is_blocking, source_version FROM catalog.master_barriers WHERE operation_id=$1',
            [operationId],
          )
        )[0],
        inbox: await row(
          'SELECT event_name, result FROM catalog.inbox WHERE operation_id=$1 ORDER BY event_name, result',
          [operationId],
        ),
        outbox: await row(
          'SELECT event_name, published_at IS NOT NULL AS publicado FROM catalog.outbox WHERE operation_id=$1 ORDER BY event_name',
          [operationId],
        ),
      },
    };
    await catalogConnection.close();
  }
  stage = 'CLEAR real';
  await start('clear');
  await wait(
    'CLEAR',
    async () => (await status('clear'))?.status === 'COMPLETED',
  );
  await wait(
    'CLEAR outbox Catalog',
    async () =>
      (
        await row(
          "SELECT published_at FROM catalog.outbox WHERE operation_id=$1 AND event_name='catalog.master.deactivation.checked'",
          [operations.clear],
        )
      )[0]?.published_at != null,
  );
  const clearResponse = (
    await row(
      "SELECT payload->>'result' AS result FROM catalog.outbox WHERE operation_id=$1 AND event_name='catalog.master.deactivation.checked'",
      [operations.clear],
    )
  )[0];
  assert.equal(clearResponse?.result, 'CLEAR');
  const clear = await status('clear');
  assert.equal(
    (
      await row('SELECT estado FROM taxonomy.brands WHERE id=$1', [ids.clear])
    )[0].estado,
    'INACTIVO',
  );
  report.scenarios.CLEAR = clear;
  stage = 'IN_USE real';
  await start('inUse');
  await wait(
    'IN_USE',
    async () => (await status('inUse'))?.status === 'REJECTED',
  );
  const inUseResponse = (
    await row(
      "SELECT payload->>'result' AS result FROM catalog.outbox WHERE operation_id=$1 AND event_name='catalog.master.deactivation.checked'",
      [operations.inUse],
    )
  )[0];
  assert.equal(inUseResponse?.result, 'IN_USE');
  const inUse = await status('inUse');
  assert.equal(inUse.reason, 'IN_USE');
  assert.equal(
    (
      await row('SELECT estado FROM taxonomy.brands WHERE id=$1', [ids.inUse])
    )[0].estado,
    'ACTIVO',
  );
  report.scenarios.IN_USE = inUse;
  for (const [name, expected, outcome] of [
    ['categoryClear', 'COMPLETED', 'CLEAR'],
    ['categoryInUse', 'REJECTED', 'IN_USE'],
  ]) {
    stage = `CATEGORY ${outcome} real`;
    await start(name);
    await wait(
      `CATEGORY ${outcome}`,
      async () => (await status(name))?.status === expected,
    );
    const response = (
      await row(
        "SELECT payload->>'result' AS result FROM catalog.outbox WHERE operation_id=$1 AND event_name='catalog.master.deactivation.checked'",
        [operations[name]],
      )
    )[0];
    assert.equal(response?.result, outcome);
    const estado = (
      await row('SELECT estado FROM taxonomy.categories WHERE id=$1', [
        ids[name],
      ])
    )[0].estado;
    assert.equal(estado, outcome === 'CLEAR' ? 'INACTIVO' : 'ACTIVO');
    report.scenarios[`CATEGORY_${outcome}`] = {
      status: expected,
      resultado: response.result,
      estado,
    };
  }
  for (const entityType of [
    'PRODUCT_TYPE',
    'CHARACTERISTIC_VALUE',
    'PRODUCT_TYPE_CHARACTERISTIC',
  ]) {
    for (const outcome of ['CLEAR', 'IN_USE']) {
      stage = `${entityType} ${outcome} real`;
      const typeId = randomUUID(),
        characteristicId = randomUUID(),
        valueId = randomUUID(),
        associationId = randomUUID(),
        operationId = randomUUID(),
        correlationId = randomUUID();
      await admin.query(
        'INSERT INTO taxonomy.product_types(id,nombre) VALUES($1,$2)',
        [typeId, `type-${typeId}`],
      );
      await admin.query(
        "INSERT INTO taxonomy.characteristics(id,nombre,tipo) VALUES($1,$2,'LISTA')",
        [characteristicId, `characteristic-${characteristicId}`],
      );
      await admin.query(
        "INSERT INTO taxonomy.characteristic_values(id,caracteristica_id,nombre) VALUES($1,$2,'valor')",
        [valueId, characteristicId],
      );
      await admin.query(
        'INSERT INTO taxonomy.product_type_characteristics(id,tipo_producto_id,caracteristica_id) VALUES($1,$2,$3)',
        [associationId, typeId, characteristicId],
      );
      const product = (
        await row('SELECT id FROM catalog.products WHERE marca_id=$1', [
          ids.inUse,
        ])
      )[0];
      if (outcome === 'IN_USE') {
        await admin.query(
          'UPDATE catalog.products SET tipo_producto_id=$1 WHERE id=$2',
          [typeId, product.id],
        );
        await admin.query(
          "INSERT INTO catalog.product_attribute_values(product_id,caracteristica_id,nombre_snapshot,valor_id,valor) VALUES($1,$2,'valor',$3,'{}'::jsonb)",
          [product.id, characteristicId, valueId],
        );
      }
      const entityId =
        entityType === 'PRODUCT_TYPE'
          ? typeId
          : entityType === 'CHARACTERISTIC_VALUE'
            ? valueId
            : associationId;
      const version =
        entityType === 'PRODUCT_TYPE_CHARACTERISTIC'
          ? Number(
              (
                await row(
                  'SELECT schema_version FROM taxonomy.product_types WHERE id=$1',
                  [typeId],
                )
              )[0].schema_version,
            )
          : 0;
      assert.equal(
        await intents().registrar({
          operationId,
          correlationId,
          entityType,
          entityId,
          version,
          ...(entityType === 'PRODUCT_TYPE_CHARACTERISTIC'
            ? { tipoProductoId: typeId, caracteristicaId: characteristicId }
            : {}),
        }),
        'REGISTRADA',
      );
      const expected = outcome === 'CLEAR' ? 'COMPLETED' : 'REJECTED';
      await wait(
        stage,
        async () =>
          (
            await row(
              'SELECT status FROM taxonomy.master_deactivation_operations WHERE operation_id=$1',
              [operationId],
            )
          )[0]?.status === expected,
      );
      const checked = (
        await row(
          "SELECT payload->>'result' AS result FROM catalog.outbox WHERE operation_id=$1 AND event_name='catalog.master.deactivation.checked'",
          [operationId],
        )
      )[0];
      assert.equal(checked?.result, outcome);
      const table =
        entityType === 'PRODUCT_TYPE'
          ? 'product_types'
          : entityType === 'CHARACTERISTIC_VALUE'
            ? 'characteristic_values'
            : 'product_type_characteristics';
      const state = (
        await row(`SELECT estado FROM taxonomy.${table} WHERE id=$1`, [
          entityId,
        ])
      )[0].estado;
      assert.equal(state, outcome === 'CLEAR' ? 'INACTIVO' : 'ACTIVO');
      await wait(
        `liberación de barrera ${entityType} ${outcome}`,
        async () =>
          (
            await row(
              'SELECT is_blocking FROM catalog.master_barriers WHERE operation_id=$1',
              [operationId],
            )
          )[0]?.is_blocking === false,
      );
      report.scenarios[`${entityType}_${outcome}`] = {
        operationId,
        entityId,
        status: expected,
        resultado: checked.result,
        estado: state,
        taxonomyInbox: await row(
          "SELECT event_name, result FROM taxonomy.inbox WHERE payload->>'operation_id'=$1",
          [operationId],
        ),
        taxonomyOutbox: await row(
          'SELECT event_name, published_at IS NOT NULL AS publicado FROM taxonomy.outbox WHERE operation_id=$1 ORDER BY occurred_at',
          [operationId],
        ),
        catalogInbox: await row(
          'SELECT event_name, result FROM catalog.inbox WHERE operation_id=$1',
          [operationId],
        ),
        catalogBarrier: (
          await row(
            'SELECT is_blocking, source_version FROM catalog.master_barriers WHERE operation_id=$1',
            [operationId],
          )
        )[0],
      };
    }
  }
  stage = 'Duplicado real';
  let original;
  await wait('copia de evento real Catalog', async () => {
    const m = await ch.get('cross.audit.q', { noAck: true });
    if (!m) return false;
    const body = JSON.parse(m.content.toString());
    if (body.operation_id === operations.clear) {
      original = m;
      return true;
    }
    return false;
  });
  const cat = await connect(catalogUrl),
    cc = await cat.createConfirmChannel();
  await new Promise((resolve, reject) =>
    cc.publish(
      'po.resultados.x',
      'catalog.master.deactivation.checked',
      original.content,
      {
        persistent: true,
        contentType: 'application/json',
        userId: 'catalog_test',
        messageId: original.properties.messageId,
        correlationId: original.properties.correlationId,
      },
      (e) => (e ? reject(e) : resolve()),
    ),
  );
  await wait('ACK duplicado', () => {
    const queues = docker(
      'exec',
      '--user',
      'rabbitmq',
      rabbitName,
      'rabbitmqctl',
      '-q',
      'list_queues',
      '-p',
      'g6-productos-ofertas',
      'name',
      'messages',
    );
    const line = queues
      .split('\n')
      .find((value) => value.startsWith('po.taxonomia.q\t'));
    return Boolean(line && /^po\.taxonomia\.q\s+0\s*$/.test(line));
  });
  const dup = await row(
    'SELECT count(*)::int AS n FROM taxonomy.inbox WHERE message_id=$1',
    [original.properties.messageId],
  );
  const finals = await row(
    "SELECT count(*)::int AS n FROM taxonomy.outbox WHERE operation_id=$1 AND event_name='taxonomy.master.deactivated'",
    [operations.clear],
  );
  assert.equal(dup[0].n, 1);
  assert.equal(finals[0].n, 1);
  report.scenarios.duplicado = { inbox: dup[0].n, resultados: finals[0].n };
  await cat.close();
  stage = 'Fallo y reentrega';
  await admin.query('REVOKE INSERT ON taxonomy.inbox FROM taxonomy_app');
  await start('recover');
  await wait('pausa consumidor', () => !runtime().disponible());
  assert.equal((await status('recover')).status, 'IN_PROGRESS');
  const recoveryMessage = (
    await row(
      "SELECT message_id FROM catalog.outbox WHERE operation_id=$1 AND event_name='catalog.master.deactivation.checked'",
      [operations.recover],
    )
  )[0];
  assert.ok(recoveryMessage);
  assert.equal(
    (
      await row(
        'SELECT count(*)::int AS n FROM taxonomy.inbox WHERE message_id=$1',
        [recoveryMessage.message_id],
      )
    )[0].n,
    0,
  );
  await taxonomyApp.close();
  taxonomyApp = undefined;
  await wait(
    'mensaje sin ACK retornado',
    async () => (await ch.checkQueue('po.taxonomia.q')).messageCount >= 1,
  );
  await admin.query('GRANT INSERT ON taxonomy.inbox TO taxonomy_app');
  taxonomyApp = (await iniciarTaxonomySvc({ env: taxEnv })).app;
  await wait(
    'recuperación tras reinicio',
    async () => (await status('recover')).status === 'COMPLETED',
  );
  const recoveryInbox = (
    await row(
      "SELECT count(*)::int AS n FROM taxonomy.inbox WHERE payload->>'operation_id'=$1 AND result='PROCESSED'",
      [operations.recover],
    )
  )[0].n;
  assert.equal(recoveryInbox, 1);
  report.scenarios.reentrega = {
    status: (await status('recover')).status,
    inbox: recoveryInbox,
    message_id: recoveryMessage.message_id,
    pausa_sin_inbox: true,
    retornado_sin_ack: true,
  };
  stage = 'Esperar eventos terminales y barreras de Catalog';
  await wait(
    'publicación de todos los resultados terminales',
    async () =>
      (
        await row(
          "SELECT count(*)::int AS n FROM taxonomy.outbox WHERE operation_id=ANY($1::uuid[]) AND event_name IN ('taxonomy.master.deactivated','taxonomy.master.deactivation.rejected') AND published_at IS NOT NULL",
          [Object.values(operations)],
        )
      )[0].n === Object.keys(operations).length,
  );
  await wait(
    'liberación de todas las barreras de Catalog',
    async () =>
      (
        await row(
          'SELECT count(*)::int AS n FROM catalog.master_barriers WHERE operation_id=ANY($1::uuid[]) AND is_blocking=false',
          [Object.values(operations)],
        )
      )[0].n === Object.keys(operations).length,
  );
  stage = 'Estados finales';
  report.finalState.taxonomy = await row(
    "SELECT o.operation_id,o.entity_type,o.status,o.reason,COALESCE(b.estado::text,c.estado::text) AS estado,COALESCE(b.taxonomy_version,c.taxonomy_version) AS taxonomy_version FROM taxonomy.master_deactivation_operations o LEFT JOIN taxonomy.brands b ON o.entity_type='BRAND' AND b.id=o.entity_id LEFT JOIN taxonomy.categories c ON o.entity_type='CATEGORY' AND c.id=o.entity_id WHERE o.operation_id = ANY($1::uuid[]) ORDER BY o.operation_id",
    [Object.values(operations)],
  );
  report.finalState.catalog = await row(
    'SELECT operation_id,master_type,is_blocking FROM catalog.master_barriers WHERE operation_id = ANY($1::uuid[]) ORDER BY operation_id',
    [Object.values(operations)],
  );
  report.finalState.taxonomyOutbox = await row(
    'SELECT operation_id,event_name,published_at IS NOT NULL AS publicado,attempts FROM taxonomy.outbox WHERE operation_id = ANY($1::uuid[]) ORDER BY operation_id,occurred_at',
    [Object.values(operations)],
  );
  report.finalState.catalogOutbox = await row(
    'SELECT operation_id,event_name,published_at IS NOT NULL AS publicado FROM catalog.outbox WHERE operation_id = ANY($1::uuid[]) ORDER BY operation_id',
    [Object.values(operations)],
  );
  report.finalState.taxonomyInbox = await row(
    "SELECT payload->>'operation_id' AS operation_id,message_id,event_name,result FROM taxonomy.inbox WHERE payload->>'operation_id'=ANY($1::text[]) ORDER BY operation_id",
    [Object.values(operations)],
  );
  report.finalState.catalogInbox = await row(
    'SELECT operation_id,event_name,result FROM catalog.inbox WHERE operation_id = ANY($1::uuid[]) ORDER BY operation_id,event_name',
    [Object.values(operations)],
  );
  assert.equal(
    report.finalState.taxonomyInbox.length,
    Object.keys(operations).length,
  );
  assert.equal(
    report.finalState.catalog.length,
    Object.keys(operations).length,
  );
  assert.ok(report.finalState.catalog.every((b) => b.is_blocking === false));
  report.result = 'PASS';
} catch (error) {
  report.result = 'FAIL';
  report.error = {
    stage,
    message: error instanceof Error ? error.message : 'Fallo desconocido',
  };
  process.exitCode = 1;
} finally {
  if (admin)
    await admin
      .query('GRANT INSERT ON taxonomy.inbox TO taxonomy_app')
      .catch(() => undefined);
  await taxonomyApp?.close().catch(() => undefined);
  await catalogApp?.close().catch(() => undefined);
  await rabbit?.close().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  if (rabbitCreated)
    try {
      docker('rm', '-f', rabbitName);
    } catch {
      report.logs.push('No se pudo eliminar RabbitMQ desechable');
    }
  if (pgCreated)
    try {
      docker('rm', '-f', pgName);
    } catch {
      report.logs.push('No se pudo eliminar PostgreSQL desechable');
    }
  for (const f of [key, cert])
    try {
      unlinkSync(f);
    } catch {}
  try {
    rmdirSync(tmp);
  } catch {}
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
