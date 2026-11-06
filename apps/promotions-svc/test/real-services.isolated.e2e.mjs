// Real, immutable provider processes. All infrastructure is created by this run.
// No .env loading, shared URLs, production provider edits, demo flags or mocks.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomUUID, sign } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  assertLiveness,
  assertReaderDeadline,
} from './support/real-services-assertions.mjs';
import pg from 'pg';
import amqp from 'amqplib';
import {
  officialMigrations,
  docsRevision as promotionsSqlRevision,
} from './support/official-migrations.mjs';

const master = '7f1ffc1f1f490861ef55ed3d84757d05954a2d33';
const docs = '80f208978c2c703e2b2d62064112365e7b9e1677';
let runtime =
  process.env.G6_TEST_RUNTIME_IMAGE ??
  'g6-promotions-real-test-runtime:7f1ffc1';
const openssl =
  process.env.G6_TEST_OPENSSL ??
  (process.platform === 'win32' &&
  process.env.LOCALAPPDATA &&
  existsSync(join(process.env.LOCALAPPDATA, 'Programs/Git/usr/bin/openssl.exe'))
    ? join(process.env.LOCALAPPDATA, 'Programs/Git/usr/bin/openssl.exe')
    : 'openssl');
const execFileAsync = promisify(execFile);
const root = process.cwd(),
  cache = resolve('node_modules/.cache/promotions-work');
const source = join(cache, 'real-svc-7f1ffc1');
const support = resolve('apps/promotions-svc/test/support');
const directory = mkdtempSync(join(tmpdir(), 'g6-cueva-real-'));
const password = randomUUID(),
  secret = randomUUID();
const network = 'g6-cueva-real-' + randomUUID();
const containers = [],
  apps = new Map(),
  ports = new Map();
const evidence = {
  master,
  promotions: {},
  docs,
  promotionsSqlRevision,
  runtime,
  startedAt: new Date().toISOString(),
  isolation:
    'Docker internal network; only random loopback ports; PostgreSQL TLS verify-full; unique restricted logins; no shared configuration',
  migrations: [],
  checks: [],
  blockers: [],
};
const output = resolve(
  'apps/promotions-svc/test/evidence/marketplace-real-2026-11-04.json',
);
let admin,
  broker,
  accessId,
  networkCreated = false,
  stage = 'source verification';
const safe = (value) =>
  String(value)
    .replaceAll(password, '[REDACTED]')
    .replaceAll(secret, '[REDACTED]')
    .replace(/Bearer [\w.-]+/g, 'Bearer [REDACTED]');
function execute(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 90000,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}
function docker(args, env = {}) {
  return execute('docker', args, { env: { ...process.env, ...env } });
}
function git(args) {
  return execute('git', args, { cwd: root });
}
function blob(bytes) {
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}
function consumerSources() {
  return Object.fromEntries(
    git(['ls-files', '--', 'apps/promotions-svc/src'])
      .split('\n')
      .filter(Boolean)
      .map((path) => [
        path,
        createHash('sha256')
          .update(readFileSync(resolve(path)))
          .digest('hex'),
      ]),
  );
}
function verifySource() {
  const entries = git([
    'ls-tree',
    '-r',
    master,
    '--',
    'apps',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'nest-cli.json',
    'Dockerfile.service',
    '.dockerignore',
    'ops/oracle',
  ]).split('\n');
  for (const entry of entries) {
    const match = /^\d+ blob ([a-f0-9]+)\t(.+)$/.exec(entry);
    if (match)
      assert.equal(
        blob(readFileSync(join(source, match[2]))),
        match[1],
        'SOURCE_CHANGED: ' + match[2],
      );
  }
  assert.deepEqual(
    consumerSources(),
    evidence.promotions.sourceSha256,
    'current consumer source changed during test',
  );
  assert.ok(!existsSync(join(source, '.env')));
  for (const name of [
    'catalog',
    'pricing',
    'inventory',
    'taxonomy',
    'promotions',
  ])
    assert.ok(!existsSync(join(source, `apps/${name}-svc/.env.local`)));
}
async function waitFor(operation, attempts = 100) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      last = error;
      await delay(400);
    }
  }
  throw last;
}
function published(id, port) {
  return Number(
    JSON.parse(
      docker(['inspect', id, '--format', '{{json .NetworkSettings.Ports}}']),
    )[`${port}/tcp`][0].HostPort,
  );
}
function run(name, image, args, env = {}, mounts = [], port) {
  const options = [
    'run',
    '--detach',
    '--no-healthcheck',
    '--name',
    network + '-' + name,
    '--network',
    network,
    '--network-alias',
    name,
  ];
  for (const mount of mounts) options.push('--mount', mount);
  for (const key of Object.keys(env)) options.push('--env', key);
  const id = docker([...options, image, ...args], env);
  containers.push(id);
  if (port) ports.set(name, published(accessId, port));
  return id;
}
const mounts = () => [
  `type=bind,source=${join(source, 'dist')},target=/app/dist,readonly`,
  `type=bind,source=${resolve('dist/apps/promotions-svc')},target=/app/dist/apps/promotions-svc,readonly`,
  `type=bind,source=${support},target=/app/real-test,readonly`,
  `type=bind,source=${directory},target=/test,readonly`,
];
const issuer = 'https://issuer:4443/api/v1/auth';
const common = () => ({
  NODE_ENV: 'test',
  NODE_EXTRA_CA_CERTS: '/test/server.crt',
  PGHOST: 'postgres',
  PGPORT: '5432',
  PGDATABASE: 'postgres',
  PGSSLMODE: 'verify-full',
  PGSSLROOTCERT: '/test/server.crt',
  PGPASSWORD: password,
  GATEWAY_DEMO_NO_AUTH_ENABLED: 'false',
});
const promotionEnv = () => ({
  ...common(),
  PGUSER: 'promotions_test_login',
  G6_DATABASE_SCHEMA: 'promotions',
  G6_CONNECTION_MODE: 'session',
  PROMOTIONS_SVC_PORT: '3004',
  PROMOTIONS_COUPON_RUNTIME_ENABLED: 'false',
  PROMOTIONS_DEPENDENCY_PROBES_ENABLED: 'true',
  RABBITMQ_URL: `amqp://promotions_probe:${password}@broker:5672/g6-productos-ofertas`,
  AUTH_ISSUER: issuer,
  AUTH_JWKS_URL: issuer + '/.well-known/jwks.json',
  PROMOTIONS_SERVICE_TOKEN_URL: issuer + '/token',
  PROMOTIONS_SERVICE_CLIENT_SECRET: secret,
  GATEWAY_CATALOG_SVC_URL: 'https://catalog-tls:4443',
  GATEWAY_PRICING_SVC_URL: 'http://pricing-svc:3002',
  GATEWAY_INVENTORY_SVC_URL: 'http://inventory-svc:3005',
  GATEWAY_TAXONOMY_SVC_URL: 'http://taxonomy-svc:3003',
});
function startApp(name, port, env) {
  // Image contains runtime dependencies only; pinned dist replaces its application code.
  const id = run(
    name,
    runtime,
    ['node', `/app/dist/apps/${name}/main.js`],
    env,
    mounts(),
    port,
  );
  apps.set(name, id);
  return id;
}
function token(overrides = {}, invalidSignature = false) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: issuer,
    sub: 'modulo-productos',
    client_id: 'modulo-productos',
    tipo: 'servicio',
    aud: ['api-productos'],
    scope: 'catalogo:leer',
    iat: now,
    exp: now + 600,
    jti: randomUUID(),
    ...overrides,
  };
  const input = [
    { alg: 'RS256', typ: 'JWT', kid: 'local-real-services' },
    claims,
  ]
    .map((v) => Buffer.from(JSON.stringify(v)).toString('base64url'))
    .join('.');
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(input),
    readFileSync(join(directory, 'server.key')),
  );
  if (invalidSignature) signature[0] ^= 1;
  return input + '.' + signature.toString('base64url');
}
async function request(service, path, bearer, extra = {}) {
  const correlationId = randomUUID(),
    start = performance.now();
  const response = await fetch(
    `http://127.0.0.1:${ports.get(service)}${path}`,
    {
      ...extra,
      headers: {
        'X-Correlation-Id': correlationId,
        ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}),
        ...extra.headers,
      },
      signal: AbortSignal.timeout(20000),
    },
  );
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return {
    service,
    path,
    status: response.status,
    contentType: response.headers.get('content-type'),
    correlationId,
    responseCorrelationId: response.headers.get('x-correlation-id'),
    body,
    elapsedMs: Math.round(performance.now() - start),
  };
}
async function check(id, operation) {
  try {
    const detail = await operation();
    evidence.checks.push({ id, result: 'PASS', ...detail });
    console.log('PASS ' + id);
  } catch (error) {
    evidence.checks.push({ id, result: 'FAIL', error: safe(error.message) });
    console.log('FAIL ' + id + ': ' + safe(error.message));
  }
}
async function probe(operation, path, deadline = 5000, overrides = {}) {
  const env = {
    ...promotionEnv(),
    ...(['admin-category', 'marketplace-seed'].includes(operation)
      ? { PROMOTIONS_DEPENDENCY_PROBES_ENABLED: 'false' }
      : {}),
    ...overrides,
  };
  const args = ['run', '--rm', '--network', network];
  for (const mount of mounts()) args.push('--mount', mount);
  for (const key of Object.keys(env)) args.push('--env', key);
  const { stdout } = await execFileAsync(
    'docker',
    [
      ...args,
      runtime,
      'node',
      '/app/real-test/local-real-reader.mjs',
      operation,
      path,
      String(deadline),
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      env: { ...process.env, ...env },
    },
  );
  return JSON.parse(stdout.trim());
}
async function rowCounts() {
  const tables = (
    await admin.query(
      'SELECT schemaname,tablename FROM pg_tables WHERE schemaname=ANY($1) ORDER BY schemaname,tablename',
      [['catalog', 'pricing', 'inventory', 'taxonomy', 'promotions']],
    )
  ).rows;
  const counts = {};
  for (const { schemaname, tablename } of tables) {
    assert.match(schemaname, /^[a-z_]+$/);
    assert.match(tablename, /^[a-z_]+$/);
    counts[schemaname + '.' + tablename] = (
      await admin.query(
        `SELECT count(*)::int AS n FROM "${schemaname}"."${tablename}"`,
      )
    ).rows[0].n;
  }
  return counts;
}
async function promotionsRows() {
  const tables = (
    await admin.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='promotions' ORDER BY tablename",
    )
  ).rows;
  const rows = {};
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_]+$/);
    rows[tablename] = (
      await admin.query(
        `SELECT to_jsonb(t) AS row FROM promotions."${tablename}" t ORDER BY to_jsonb(t)::text`,
      )
    ).rows;
  }
  return rows;
}
const sqlFiles = [
  [
    'catalog',
    'datos/catalog-svc/migrations/0001_create_catalog.sql',
    '5861536e31b2eb0ccb94d8ad2a4e10f4e792d6d2',
  ],
  [
    'taxonomy',
    'datos/taxonomy/migrations/0001_create_taxonomy.sql',
    '3db51993e6c06ecfcbc2e93f6757f848a78987f4',
  ],
  [
    'pricing',
    'datos/pricing/migrations/0001_create_pricing.sql',
    '1f34f1fc0b4122bc33c6ebe524523bbe1e17d7fe',
  ],
  [
    'inventory',
    'datos/inventory-svc/migrations/0001_inventory_initial.sql',
    'a2ff60c69112bbd6f2db5a3346475e9c9aed5be2',
  ],
  [
    'inventory',
    'datos/inventory-svc/migrations/0002_order_id_operaciones_disponibilidad.sql',
    '78a3c025ad1ae6f7a13072f2f24092e4a60e3f43',
  ],
];
async function migrate(schema, content) {
  const connection = await admin.connect();
  try {
    await connection.query(`BEGIN; SET LOCAL ROLE po_${schema}_owner`);
    await connection.query(content);
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}
try {
  mkdirSync(cache, { recursive: true });
  evidence.promotions = {
    checkoutHead: git(['rev-parse', 'HEAD']),
    changedSourcePaths: git([
      'diff',
      '--name-only',
      'HEAD',
      '--',
      'apps/promotions-svc/src',
    ])
      .split('\n')
      .filter(Boolean),
    sourceSha256: consumerSources(),
    execution:
      'current checkout compiled and mounted over pinned provider dist; source hashes verified before/after',
  };
  if (!existsSync(source)) {
    mkdirSync(source);
    const archive = join(directory, 'pinned-source.tar');
    git(['archive', '--format=tar', '--output', archive, master]);
    execute('tar', ['-xf', archive, '-C', source]);
  }
  verifySource();
  evidence.sourceVerified = true;
  stage = 'portable runtime image';
  try {
    docker(['image', 'inspect', runtime, '--format', '{{.Id}}']);
  } catch (error) {
    if (process.env.G6_TEST_RUNTIME_IMAGE) throw error;
    // Build from the immutable repository Dockerfile, not a machine-local image ID.
    execute(
      'docker',
      [
        'build',
        '--file',
        join(source, 'Dockerfile.service'),
        '--build-arg',
        'SERVICE_NAME=promotions-svc',
        '--tag',
        runtime,
        source,
      ],
      { timeout: 600000 },
    );
  }
  runtime = docker(['image', 'inspect', runtime, '--format', '{{.Id}}']);
  assert.match(runtime, /^sha256:[a-f0-9]{64}$/);
  evidence.runtime = runtime;
  evidence.harnessSha256 = Object.fromEntries(
    [
      'real-services.isolated.e2e.mjs',
      ...[
        'local-real-reader.mjs',
        'local-real-issuer.mjs',
        'local-real-catalog-tls.mjs',
        'local-real-test-access.mjs',
        'real-services-assertions.mjs',
        'real-services-assertions.test.mjs',
      ].map((f) => 'support/' + f),
    ].map((f) => [
      f,
      createHash('sha256')
        .update(readFileSync(resolve('apps/promotions-svc/test', f)))
        .digest('hex'),
    ]),
  );
  evidence.lockSha256 = createHash('sha256')
    .update(readFileSync(join(source, 'package-lock.json')))
    .digest('hex');
  stage = 'compile pinned source';
  execute(
    process.platform === 'win32' ? 'cmd.exe' : 'npm',
    process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm run build:all']
      : ['run', 'build:all'],
    { cwd: source, timeout: 180000 },
  );
  evidence.build = 'PASS: npm run build:all in immutable snapshot';
  execute(
    process.platform === 'win32' ? 'cmd.exe' : 'npm',
    process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm run build:promotions-svc']
      : ['run', 'build:promotions-svc'],
    { cwd: root, timeout: 180000 },
  );
  assert.equal(
    blob(readFileSync(resolve('package-lock.json'))),
    blob(readFileSync(join(source, 'package-lock.json'))),
    'consumer/provider dependency lock mismatch',
  );
  evidence.consumerBuild =
    'PASS: npm run build:promotions-svc in current checkout';
  console.log(evidence.build);
  stage = 'disposable TLS';
  execute(openssl, [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=g6-local-real-tests',
    '-addext',
    'subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:postgres,DNS:issuer,DNS:catalog-tls',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-keyout',
    join(directory, 'server.key'),
    '-out',
    join(directory, 'server.crt'),
  ]);
  docker(['network', 'create', '--internal', network]);
  networkCreated = true;
  // Internal networks intentionally have no NAT/public ports. Only the test
  // driver's byte-transparent access container also joins the default bridge.
  const accessArgs = [
    'run',
    '--detach',
    '--rm',
    '--no-healthcheck',
    '--name',
    network + '-test-access',
    '--network',
    'bridge',
  ];
  for (const port of [5432, 5672, 3001, 3002, 3003, 3004, 3005])
    accessArgs.push('--publish', `127.0.0.1::${port}`);
  for (const mount of mounts()) accessArgs.push('--mount', mount);
  accessId = docker([
    ...accessArgs,
    runtime,
    'node',
    '/app/real-test/local-real-test-access.mjs',
  ]);
  containers.push(accessId);
  docker(['network', 'connect', network, accessId]);
  evidence.testAccess = {
    bindings: JSON.parse(
      docker([
        'inspect',
        accessId,
        '--format',
        '{{json .NetworkSettings.Ports}}',
      ]),
    ),
    transport:
      'fixed byte-transparent TCP bridge; only test driver dual-homed; application/DB/broker/issuer remain on internal network',
  };
  for (const bindings of Object.values(evidence.testAccess.bindings))
    for (const binding of bindings ?? [])
      assert.equal(binding.HostIp, '127.0.0.1');
  const lock = JSON.parse(readFileSync(join(source, 'package-lock.json')));
  const expectedVersions = Object.fromEntries(
    Object.keys(lock.packages[''].dependencies).map((name) => [
      name,
      lock.packages['node_modules/' + name].version,
    ]),
  );
  const actualVersions = JSON.parse(
    docker([
      'exec',
      accessId,
      'node',
      '-e',
      "const fs=require('fs');console.log(JSON.stringify(Object.fromEntries(JSON.parse(process.argv[1]).map(n=>[n,JSON.parse(fs.readFileSync('/app/node_modules/'+n+'/package.json')).version]))))",
      JSON.stringify(Object.keys(expectedVersions)),
    ]),
  );
  assert.deepEqual(
    actualVersions,
    expectedVersions,
    'Runtime dependencies must match the pinned lockfile',
  );
  evidence.runtimeDependencyVersions = actualVersions;
  stage = 'disposable PostgreSQL';
  run(
    'postgres',
    'postgres:17-alpine',
    [
      'sh',
      '-c',
      'cp /test/server.key /tmp/server.key && cp /test/server.crt /tmp/server.crt && chmod 600 /tmp/server.key && chown postgres /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key',
    ],
    { POSTGRES_PASSWORD: password },
    [`type=bind,source=${directory},target=/test,readonly`],
    5432,
  );
  admin = new pg.Pool({
    host: '127.0.0.1',
    port: ports.get('postgres'),
    user: 'postgres',
    password,
    database: 'postgres',
    ssl: {
      ca: readFileSync(join(directory, 'server.crt')),
      rejectUnauthorized: true,
    },
    connectionTimeoutMillis: 1000,
  });
  admin.on('error', () => undefined);
  await waitFor(() => admin.query('SELECT 1'));
  for (const schema of [
    'catalog',
    'taxonomy',
    'pricing',
    'inventory',
    'promotions',
  ]) {
    await admin.query(
      `CREATE ROLE po_${schema}_owner NOLOGIN; CREATE SCHEMA ${schema} AUTHORIZATION po_${schema}_owner`,
    );
  }
  for (const login of [
    'catalog_app',
    'taxonomy_app',
    'pricing_app',
    'inventory_app',
  ])
    await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}'`);
  await admin.query(
    `CREATE ROLE po_inventory_runtime NOLOGIN; GRANT po_inventory_runtime TO inventory_app; CREATE ROLE po_promotions_runtime NOLOGIN; CREATE ROLE promotions_test_login LOGIN PASSWORD '${password}' IN ROLE po_promotions_runtime; CREATE SCHEMA extensions; CREATE EXTENSION btree_gist SCHEMA extensions; CREATE EXTENSION pgcrypto; GRANT USAGE ON SCHEMA extensions TO po_pricing_owner,pricing_app`,
  );
  // Historical Inventory SQL issues CREATE SCHEMA IF NOT EXISTS. PostgreSQL
  // checks database CREATE even for the existing schema; only the migration
  // owner gets it temporarily, never the runtime login.
  await admin.query('GRANT CREATE ON DATABASE postgres TO po_inventory_owner');
  stage = 'immutable migrations';
  for (const [schema, path, sha] of sqlFiles) {
    const cached = join(cache, 'real-norm-' + path.replaceAll('/', '_'));
    if (!existsSync(cached)) {
      const response = await fetch(
        `https://raw.githubusercontent.com/Taller-SW-Web/G6-Productos-Ofertas-docs/${docs}/${path}`,
        { signal: AbortSignal.timeout(15000) },
      );
      assert.ok(response.ok, 'BLOCKED_CONTRACT: ' + path);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(blob(bytes), sha, 'BLOCKED_CONTRACT_CHECKSUM: ' + path);
      writeFileSync(cached, bytes);
    }
    const bytes = readFileSync(cached);
    assert.equal(blob(bytes), sha, 'BLOCKED_CONTRACT: ' + path);
    await migrate(schema, bytes.toString());
    evidence.migrations.push({
      schema,
      repository: 'docs',
      revision: docs,
      path,
      blob: sha,
    });
  }
  await admin.query(
    'REVOKE CREATE ON DATABASE postgres FROM po_inventory_owner',
  );
  for (const schema of ['catalog', 'taxonomy']) {
    const names =
      schema === 'catalog'
        ? [
            '0002_create_sku_barcodes.sql',
            '0003_product_publication_history.sql',
          ]
        : [
            '0002_deactivation_source_version.sql',
            '0003_deactivation_timeout_setting.sql',
          ];
    for (const name of names) {
      const path = `apps/${schema}-svc/migrations/${name}`,
        bytes = readFileSync(join(source, path));
      await migrate(schema, bytes.toString());
      evidence.migrations.push({
        schema,
        repository: 'backend',
        revision: master,
        path,
        blob: blob(bytes),
      });
    }
  }
  for (const content of await officialMigrations())
    await migrate('promotions', content);
  await admin.query(
    'GRANT USAGE ON SCHEMA inventory TO po_inventory_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA inventory TO po_inventory_runtime; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA inventory TO po_inventory_runtime',
  );
  stage = 'synthetic fixture rows in real schemas';
  const productId = randomUUID(),
    opaqueId = randomUUID(),
    inactiveId = randomUUID(),
    categoryId = randomUUID();
  const inactiveCategoryId = randomUUID(),
    missingCategoryId = randomUUID();
  evidence.fixture = {
    productId,
    opaqueId,
    inactiveId,
    categoryId,
    inactiveCategoryId,
    missingCategoryId,
    sku: 'SYNTHETIC-REAL',
    opaqueSku: 'SKU %2F + Ñ',
    state:
      'BORRADOR/INACTIVO; no fabricated Pricing/Inventory activation confirmations',
    origin: 'test-only SQL; no commercial fact mocks or replacement providers',
  };
  for (const [id, sku, slug, state] of [
    [productId, 'SYNTHETIC-REAL', 'synthetic-real', 'BORRADOR'],
    [opaqueId, 'SKU %2F + Ñ', 'synthetic-opaque', 'BORRADOR'],
    [inactiveId, 'SYNTHETIC-INACTIVE', 'synthetic-inactive', 'INACTIVO'],
  ])
    await admin.query(
      "INSERT INTO catalog.products(id,nombre,descripcion,categoria_id,tipo_producto_id,marca_id,sku_base,slug,tiene_variantes,estado) VALUES($1,'SYNTHETIC','Isolated integration fixture',$2,'SYNTHETIC-TYPE','SYNTHETIC-BRAND',$3,$4,false,$5)",
      [id, categoryId, sku, slug, state],
    );
  await admin.query(
    "INSERT INTO taxonomy.categories(id,nombre,nivel,orden) VALUES($1,'SYNTHETIC REAL',1,0)",
    [categoryId],
  );
  await admin.query(
    "INSERT INTO taxonomy.categories(id,nombre,nivel,orden,estado) VALUES($1,'SYNTHETIC INACTIVE',1,0,'INACTIVO')",
    [inactiveCategoryId],
  );
  const locationId = randomUUID();
  await admin.query(
    "INSERT INTO inventory.locations(id,code,name,type) VALUES($1,'SYNTHETIC','SYNTHETIC','ALMACEN')",
    [locationId],
  );
  await admin.query(
    "INSERT INTO inventory.commercial_fulfillment_routes(channel_id,mode,fulfillment_ref,location_id) VALUES('MARKETPLACE','ENVIO_DOMICILIO','SYNTHETIC-ROUTE',$1)",
    [locationId],
  );
  for (const [sku, amount] of [
    ['SYNTHETIC-REAL', 20],
    ['SYNTHETIC-LOW', 2],
    ['SYNTHETIC-ZERO', 0],
  ])
    await admin.query(
      'INSERT INTO inventory.stock_balance(sku_id,location_id,on_hand) VALUES($1,$2,$3)',
      [sku, locationId, amount],
    );
  stage = 'disposable RabbitMQ';
  run(
    'broker',
    'rabbitmq:4.2.9-alpine',
    [],
    {
      RABBITMQ_DEFAULT_USER: 'promotions_probe',
      RABBITMQ_DEFAULT_PASS: password,
      RABBITMQ_DEFAULT_VHOST: 'g6-productos-ofertas',
    },
    [],
    5672,
  );
  broker = await waitFor(() =>
    amqp.connect(
      `amqp://promotions_probe:${password}@127.0.0.1:${ports.get('broker')}/g6-productos-ofertas`,
    ),
  );
  broker.on('error', () => undefined);
  const channel = await broker.createChannel();
  const bindings = await import(
    pathToFileURL(
      join(
        source,
        'dist/apps/promotions-svc/coupons/event-contract.generated.js',
      ),
    ).href
  );
  await channel.assertQueue(bindings.promotionsBrokerBinding.queue, {
    durable: true,
  });
  await channel.close();
  evidence.broker = {
    version: '4.2.9',
    queue: bindings.promotionsBrokerBinding.queue,
    purpose:
      'real native passive readiness; no claim of external command/event E2E',
    image: docker(['inspect', containers.at(-1), '--format', '{{.Image}}']),
  };
  stage = 'real application processes';
  run(
    'issuer',
    runtime,
    ['node', '/app/real-test/local-real-issuer.mjs'],
    { NODE_ENV: 'test', LOCAL_CLIENT_SECRET: secret },
    mounts(),
  );
  startApp('catalog-svc', 3001, {
    ...common(),
    PGUSER: 'catalog_app',
    G6_DATABASE_SCHEMA: 'catalog',
    G6_EXPECTED_ROLE: 'catalog_app',
    G6_CONNECTION_MODE: 'direct',
    CATALOG_SVC_PORT: '3001',
    CATALOG_SVC_HOST: '0.0.0.0',
    SECURITY_ISSUER: issuer,
    SECURITY_DISCOVERY_URL: issuer + '/.well-known/openid-configuration',
    SECURITY_JWKS_URL: issuer + '/.well-known/jwks.json',
  });
  run(
    'catalog-tls',
    runtime,
    ['node', '/app/real-test/local-real-catalog-tls.mjs'],
    { NODE_ENV: 'test' },
    mounts(),
  );
  startApp('pricing-svc', 3002, {
    ...common(),
    PRICING_SVC_PORT: '3002',
    DATABASE_URL: `postgresql://pricing_app:${password}@postgres:5432/postgres`,
    AUTH_ISSUER: issuer,
    AUTH_JWKS_URL: issuer + '/.well-known/jwks.json',
    PRICING_CATALOG_URL: 'https://catalog-tls:4443',
    PRICING_SERVICE_TOKEN_URL: issuer + '/token',
    PRICING_SERVICE_CLIENT_SECRET: secret,
  });
  startApp('taxonomy-svc', 3003, {
    ...common(),
    PGUSER: 'taxonomy_app',
    G6_DATABASE_SCHEMA: 'taxonomy',
    G6_EXPECTED_ROLE: 'taxonomy_app',
    G6_CONNECTION_MODE: 'direct',
    TAXONOMY_SVC_PORT: '3003',
    TAXONOMY_SVC_HOST: '0.0.0.0',
    SECURITY_ISSUER: issuer,
    SECURITY_DISCOVERY_URL: issuer + '/.well-known/openid-configuration',
    SECURITY_JWKS_URL: issuer + '/.well-known/jwks.json',
  });
  startApp('inventory-svc', 3005, {
    ...common(),
    PGUSER: 'inventory_app',
    INVENTORY_SVC_PORT: '3005',
    INVENTORY_DEMO_NO_AUTH_ENABLED: 'false',
    G7_JWT_ISSUER: issuer,
    G7_JWT_PUBLIC_KEY: createPublicKey(
      readFileSync(join(directory, 'server.key')),
    ).export({ type: 'spki', format: 'pem' }),
    INVENTORY_WORKER_INTERVAL_MS: '60000',
  });
  startApp('promotions-svc', 3004, promotionEnv());
  for (const name of apps.keys()) {
    const result = await waitFor(async () => {
      const response = await request(name, '/health');
      assertLiveness(name, response);
      return response;
    });
    await check('liveness-' + name, async () => result);
  }
  // Assert the actual port bindings and network isolation, including services which listen on ::.
  evidence.network = JSON.parse(
    docker(['network', 'inspect', network, '--format', '{{json .Internal}}']),
  );
  assert.equal(evidence.network, true);
  evidence.processes = [...apps].map(([service, id]) => ({
    service,
    image: docker(['inspect', id, '--format', '{{.Image}}']),
    bindings: JSON.parse(
      docker(['inspect', id, '--format', '{{json .NetworkSettings.Ports}}']),
    ),
  }));
  for (const app of evidence.processes)
    for (const bindings of Object.values(app.bindings))
      for (const binding of bindings ?? [])
        assert.equal(binding.HostIp, '127.0.0.1');
  const marketplaceSeed = (await probe('marketplace-seed', productId)).body;
  assert.equal(marketplaceSeed.kind, 'fixture-own-promotions-only');
  const beforeCounts = await rowCounts();
  const beforePromotions = await promotionsRows();
  const marketplace = (scope) =>
    token({
      sub: 'modulo-marketplace',
      client_id: 'modulo-marketplace',
      scope,
    });
  await check('promotions-real-list-active-campaign', async () => {
    const r = await request(
      'promotions-svc',
      '/api/v1/promociones?canal=MARKETPLACE',
      marketplace('promociones:leer'),
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(
      r.body.items.some((p) => p.promotion_id === marketplaceSeed.promotionId),
    );
    return r;
  });
  const contextPath = '/api/v1/productos/skus/SYNTHETIC-REAL/contexto';
  await check('catalog-context-simple-real-pg', async () => {
    const r = await request('catalog-svc', contextPath, token());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, {
      sku: 'SYNTHETIC-REAL',
      productId,
      isVariant: false,
      active: false,
      eligible: false,
    });
    assert.equal(r.responseCorrelationId, r.correlationId);
    return r;
  });
  await check('promotions-native-token-reader-to-real-catalog', async () => {
    const r = await probe(
      'obtenerContextoSku',
      '/productos/skus/SYNTHETIC-REAL/contexto',
    );
    assert.equal(r.outcome, 'RETURNED', JSON.stringify(r));
    assert.equal(r.body.productId, productId);
    return r;
  });
  await check('catalog-opaque-sku-not-double-decoded', async () => {
    const r = await request(
      'catalog-svc',
      '/api/v1/productos/skus/' +
        encodeURIComponent(evidence.fixture.opaqueSku) +
        '/contexto',
      token(),
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.sku, evidence.fixture.opaqueSku);
    assert.equal(r.body.productId, opaqueId);
    return r;
  });
  await check('catalog-inactive-context', async () => {
    const r = await request(
      'catalog-svc',
      '/api/v1/productos/skus/SYNTHETIC-INACTIVE/contexto',
      token(),
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.active, false);
    assert.equal(r.body.eligible, false);
    return r;
  });
  await check('catalog-missing-context-contract-error', async () => {
    const r = await request(
      'catalog-svc',
      '/api/v1/productos/skus/SYNTHETIC-MISSING/contexto',
      token(),
    );
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'SKU_NO_ENCONTRADO');
    return r;
  });
  for (const [id, bearer, expected] of [
    ['anonymous', undefined, 401],
    [
      'wrong-client',
      token({ sub: 'modulo-pricing', client_id: 'modulo-pricing' }),
      403,
    ],
    ['wrong-scope', token({ scope: 'precios:leer' }), 403],
    ['expired', token({ exp: Math.floor(Date.now() / 1000) - 60 }), 401],
    ['wrong-audience', token({ aud: ['other'] }), 401],
    ['wrong-issuer', token({ iss: 'https://wrong.invalid' }), 401],
    ['bad-signature', token({}, true), 401],
    [
      'human',
      token({ tipo: 'acceso', sub: randomUUID(), roles: ['GESTOR_COMERCIAL'] }),
      403,
    ],
  ])
    await check('catalog-auth-' + id, async () => {
      const r = await request('catalog-svc', contextPath, bearer);
      assert.equal(r.status, expected, JSON.stringify(r.body));
      return r;
    });
  await check('catalog-invalid-correlation', async () => {
    const r = await request('catalog-svc', contextPath, token(), {
      headers: { 'X-Correlation-Id': 'invalid' },
    });
    assert.equal(r.status, 400);
    return r;
  });
  await check(
    'catalog-context-persists-across-real-process-restart',
    async () => {
      await admin.query(
        "UPDATE catalog.products SET estado='INACTIVO' WHERE id=$1",
        [productId],
      );
      const old = apps.get('catalog-svc');
      docker(['restart', old]);
      // Docker restart retains this run's volume and assigned host port.
      await waitFor(() =>
        request('catalog-svc', contextPath, token()).then((r) => {
          assert.equal(r.status, 200);
          return r;
        }),
      );
      const r = await request('catalog-svc', contextPath, token());
      assert.equal(r.status, 200);
      assert.equal(r.body.productId, productId);
      assert.equal(
        (
          await admin.query('SELECT estado FROM catalog.products WHERE id=$1', [
            productId,
          ])
        ).rows[0].estado,
        'INACTIVO',
      );
      return { ...r, persistedState: 'INACTIVO' };
    },
  );
  await check('real-pg-lock-timeout-cancellation-and-recovery', async () => {
    const lock = await admin.connect();
    const lockPid = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0]
      .pid;
    const sessions = async () =>
      (
        await admin.query(`SELECT pid,usename,state,wait_event_type,wait_event,
      pg_blocking_pids(pid) AS blockers, query LIKE '%sku_identity%' AS sku_query
      FROM pg_stat_activity WHERE usename='catalog_app' ORDER BY pid`)
      ).rows;
    const assertDrained = (rows) =>
      assert.deepEqual(
        rows.filter(
          (r) =>
            r.wait_event_type === 'Lock' ||
            r.state.startsWith('idle in transaction') ||
            (r.sku_query && r.state === 'active'),
        ),
        [],
        'Catalog must have no blocked, unfinished SKU or idle-in-transaction query',
      );
    const before = await sessions();
    assertDrained(before);
    let timed, inFlight, blocked, pendingAtClientTimeout;
    const deadlineMs = 2000;
    try {
      await lock.query(
        'BEGIN; LOCK catalog.sku_identity IN ACCESS EXCLUSIVE MODE',
      );
      inFlight = probe(
        'obtenerContextoSku',
        '/productos/skus/SYNTHETIC-REAL/contexto',
        deadlineMs,
      );
      // Keep a Docker/spawn failure handled while observing PostgreSQL; the
      // awaited promise below still propagates it as a failed scenario.
      void inFlight.catch(() => undefined);
      blocked = await waitFor(async () => {
        const rows = (await sessions()).filter(
          (r) =>
            r.state === 'active' &&
            r.sku_query &&
            r.wait_event_type === 'Lock' &&
            r.blockers.includes(lockPid),
        );
        assert.ok(
          rows.length > 0,
          'The actual Catalog SKU query must wait on this test lock',
        );
        return rows;
      }, 15);
      timed = await inFlight;
      assertReaderDeadline(timed, deadlineMs);
      pendingAtClientTimeout = await sessions();
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
      await inFlight?.catch(() => undefined);
    }
    const drainStart = performance.now();
    const drained = await waitFor(async () => {
      const rows = await sessions();
      assertDrained(rows);
      return rows;
    }, 25);
    const drainElapsedMs = Math.round(performance.now() - drainStart);
    const recovered = await probe(
      'obtenerContextoSku',
      '/productos/skus/SYNTHETIC-REAL/contexto',
    );
    assert.equal(recovered.outcome, 'RETURNED');
    assert.equal(recovered.body.productId, productId);
    const afterRecovery = await sessions();
    assertDrained(afterRecovery);
    return {
      deadlineMs,
      before,
      lockPid,
      blocked,
      timed,
      pendingAtClientTimeout,
      drained,
      afterRecovery,
      drainElapsedMs,
      recovered,
      limitation:
        'HTTP deadline cancels the client transport; PostgreSQL cancellation is not inferred. Release the test lock and verify server queries drain and recovery succeeds.',
    };
  });
  stage = 'provider integration blockers';
  for (const [id, service, path, bearer, status, owner, reason] of [
    [
      'catalog-product',
      'catalog-svc',
      '/api/v1/productos/' + productId + '?canal=MARKETPLACE',
      token(),
      403,
      'Poma',
      'Habilitar modulo-productos/catalogo:leer en obtenerProducto conservando seguridad.',
    ],
    [
      'inventory-commercial',
      'inventory-svc',
      '/api/v1/inventario/disponibilidad/comercial?skus=SYNTHETIC-REAL&canal=MARKETPLACE',
      token({ scope: 'inventario:disponibilidad:leer' }),
      403,
      'Taco',
      'Autorizar modulo-productos y validar canal solicitado por Promotions; allowlist sola no resuelve CANAL_CLIENT_MAP.',
    ],
  ])
    await check('blocker-' + id, async () => {
      const r = await request(service, path, bearer);
      assert.equal(r.status, status, JSON.stringify(r.body));
      evidence.blockers.push({
        id,
        service,
        endpoint: path,
        sha: master,
        result: 'BLOCKED',
        owner,
        unblock: reason,
        evidence: 'blocker-' + id,
        observed: r,
      });
      return r;
    });
  await check('pricing-real-catalog-inactive-sku-contract-error', async () => {
    const r = await request(
      'pricing-svc',
      '/api/v1/precios/skus/SYNTHETIC-REAL?canal=MARKETPLACE',
      token({ scope: 'precios:leer' }),
    );
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.code, 'PRECIO_NO_ENCONTRADO');
    return {
      ...r,
      transport:
        'verified TLS terminator forwards to real Catalog; real own client_credentials token',
    };
  });
  await check('pricing-real-catalog-batch-omits-ineligible-sku', async () => {
    const r = await request(
      'pricing-svc',
      '/api/v1/precios?skus=SYNTHETIC-REAL&canal=MARKETPLACE',
      token({ scope: 'precios:leer' }),
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { items: [] });
    return r;
  });
  await check('inventory-real-pg-four-commercial-states', async () => {
    const r = await request(
      'inventory-svc',
      '/api/v1/inventario/disponibilidad/comercial?skus=SYNTHETIC-REAL,SYNTHETIC-LOW,SYNTHETIC-ZERO,SYNTHETIC-MISSING&canal=MARKETPLACE',
      marketplace('inventario:disponibilidad:leer'),
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(
      r.body.items.map((x) => x.status),
      ['DISPONIBLE', 'STOCK_BAJO', 'AGOTADO', 'INDETERMINADO'],
    );
    assert.ok(
      r.body.items.every(
        (x) => Object.keys(x).sort().join(',') === 'sku,status',
      ),
    );
    return r;
  });
  await check('inventory-client-channel-mismatch', async () => {
    const r = await request(
      'inventory-svc',
      '/api/v1/inventario/disponibilidad/comercial?skus=SYNTHETIC-REAL&canal=RETAIL',
      marketplace('inventario:disponibilidad:leer'),
    );
    assert.equal(r.status, 403);
    return r;
  });
  await check('inventory-invalid-channel', async () => {
    const r = await request(
      'inventory-svc',
      '/api/v1/inventario/disponibilidad/comercial?skus=SYNTHETIC-REAL&canal=INVALID',
      marketplace('inventario:disponibilidad:leer'),
    );
    assert.equal(r.status, 400);
    return r;
  });
  await check('taxonomy-real-pg-list-control', async () => {
    const r = await request(
      'taxonomy-svc',
      '/api/v1/categorias',
      token({ sub: 'modulo-marketplace', client_id: 'modulo-marketplace' }),
    );
    assert.equal(r.status, 200);
    assert.ok(
      r.body.categories.some((c) => (c.categoria_id ?? c.id) === categoryId),
    );
    assert.ok(
      !r.body.categories.some(
        (c) => (c.categoria_id ?? c.id) === inactiveCategoryId,
      ),
    );
    return r;
  });
  for (const resource of ['categorias', 'marcas'])
    await check('taxonomy-read-token-cannot-list-' + resource, async () => {
      const r = await request('taxonomy-svc', '/api/v1/' + resource, token());
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'SCOPE_INSUFICIENTE');
      return r;
    });
  await check('taxonomy-category-existing-real-pg', async () => {
    const r = await request(
      'taxonomy-svc',
      '/api/v1/categorias/' + categoryId,
      token(),
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, {
      categoriaId: categoryId,
      nombre: 'SYNTHETIC REAL',
      descripcion: null,
      categoriaPadreId: null,
      orden: 0,
      imagenUrl: null,
      estado: 'ACTIVO',
      version: 0,
      slug: null,
    });
    assert.match(r.contentType, /^application\/json/);
    return r;
  });
  await check('taxonomy-category-missing-contract-error', async () => {
    const r = await request(
      'taxonomy-svc',
      '/api/v1/categorias/' + missingCategoryId,
      token(),
    );
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'CATEGORIA_NO_ENCONTRADA');
    assert.match(r.contentType, /^application\/problem\+json/);
    return r;
  });
  await check('taxonomy-category-inactive-real-pg', async () => {
    const r = await request(
      'taxonomy-svc',
      '/api/v1/categorias/' + inactiveCategoryId,
      token(),
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.estado, 'INACTIVO');
    assert.equal(r.body.categoriaId, inactiveCategoryId);
    return r;
  });
  for (const [name, bearer, status] of [
    ['anonymous', undefined, 401],
    [
      'wrong-client',
      token({ sub: 'modulo-marketplace', client_id: 'modulo-marketplace' }),
      403,
    ],
    ['wrong-scope', token({ scope: 'precios:leer' }), 403],
    ['wrong-audience', token({ aud: ['other'] }), 401],
    ['wrong-issuer', token({ iss: 'https://wrong.invalid' }), 401],
    ['expired', token({ exp: Math.floor(Date.now() / 1000) - 60 }), 401],
    ['bad-signature', token({}, true), 401],
    [
      'human-without-role',
      token({ tipo: 'acceso', sub: randomUUID(), roles: [] }),
      403,
    ],
  ])
    await check('taxonomy-category-auth-' + name, async () => {
      const r = await request(
        'taxonomy-svc',
        '/api/v1/categorias/' + categoryId,
        bearer,
      );
      assert.equal(r.status, status, JSON.stringify(r.body));
      assert.equal(
        r.body.code,
        status === 401 ? 'TOKEN_INVALIDO' : 'SCOPE_INSUFICIENTE',
      );
      return r;
    });
  await check('taxonomy-category-invalid-id', async () => {
    const r = await request(
      'taxonomy-svc',
      '/api/v1/categorias/not-a-uuid',
      token(),
    );
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'VALIDACION');
    return r;
  });
  await check('taxonomy-read-token-cannot-write', async () => {
    const r = await request('taxonomy-svc', '/api/v1/categorias', token(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: 'FORBIDDEN-SYNTHETIC' }),
    });
    assert.equal(r.status, 403);
    return r;
  });
  for (const [name, id, expected] of [
    ['active', categoryId, [categoryId]],
    ['missing', missingCategoryId, []],
    ['inactive', inactiveCategoryId, []],
  ])
    await check('promotions-nest-taxonomy-reference-' + name, async () => {
      const r = await probe('admin-category', id);
      assert.equal(r.outcome, 'RETURNED', JSON.stringify(r));
      assert.deepEqual(r.body, {
        products: [],
        skus: [],
        categories: expected,
      });
      assert.equal(
        r.scope,
        'native PromotionsSvcModule ADMIN_REFERENCES; no provider overrides',
      );
      return r;
    });
  await check(
    'promotions-nest-taxonomy-denied-grant-fails-closed',
    async () => {
      const r = await probe('admin-category', categoryId, 5000, {
        PROMOTIONS_SERVICE_CLIENT_SECRET: secret + '-invalid',
      });
      assert.equal(r.outcome, 'REJECTED');
      assert.equal(r.kind, 'CommercialDependencyError');
      assert.equal(r.error, 'COMMERCIAL_CONTEXT_UNAVAILABLE');
      return {
        ...r,
        limitation:
          'denied local issuer grant must not become an absent/active category',
      };
    },
  );
  await check(
    'promotions-independent-passive-readiness-real-pg-and-broker',
    async () => {
      const r = await probe('readiness', '/');
      assert.equal(r.body.status, 'ready', JSON.stringify(r));
      assert.deepEqual(r.body.dependencies, { database: 'up', broker: 'up' });
      assert.equal(r.scope.operationalAmqpConsumptionVerified, false);
      assert.equal(r.scope.runningServiceBrokerProbeEnabled, false);
      const monitor = docker(['logs', apps.get('promotions-svc')])
        .split(/\r?\n/)
        .flatMap((line) => {
          try {
            const row = JSON.parse(line);
            return row.code === 'DEPENDENCIES_READY' ? [row] : [];
          } catch {
            return [];
          }
        });
      assert.ok(
        monitor.some(
          (row) => row.database === 'up' && row.broker === 'disabled',
        ),
      );
      return {
        ...r,
        runningNestMonitor: monitor,
        transport:
          'independent test instance with check(true); running Nest monitor has broker disabled; no operational AMQP consumer verified',
      };
    },
  );
  await check('promotions-real-http-catalog-403-fails-closed', async () => {
    const beforeTrace = await probe('catalog-transport-evidence', '/');
    const r = await request(
      'promotions-svc',
      '/api/v1/promociones/evaluar',
      marketplace('promociones:evaluar'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel_id: 'MARKETPLACE',
          lines: [
            { product_id: productId, sku: 'SYNTHETIC-REAL', quantity: 1 },
          ],
        }),
      },
    );
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.code, 'SERVICIO_NO_DISPONIBLE');
    const upstreamRequests = (
      await probe('catalog-transport-evidence', '/')
    ).body.slice(beforeTrace.body.length);
    assert.equal(upstreamRequests.length, 1);
    const upstream = upstreamRequests[0];
    assert.equal(upstream.method, 'GET');
    assert.equal(
      upstream.path,
      '/api/v1/productos/' + productId + '?canal=MARKETPLACE',
    );
    assert.equal(upstream.status, 403);
    assert.match(upstream.correlationId, /^[a-f0-9-]{36}$/i);
    assert.equal(upstream.correlationId, upstream.responseCorrelationId);
    assert.equal(upstream.correlationId, r.correlationId);
    return {
      ...r,
      verifiedUpstreamFailure: upstream,
      limitation:
        'product_id intentionally reaches the real Catalog product guard: traced 403 maps to 503. This does not prove behavior caused by an inactive SKU or a successful commercial evaluation.',
    };
  });
  for (const [id, path, scope, extra] of [
    [
      'coupon',
      '/api/v1/cupones/validar',
      'cupones:validar',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel_id: 'MARKETPLACE',
          coupon_code: marketplaceSeed.code,
          lines: [
            { product_id: productId, sku: 'SYNTHETIC-REAL', quantity: 1 },
          ],
        }),
      },
    ],
    [
      'recommendations',
      '/api/v1/recomendaciones?productoId=' + productId + '&canal=MARKETPLACE',
      'recomendaciones:leer',
      {},
    ],
  ])
    await check(
      'promotions-real-' + id + '-catalog-403-fails-closed',
      async () => {
        const beforeTrace = await probe('catalog-transport-evidence', '/');
        const r = await request(
          'promotions-svc',
          path,
          marketplace(scope),
          extra,
        );
        assert.equal(r.status, 503, JSON.stringify(r.body));
        assert.equal(r.body.code, 'SERVICIO_NO_DISPONIBLE');
        const trace = (
          await probe('catalog-transport-evidence', '/')
        ).body.slice(beforeTrace.body.length);
        assert.equal(trace.length, 1);
        assert.equal(trace[0].status, 403);
        assert.equal(trace[0].correlationId, r.correlationId);
        return {
          ...r,
          verifiedUpstreamFailure: trace[0],
          limitation:
            'real Catalog authorization blocks positive business flow; local signed JWT does not demonstrate a real G7 grant',
        };
      },
    );
  await check('promotions-invalid-inbound-token', async () => {
    const r = await request(
      'promotions-svc',
      '/api/v1/promociones/evaluar',
      'invalid',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel_id: 'MARKETPLACE',
          lines: [{ sku: 'SYNTHETIC-REAL', quantity: 1 }],
        }),
      },
    );
    assert.equal(r.status, 401);
    return r;
  });
  for (const [service, schema, user, table] of [
    ['catalog-svc', 'catalog', 'catalog_app', 'products'],
    ['pricing-svc', 'pricing', 'pricing_app', 'prices'],
    ['taxonomy-svc', 'taxonomy', 'taxonomy_app', 'categories'],
    ['inventory-svc', 'inventory', 'inventory_app', 'stock_balance'],
    ['promotions-svc', 'promotions', 'promotions_test_login', 'promotions'],
  ])
    await check('postgres-identity-' + service, async () => {
      const client = new pg.Client({
        host: '127.0.0.1',
        port: ports.get('postgres'),
        database: 'postgres',
        user,
        password,
        application_name: 'g6-test-identity-' + service,
        connectionTimeoutMillis: 2000,
        ssl: {
          ca: readFileSync(join(directory, 'server.crt')),
          rejectUnauthorized: true,
        },
      });
      try {
        await client.connect();
        const row = (
          await client.query(
            `SELECT current_user,session_user,current_database() AS database,s.ssl,s.version,
        r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,
        has_schema_privilege(current_user,$1,'USAGE') AS own_schema_usage,
        pg_has_role(current_user,$2,'MEMBER') AS owner_member
        FROM pg_roles r JOIN pg_stat_ssl s ON s.pid=pg_backend_pid() WHERE r.rolname=current_user`,
            [schema, 'po_' + schema + '_owner'],
          )
        ).rows[0];
        assert.ok(row, 'The exact runtime role must exist');
        assert.equal(row.current_user, user);
        assert.equal(row.session_user, user);
        assert.equal(row.database, 'postgres');
        assert.equal(row.ssl, true);
        assert.match(row.version, /^TLSv1\.[23]$/);
        assert.equal(row.own_schema_usage, true);
        assert.equal(row.owner_member, false);
        for (const flag of [
          'rolsuper',
          'rolcreatedb',
          'rolcreaterole',
          'rolbypassrls',
        ])
          assert.equal(row[flag], false);
        const count = (
          await client.query(
            `SELECT count(*)::int AS n FROM ${schema}.${table}`,
          )
        ).rows[0].n;
        return {
          service,
          schema,
          ...row,
          ownTable: table,
          count,
          scope:
            'individual real SQL login probe; not an assertion that the application holds a persistent pool connection',
        };
      } finally {
        await client.end();
      }
    });
  await check('real-token-issuance-claims-evidence', async () => {
    const r = await probe('issuer-evidence', '/');
    assert.ok(r.body.length > 0);
    assert.ok(
      r.body.every(
        (c) =>
          c.sub === 'modulo-productos' &&
          c.tipo === 'servicio' &&
          c.aud.includes('api-productos'),
      ),
    );
    return r;
  });
  await check('read-only-http-does-not-create-business-rows', async () => {
    const afterCounts = await rowCounts();
    assert.deepEqual(await promotionsRows(), beforePromotions);
    assert.deepEqual(afterCounts, beforeCounts);
    return {
      before: beforeCounts,
      after: afterCounts,
      promotionsAllRowsUnchanged: true,
      promotionsRowsSha256: createHash('sha256')
        .update(JSON.stringify(beforePromotions))
        .digest('hex'),
      intentionalFixtureMutation:
        'only catalog.products.estado changed BORRADOR -> INACTIVO; no activation confirmations or commercial mutations',
    };
  });
  verifySource();
  evidence.sourceUnchangedAfterTests = true;
  evidence.applicationLogs = [...apps].map(([service, id]) => ({
    service,
    log: safe(docker(['logs', id])),
  }));
  evidence.status = evidence.checks.some((c) => c.result === 'FAIL')
    ? 'FAIL'
    : 'PARTIAL';
} catch (error) {
  evidence.status = 'FAIL';
  evidence.fatal = { stage, error: safe(error.stack ?? error.message) };
  for (const [service, id] of apps) {
    try {
      (evidence.applicationLogs ??= []).push({
        service,
        log: safe(docker(['logs', id])),
      });
    } catch {
      /* Own container already exited. */
    }
  }
  console.error('FAIL at ' + stage + ': ' + safe(error.message));
} finally {
  await broker?.close().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  evidence.cleanup = [];
  for (const id of containers.reverse()) {
    try {
      docker(['rm', '--force', '--volumes', id]);
      evidence.cleanup.push({ id, removed: true });
    } catch {
      evidence.cleanup.push({
        id,
        removed:
          docker(['ps', '--all', '--quiet', '--filter', 'id=' + id]) === '',
      });
    }
  }
  if (networkCreated) {
    try {
      docker(['network', 'rm', network]);
      evidence.networkRemoved = true;
    } catch {
      evidence.networkRemoved = false;
    }
  }
  const absolute = resolve(directory),
    tempRoot = resolve(tmpdir());
  assert.ok(absolute.startsWith(tempRoot + sep) && absolute !== tempRoot);
  rmSync(absolute, { recursive: true, force: true });
  evidence.finishedAt = new Date().toISOString();
  mkdirSync(resolve('apps/promotions-svc/test/evidence'), { recursive: true });
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log('Evidence: ' + output);
  if (
    evidence.status === 'FAIL' ||
    evidence.cleanup.some((c) => !c.removed) ||
    evidence.networkRemoved === false
  )
    process.exitCode = 1;
}
