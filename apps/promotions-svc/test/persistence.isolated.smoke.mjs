// Real PostgreSQL/TLS, official immutable SQL and a restricted runtime login.
// Never reads .env files or accepts a database URL. Run after the service build.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../../../dist/apps/promotions-svc/infrastructure/persistence/schema.js';
import {
  PromotionsPersistence,
  PromotionsPersistenceError,
} from '../../../dist/apps/promotions-svc/infrastructure/persistence/promotions-persistence.js';
import { nativeCouponResources } from '../../../dist/apps/promotions-svc/coupons/coupon-providers.js';
import { CouponCommandProcessor } from '../../../dist/apps/promotions-svc/coupons/coupon-transactions.js';
import { verifyHttpWrites } from './support/http-write-checks.mjs';
import {
  PromotionsConfigService,
  validatePromotionsConfiguration,
} from '../../../dist/apps/promotions-svc/infrastructure/config/promotions-config.js';
import {
  docsRevision,
  officialMigrations,
} from './support/official-migrations.mjs';
import { verifyHttpReadQueries } from './support/http-query-checks.mjs';
import { verifyHttpUpstreams } from './support/http-upstream-checks.mjs';
import { verifyH4Invalidations } from './support/h4-invalidation-checks.mjs';

const { Pool } = pg;
const directory = mkdtempSync(join(tmpdir(), 'g6-promotions-persistence-'));
const password = randomUUID();
const created = [];
const checks = [];
let admin;
let resources;
let stage = 'normative SQL';
function docker(args, environment = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 90000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...environment },
  }).trim();
}
async function ready(operation) {
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      return await operation();
    } catch {
      await delay(500);
    }
  }
  throw new Error('ISOLATED_POSTGRES_START_TIMEOUT');
}
async function rejected(operation, state) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof PromotionsPersistenceError);
    assert.equal(error.message, 'PROMOTIONS_PERSISTENCE_FAILED');
    if (state) assert.equal(error.sqlState, state);
    assert.equal(JSON.stringify(error).includes(password), false);
    assert.equal('cause' in error, false);
    return true;
  });
}
const promotion = (overrides = {}) => ({
  name: 'SYNTHETIC-ISOLATED',
  discountType: 'PORCENTAJE',
  discountValue: '10.00000000000000000001',
  modality: 'CUPON',
  state: 'ACTIVO',
  validFrom: '2026-10-01T00:00:00Z',
  validUntil: '2026-12-01T00:00:00Z',
  priority: 1,
  enabledChannels: ['MARKETPLACE'],
  ...overrides,
});
const scopes = [{ sku: 'SYNTHETIC-SKU' }];
const policy = {
  pricingOffer: false,
  automaticPromotion: false,
  coupon: false,
};
try {
  const migrations = await officialMigrations();
  stage = 'TLS fixture';
  if (process.env.G6_TEST_OPENSSL) {
    execFileSync(
      process.env.G6_TEST_OPENSSL,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=isolated-promotions-test',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-keyout',
        join(directory, 'server.key'),
        '-out',
        join(directory, 'server.crt'),
      ],
      { stdio: 'pipe', windowsHide: true },
    );
  } else
    execFileSync(
      process.env.G6_TEST_PYTHON ?? 'python',
      [
        resolve('apps/promotions-svc/test/support/create-probe-certificate.py'),
        directory,
      ],
      { stdio: 'pipe', windowsHide: true },
    );
  const certificate = join(directory, 'server.crt');
  stage = 'disposable PostgreSQL';
  const id = docker(
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      'g6-cueva-persistence-' + randomUUID(),
      '--publish',
      '127.0.0.1::5432',
      '--env',
      'POSTGRES_PASSWORD',
      '--mount',
      `type=bind,source=${directory},target=/test-tls,readonly`,
      'postgres:17-alpine',
      'sh',
      '-c',
      'cp /test-tls/server.key /tmp/server.key && cp /test-tls/server.crt /tmp/server.crt && chmod 600 /tmp/server.key && chmod 644 /tmp/server.crt && chown postgres /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key',
    ],
    { POSTGRES_PASSWORD: password },
  );
  created.push(id);
  const port = Number(
    JSON.parse(
      docker(['inspect', id, '--format', '{{json .NetworkSettings.Ports}}']),
    )['5432/tcp'][0].HostPort,
  );
  admin = new Pool({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: true, ca: readFileSync(certificate, 'utf8') },
    connectionTimeoutMillis: 1000,
  });
  await ready(() => admin.query('SELECT 1'));
  stage = 'official migrations in disposable database';
  await admin.query(
    'CREATE ROLE po_promotions_owner NOLOGIN; CREATE ROLE po_promotions_runtime NOLOGIN; CREATE SCHEMA promotions AUTHORIZATION po_promotions_owner',
  );
  const client = await admin.connect();
  try {
    await client.query('BEGIN; SET LOCAL ROLE po_promotions_owner');
    for (const migration of migrations) await client.query(migration);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  // Only disposable fixtures: no grants or provisioning against shared services.
  await admin.query(
    `CREATE ROLE promotions_test_login LOGIN PASSWORD '${password}' IN ROLE po_promotions_runtime; CREATE SCHEMA external_fixture; CREATE TABLE external_fixture.private_data(id integer); REVOKE ALL ON SCHEMA external_fixture FROM PUBLIC`,
  );
  const runtimeConfig = new PromotionsConfigService(
    validatePromotionsConfiguration({
      NODE_ENV: 'test',
      PGHOST: '127.0.0.1',
      PGPORT: String(port),
      PGDATABASE: 'postgres',
      PGUSER: 'promotions_test_login',
      PGPASSWORD: password,
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: certificate,
      G6_DATABASE_SCHEMA: 'promotions',
      G6_CONNECTION_MODE: 'session',
      RABBITMQ_URL: `amqp://synthetic:${password}@127.0.0.1:1/test`,
      PROMOTIONS_COUPON_RUNTIME_ENABLED: 'false',
      PROMOTIONS_DEPENDENCY_PROBES_ENABLED: 'false',
    }),
  );
  resources = nativeCouponResources(runtimeConfig);
  const persistence = new PromotionsPersistence(resources.pool);

  stage = 'mapping parity';
  for (const table of Object.values(schema)) {
    const mapping = getTableConfig(table);
    assert.equal(mapping.schema, 'promotions');
    const actual = (
      await admin.query(
        'SELECT column_name, is_nullable, data_type, udt_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position',
        ['promotions', mapping.name],
      )
    ).rows;
    assert.deepEqual(
      mapping.columns.map((c) => c.name).sort(),
      actual.map((c) => c.column_name).sort(),
      mapping.name + ' columns',
    );
    for (const column of mapping.columns) {
      const db = actual.find((c) => c.column_name === column.name);
      assert.equal(
        column.notNull,
        db.is_nullable === 'NO',
        mapping.name + '.' + column.name + ' nullability',
      );
      const types = {
        uuid: 'uuid',
        text: 'text',
        numeric: 'numeric',
        integer: 'integer',
        boolean: 'boolean',
        'timestamp with time zone': 'timestamp with time zone',
        bigint: 'bigint',
        jsonb: 'jsonb',
        'text[]': 'ARRAY',
      };
      assert.equal(
        types[column.getSQLType()],
        db.data_type,
        mapping.name + '.' + column.name + ' type',
      );
    }
    const constraints = (
      await admin.query(
        "SELECT c.conname, c.contype, c.confdeltype, n.nspname AS foreign_schema FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=t.relnamespace LEFT JOIN pg_class f ON f.oid=c.confrelid LEFT JOIN pg_namespace n ON n.oid=f.relnamespace WHERE ns.nspname=$1 AND t.relname=$2 AND c.contype IN ('p','f','u','c')",
        ['promotions', mapping.name],
      )
    ).rows;
    const mapped = [
      ...mapping.primaryKeys.map((k) => k.getName()),
      ...mapping.foreignKeys.map((k) => k.getName()),
      ...mapping.uniqueConstraints.map((k) => k.name),
      ...mapping.checks.map((k) => k.name),
    ];
    assert.deepEqual(
      mapped.sort(),
      constraints.map((c) => c.conname).sort(),
      mapping.name + ' constraints',
    );
    for (const foreign of mapping.foreignKeys) {
      assert.equal(
        constraints.find((c) => c.conname === foreign.getName()).foreign_schema,
        'promotions',
      );
      assert.equal(
        constraints.find((c) => c.conname === foreign.getName()).confdeltype,
        'r',
      );
    }
    const indexes = (
      await admin.query(
        'SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename=$2',
        ['promotions', mapping.name],
      )
    ).rows;
    const expectedIndexes = [
      ...mapping.indexes.map((i) => i.config.name),
      ...mapping.primaryKeys.map((k) => k.getName()),
      ...mapping.uniqueConstraints.map((k) => k.name),
    ];
    assert.deepEqual(
      expectedIndexes.sort(),
      indexes.map((i) => i.indexname).sort(),
      mapping.name + ' indexes',
    );
  }
  checks.push(
    '13 official tables: columns, types, nullability, PK/FK/unique/check names, indexes and restrictive own-schema FKs',
  );

  stage = 'runtime identity';
  const identity = await resources.pool.query(
    'SELECT current_user, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, ssl FROM pg_roles CROSS JOIN pg_stat_ssl WHERE rolname=current_user AND pid=pg_backend_pid()',
  );
  assert.deepEqual(identity.rows[0], {
    current_user: 'promotions_test_login',
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolbypassrls: false,
    ssl: true,
  });
  await assert.rejects(
    resources.pool.query('SELECT * FROM external_fixture.private_data'),
    { code: '42501' },
  );
  await assert.rejects(
    resources.pool.query('CREATE TABLE promotions.forbidden(id integer)'),
    { code: '42501' },
  );
  checks.push(
    'runtime login authenticates over verified TLS, has no admin flags, cannot read another schema or create DDL',
  );

  stage = 'aggregate repositories and exact numeric';
  const injection = "SYNTHETIC'); DROP SCHEMA promotions CASCADE; --";
  const saved = await persistence.transaction(async (repos) => {
    const saved = await repos.promotions.create(
      promotion({ name: injection }),
      scopes,
      policy,
    );
    const coupon = await repos.coupons.create({
      promotionId: saved.id,
      code: '  demo_repo  ',
      state: 'ACTIVO',
      minimumAmount: '0.00000000000000000001',
      maxGlobalUses: 2,
      cancellationPolicy: 'RESTAURAR_EN_CANCELACION',
    });
    return { saved, coupon };
  });
  const recovered = await persistence.read((repos) =>
    repos.promotions.findById(saved.saved.id),
  );
  assert.equal(recovered.name, injection);
  assert.equal(recovered.discountValue, '10.00000000000000000001');
  assert.deepEqual(recovered.enabledChannels, ['MARKETPLACE']);
  assert.equal(recovered.scopes[0].sku, 'SYNTHETIC-SKU');
  assert.equal(recovered.policy.coupon, false);
  const foundCoupon = await persistence.read((repos) =>
    repos.coupons.findByCode(' demo_repo '),
  );
  assert.equal(foundCoupon.code, 'DEMO_REPO');
  assert.equal(foundCoupon.minimumAmount, '0.00000000000000000001');
  assert.equal(
    await persistence.read((repos) => repos.promotions.findById(randomUUID())),
    undefined,
  );
  await persistence.transaction((repos) =>
    repos.coupons.update(saved.coupon.id, { maxGlobalUses: 3 }),
  );
  checks.push(
    'promotion/scope/policy/coupon commit atomically, quoted input remains data, canonical code and decimals retain precision',
  );

  stage = 'constraint rollback';
  let rolledBackId;
  await rejected(
    persistence.transaction(async (repos) => {
      const p = await repos.promotions.create(promotion(), scopes, policy);
      rolledBackId = p.id;
      await repos.coupons.create({
        promotionId: p.id,
        code: 'DEMO_REPO',
        state: 'ACTIVO',
        cancellationPolicy: 'NO_RESTAURAR',
      });
    }),
    '23505',
  );
  assert.equal(
    await persistence.read((repos) => repos.promotions.findById(rolledBackId)),
    undefined,
  );
  await rejected(
    persistence.transaction((repos) =>
      repos.coupons.create({
        promotionId: randomUUID(),
        code: 'ORPHAN',
        state: 'ACTIVO',
        cancellationPolicy: 'NO_RESTAURAR',
      }),
    ),
  );
  await rejected(
    persistence.transaction((repos) =>
      repos.promotions.create(
        promotion({ discountValue: '101' }),
        scopes,
        policy,
      ),
    ),
    '23514',
  );
  await rejected(
    persistence.transaction((repos) =>
      repos.promotions.create(
        promotion({ enabledChannels: ['MARKETPLACE', 'MARKETPLACE'] }),
        scopes,
        policy,
      ),
    ),
    '23514',
  );
  await rejected(
    persistence.transaction((repos) =>
      repos.promotions.create(
        promotion({ validUntil: '2026-09-01T00:00:00Z' }),
        scopes,
        policy,
      ),
    ),
    '23514',
  );
  await rejected(
    persistence.transaction((repos) =>
      repos.promotions.create(
        promotion(),
        [{ productId: 'PRODUCT', sku: 'SKU' }],
        policy,
      ),
    ),
    '23514',
  );
  await rejected(
    persistence.transaction((repos) =>
      repos.promotions.create(promotion(), [], policy),
    ),
    'P0001',
  );
  await rejected(
    persistence.read((repos) =>
      repos.promotions.update(saved.saved.id, {
        name: 'FORBIDDEN-READ-MUTATION',
      }),
    ),
    '25006',
  );
  checks.push(
    'duplicate, FK/trigger, percentage, channel, dates, scope and deferred completeness failures roll back; read transactions reject writes',
  );

  stage = 'application rollback and connection reuse';
  let callbackRollbackId;
  await rejected(
    persistence.transaction(async (repos) => {
      callbackRollbackId = (
        await repos.promotions.create(promotion(), scopes, policy)
      ).id;
      throw new Error('synthetic failure ' + password);
    }),
  );
  assert.equal(
    await persistence.read((repos) =>
      repos.promotions.findById(callbackRollbackId),
    ),
    undefined,
  );
  assert.equal(
    (
      await persistence.read((repos) =>
        repos.promotions.findById(saved.saved.id),
      )
    ).name,
    injection,
  );
  checks.push(
    'application failures roll back and pool remains reusable; caller sees no raw error or secret',
  );

  stage = 'recommendation repository';
  const rule = await persistence.transaction((repos) =>
    repos.recommendations.create(
      {
        name: 'SYNTHETIC-RECOMMENDATION',
        recommendationType: 'UPSELL',
        originType: 'PRODUCTO',
        originId: 'SYNTHETIC-ORIGIN',
        priority: 1,
        state: 'ACTIVO',
        validFrom: '2026-10-01T00:00:00Z',
        validUntil: '2026-12-01T00:00:00Z',
      },
      [
        {
          productId: 'SYNTHETIC-TARGET',
          itemOrder: 1,
          superiorityCriterion: 'MAYOR_CAPACIDAD',
          commercialJustification: 'Isolated fixture',
        },
      ],
    ),
  );
  assert.equal(
    (await persistence.read((repos) => repos.recommendations.findById(rule.id)))
      .items[0].productId,
    'SYNTHETIC-TARGET',
  );
  await persistence.transaction((repos) =>
    repos.recommendations.update(rule.id, { priority: 2 }),
  );
  await rejected(
    persistence.transaction((repos) =>
      repos.recommendations.create(
        {
          name: 'INCOMPLETE',
          recommendationType: 'UPSELL',
          originType: 'PRODUCTO',
          originId: 'SYNTHETIC-ORIGIN',
          priority: 1,
          state: 'ACTIVO',
          validFrom: '2026-10-01T00:00:00Z',
          validUntil: '2026-12-01T00:00:00Z',
        },
        [],
      ),
    ),
    'P0001',
  );
  checks.push(
    'recommendation/items persist and deferred completeness rolls back an incomplete aggregate',
  );

  stage = 'projection mapping';
  const snapshot = { id: 'SYNTHETIC', note: "quoted ' value" };
  const version = '9007199254740993';
  await resources.pool.query(
    "INSERT INTO promotions.catalog_projection(reference_type,reference_id,product_id,active,snapshot,source_version,source_occurred_at,source_message_id) VALUES ('SKU','SYNTHETIC-SKU','SYNTHETIC-PRODUCT',true,$1,$2,'2026-10-16', 'catalog-fixture')",
    [snapshot, version],
  );
  await resources.pool.query(
    "INSERT INTO promotions.price_projection(sku,channel_id,snapshot,source_version,source_occurred_at,source_message_id) VALUES ('SYNTHETIC-SKU',NULL,$1,$2,'2026-10-16','price-global'), ('SYNTHETIC-SKU','MARKETPLACE',$1,$2,'2026-10-16','price-channel')",
    [snapshot, version],
  );
  await resources.pool.query(
    "INSERT INTO promotions.stock_projection(sku,availability,snapshot,source_version,source_occurred_at,source_message_id) VALUES ('SYNTHETIC-SKU','DISPONIBLE',$1,$2,'2026-10-16','stock-fixture')",
    [snapshot, version],
  );
  assert.equal(
    (await persistence.read((repos) => repos.catalog('SKU', 'SYNTHETIC-SKU')))
      .sourceVersion,
    9007199254740993n,
  );
  assert.deepEqual(
    (await persistence.read((repos) => repos.price('SYNTHETIC-SKU', null)))
      .snapshot,
    snapshot,
  );
  assert.equal(
    (
      await persistence.read((repos) =>
        repos.price('SYNTHETIC-SKU', 'MARKETPLACE'),
      )
    ).channelId,
    'MARKETPLACE',
  );
  assert.equal(
    (await persistence.read((repos) => repos.stock('SYNTHETIC-SKU')))
      .availability,
    'DISPONIBLE',
  );
  await assert.rejects(
    resources.pool.query(
      "INSERT INTO promotions.price_projection(sku,channel_id,snapshot,source_occurred_at,source_message_id) VALUES ('SYNTHETIC-SKU',NULL,'{}','2026-10-16','duplicate-global')",
    ),
    { code: '23505' },
  );
  checks.push(
    'projection JSON, timestamps, bigint above JS safe range and global NULL/channel price keys map correctly',
  );

  stage = 'coupon core shares pool and transaction boundary';
  const command = {
    message_id: randomUUID(),
    operation_id: randomUUID(),
    schema_version: 2,
    occurred_at: '2026-10-16T12:00:00Z',
    correlation_id: 'persistence-fixture',
    causation_id: 'isolated-order-event',
    producer: 'modulo-ventas',
    kind: 'command',
    name: 'promotions.coupon.consumption.requested',
    data: {
      order_id: 'ISOLATED-' + randomUUID(),
      coupon_code: 'DEMO_REPO',
      channel_id: 'MARKETPLACE',
      reservation_id: randomUUID(),
      commercial_snapshot_ref: 'isolated-snapshot',
      effective_at: '2026-10-16T12:00:00Z',
    },
  };
  // Fixture evidence tests persistence only; it does not satisfy the external #33 gate.
  const processor = new CouponCommandProcessor(resources.pool, {
    verify: async ({ data }) => ({
      reservationConfirmed: true,
      snapshotDurable: true,
      eligible: true,
      orderId: data.order_id,
      reservationId: data.reservation_id,
      commercialSnapshotRef: data.commercial_snapshot_ref,
    }),
  });
  const result = await processor.process(command, 'modulo-ventas');
  assert.match(result.name, /consumption.completed$/);
  assert.deepEqual(await processor.process(command, 'modulo-ventas'), result);
  assert.equal(
    (
      await persistence.read((repos) =>
        repos.coupons.listUses(command.data.order_id),
      )
    ).length,
    1,
  );
  assert.equal(
    (await persistence.read((repos) => repos.receipt(command.operation_id)))
      .status,
    'COMPLETED',
  );
  assert.deepEqual(
    (
      await persistence.read((repos) =>
        repos.inbox(command.message_id, 'coupon-commands-v2'),
      )
    ).result,
    result,
  );
  assert.deepEqual(
    (await persistence.read((repos) => repos.outbox(result.message_id))).data,
    result.data,
  );
  await assert.rejects(
    resources.pool.query('DELETE FROM promotions.coupon_uses'),
    { code: '42501' },
  );
  await assert.rejects(
    resources.pool.query(
      'UPDATE promotions.coupon_command_receipts SET request_fingerprint=$1 WHERE operation_id=$2',
      ['a'.repeat(64), command.operation_id],
    ),
    { code: '42501' },
  );
  checks.push(
    'existing coupon command replays once; Drizzle reads use/receipt/inbox/outbox on the same pool; history and fingerprint remain protected',
  );

  stage = 'HTTP queries and signed JWT with real PostgreSQL';
  checks.push(...(await verifyH4Invalidations(resources.pool)));
  checks.push(...(await verifyHttpWrites(resources, runtimeConfig, admin)));
  checks.push(...(await verifyHttpUpstreams(resources, runtimeConfig)));
  checks.push(...(await verifyHttpReadQueries(resources, runtimeConfig)));
  if (process.env.G6_PROMOTIONS_GATEWAY_E2E === 'true') {
    stage = 'native Gateway/Promotions flow with real PostgreSQL';
    // The provider suite closes its pool to verify 503. A new restricted pool
    // runs afterwards, so Gateway fixtures cannot alter its pagination/empty
    // assertions. No provider tests are skipped or weakened.
    const gatewayResources = nativeCouponResources(runtimeConfig);
    try {
      const { verifyGatewayFlow } =
        await import('./support/gateway-flow-checks.mjs');
      checks.push(
        ...(await verifyGatewayFlow(
          gatewayResources,
          runtimeConfig,
          directory,
        )),
      );
    } finally {
      await gatewayResources.onApplicationShutdown();
    }
  }
  console.log(
    JSON.stringify({
      status: 'PASS',
      docsRevision,
      checks,
      deployment: 'not tested',
      externalIntegration: 'not tested',
      sharedWrites: false,
    }),
  );
} catch (error) {
  // No connection string, query parameters, PostgreSQL detail or fixture password.
  console.error(
    JSON.stringify({
      status: 'FAIL',
      stage,
      code:
        error instanceof assert.AssertionError
          ? error.message.replaceAll(password, '[redacted]')
          : 'ISOLATED_PERSISTENCE_CHECK_FAILED',
    }),
  );
  process.exitCode = 1;
} finally {
  await resources?.onApplicationShutdown().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  for (const id of created.reverse()) {
    try {
      docker(['rm', '--force', id]);
    } catch {
      /* already removed */
    }
  }
  rmSync(directory, { recursive: true, force: true });
}
