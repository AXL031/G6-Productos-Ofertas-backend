import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  columns,
  prepareBatch,
  renderRows,
  renderRollback,
  renderSnapshot,
} from '../prepare-batch.mjs';
import { isolatedBindings } from './support/bindings.mjs';

// One newly created local container for the suite. No .env, shared DSN or caller target.
assert.equal(
  process.argv.length,
  2,
  'NO_TARGET_OR_EXECUTION_OPTIONS_SUPPORTED',
);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const { Pool } = createRequire(resolve(root, 'package.json'))('pg');
const commit = 'c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b';
const migrations = [
  ['0001_promotions_persistence', '3c1636e9738efd939d1e646be8059f4e9c0455bf'],
  [
    '0002_promotions_global_price_projection',
    'c04397a73de76105f15386afd4adcd5bdb2df757',
  ],
  [
    '0003_promotions_timestamps_and_delete_rules',
    '77ba7d71c7337760eba3c31f4895e177d5398ef6',
  ],
  [
    '0004_coupon_idempotency_receipts',
    'c3a255b08d6b0450998b77e21b90b9b6b53d27bb',
  ],
];
const migrationSources = [];
const sqlSources = [];
for (const [name, expected] of migrations) {
  const path = resolve(
    root,
    `node_modules/.cache/promotions-work/datos_promotions_migrations_${name}.sql`,
  );
  let sql;
  try {
    sql = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(
      `https://raw.githubusercontent.com/Taller-SW-Web/G6-Productos-Ofertas-docs/${commit}/datos/promotions/migrations/${name}.sql`,
    );
    assert.equal(response.status, 200, 'OFFICIAL_MIGRATION_UNAVAILABLE');
    sql = await response.text();
  }
  const bytes = Buffer.from(sql.replaceAll('\r\n', '\n'));
  assert.equal(
    createHash('sha1')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex'),
    expected,
    'OFFICIAL_MIGRATION_CHANGED',
  );
  sqlSources.push(bytes.toString());
  migrationSources.push({
    name,
    git_blob: expected,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

function docker(args, env = process.env) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 90000,
    windowsHide: true,
    env,
  });
  assert.equal(result.status, 0, 'ISOLATED_DOCKER_FAILED');
  return result.stdout.trim();
}
let container, pool;
const checks = [];
try {
  assert.ok(
    !process.env.DOCKER_HOST,
    'EXPLICIT_REMOTE_DOCKER_HOST_NOT_ALLOWED',
  );
  assert.match(
    docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']),
    /^(?:npipe|unix):\/\//,
    'LOCAL_DOCKER_CONTEXT_REQUIRED',
  );
  const password = randomUUID();
  container = docker(
    [
      'run',
      '--rm',
      '--detach',
      '--name',
      `g6-cueva-data-${randomUUID()}`,
      '--publish',
      '127.0.0.1::5432',
      '--env',
      'POSTGRES_PASSWORD',
      'postgres:17-alpine',
    ],
    { ...process.env, POSTGRES_PASSWORD: password },
  );
  const ports = JSON.parse(
    docker([
      'inspect',
      container,
      '--format',
      '{{json .NetworkSettings.Ports}}',
    ]),
  );
  pool = new Pool({
    host: '127.0.0.1',
    port: Number(ports['5432/tcp'][0].HostPort),
    user: 'postgres',
    password,
    database: 'postgres',
    ssl: false,
    options: '',
    connectionTimeoutMillis: 1000,
    max: 2,
  });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try {
      await pool.query('SELECT 1');
      ready = true;
    } catch {
      await delay(500);
    }
  }
  assert.ok(ready, 'ISOLATED_POSTGRES_START_TIMEOUT');
  await pool.query(
    'CREATE ROLE po_promotions_owner NOLOGIN; CREATE ROLE po_promotions_runtime NOLOGIN; CREATE ROLE po_promotions_seed NOLOGIN NOINHERIT; CREATE SCHEMA promotions AUTHORIZATION po_promotions_owner; REVOKE ALL ON SCHEMA promotions FROM PUBLIC',
  );
  const setup = await pool.connect();
  try {
    await setup.query('BEGIN; SET LOCAL ROLE po_promotions_owner');
    for (const sql of sqlSources) await setup.query(sql);
    await setup.query(`GRANT USAGE ON SCHEMA promotions TO po_promotions_seed;
      GRANT SELECT,INSERT ON ${Object.keys(columns)
        .map((table) => `promotions.${table}`)
        .join(',')} TO po_promotions_seed;
      GRANT EXECUTE ON FUNCTION promotions.fn_valid_channels(text[]),promotions.fn_normalize_code(text) TO po_promotions_seed; COMMIT;`);
  } finally {
    setup.release();
  }

  const allTables = (
    await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='promotions' ORDER BY tablename",
    )
  ).rows.map((r) => r.tablename);
  // A valid unrelated aggregate must survive every successful/rejected trial.
  await pool.query(`BEGIN; SET LOCAL ROLE po_promotions_owner;
    INSERT INTO promotions.promotions(id,name,discount_type,discount_value,modality,state,valid_from,valid_until,priority,enabled_channels)
    VALUES ('00000000-0000-4000-8000-000000000001','TEST_ONLY_EXISTING','PORCENTAJE',1,'AUTOMATICA','INACTIVO','2026-11-01','2026-12-01',1,ARRAY['RETAIL']);
    INSERT INTO promotions.promotion_scopes(promotion_id,sku) VALUES ('00000000-0000-4000-8000-000000000001','TEST_ONLY_EXISTING_SKU');
    INSERT INTO promotions.combination_policy VALUES ('00000000-0000-4000-8000-000000000001',false,false,false);
    COMMIT;`);
  const snapshot = async () => {
    const tables = {};
    for (const table of allTables) {
      // Identifiers come exclusively from the official schema, never the bindings.
      assert.match(table, /^[a-z_]+$/);
      tables[table] = (
        await pool.query(
          `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM promotions.${table} t`,
        )
      ).rows[0].rows;
    }
    return tables;
  };
  const structure = async () =>
    (
      await pool.query(`SELECT table_name,column_name,data_type,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema='promotions' ORDER BY table_name,ordinal_position`)
    ).rows;
  const baseline = await snapshot();
  const structureBefore = await structure();
  const batch = prepareBatch(isolatedBindings());
  const rendered = renderRows(batch);
  async function transaction(role, work) {
    assert.ok(['po_promotions_owner', 'po_promotions_seed'].includes(role));
    const client = await pool.connect();
    try {
      await client.query(
        `BEGIN; SET LOCAL ROLE ${role}; SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='2s'`,
      );
      assert.equal(
        (await client.query('SELECT current_user AS role')).rows[0].role,
        role,
      );
      await work(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    assert.deepEqual(
      await snapshot(),
      baseline,
      'ROLLBACK_MUST_RESTORE_EVERY_TABLE',
    );
  }
  async function rejected(work, code, role = 'po_promotions_owner') {
    await assert.rejects(
      () => transaction(role, work),
      (error) => error.code === code,
    );
    assert.deepEqual(await snapshot(), baseline);
  }

  await transaction('po_promotions_seed', async (client) => {
    for (const table of Object.keys(columns)) {
      const p = (
        await client.query(
          "SELECT has_table_privilege(current_user,$1,'SELECT') AS can_read, has_table_privilege(current_user,$1,'INSERT') AS can_insert, has_any_column_privilege(current_user,$1,'UPDATE') AS can_update, has_table_privilege(current_user,$1,'DELETE,TRUNCATE') AS can_destroy",
          [`promotions.${table}`],
        )
      ).rows[0];
      assert.deepEqual(p, {
        can_read: true,
        can_insert: true,
        can_update: false,
        can_destroy: false,
      });
    }
    assert.equal(
      (
        await client.query(
          "SELECT has_schema_privilege(current_user,'promotions','CREATE') AS allowed",
        )
      ).rows[0].allowed,
      false,
    );
  });
  for (const sql of [
    'UPDATE promotions.promotions SET name=name',
    'DELETE FROM promotions.promotions',
    'TRUNCATE promotions.promotions',
    'CREATE TABLE promotions.forbidden(id integer)',
    'SELECT * FROM promotions.outbox',
  ])
    await rejected(
      (client) => client.query(sql),
      '42501',
      'po_promotions_seed',
    );
  checks.push(
    'seed role: SELECT/INSERT only; UPDATE/DELETE/TRUNCATE/DDL/technical reads rejected',
  );

  await rejected(
    async (client) => {
      await client.query(rendered.inserts.split('\n')[0]);
      const p = batch.rows.promotion_scopes[0];
      await client.query(
        'INSERT INTO promotions.promotion_scopes(id,promotion_id,sku) VALUES ($1,$2,$3)',
        [p.id, p.promotion_id, p.sku],
      );
    },
    '42501',
    'po_promotions_seed',
  );
  await rejected(
    async (client) => {
      const rule = batch.rows.recommendation_rules[0];
      await client.query(
        "INSERT INTO promotions.recommendation_rules(id,name,recommendation_type,origin_type,origin_id,priority,state,valid_from,valid_until) VALUES ($1,$2,'CROSS_SELL','PRODUCTO',$3,1,'INACTIVO',$4,$5)",
        [rule.id, rule.name, rule.origin_id, rule.valid_from, rule.valid_until],
      );
      await client.query(
        'INSERT INTO promotions.recommendation_items(rule_id,product_id,item_order) VALUES ($1,$2,1)',
        [rule.id, batch.rows.recommendation_items[0].product_id],
      );
    },
    '42501',
    'po_promotions_seed',
  );
  const previewClient = await pool.connect();
  try {
    await assert.rejects(
      () => previewClient.query(renderRollback(batch)),
      (error) =>
        error.code === 'P0001' &&
        error.message === 'SEED_TRIGGER_LOCK_PRIVILEGE_UNRESOLVED',
    );
  } finally {
    await previewClient.query('ROLLBACK');
    previewClient.release();
  }
  assert.deepEqual(await snapshot(), baseline);
  checks.push(
    'current append-only seed cannot satisfy invoker FOR UPDATE triggers; preview fails before inserts',
  );

  await transaction('po_promotions_owner', async (client) => {
    const baselineReports = (await client.query(renderSnapshot())).map(
      (result) => result.rows,
    );
    await client.query(rendered.inserts);
    await client.query(rendered.assertions);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    const first = await snapshot();
    // Uncommitted rows must not be visible on another connection.
    assert.deepEqual(first, baseline);
    const before = [];
    for (const table of Object.keys(columns))
      before.push(
        (
          await client.query(
            `SELECT to_jsonb(t) AS row FROM promotions.${table} t ORDER BY to_jsonb(t)::text`,
          )
        ).rows,
      );
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(rendered.inserts);
    await client.query(rendered.assertions);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    const after = [];
    for (const table of Object.keys(columns))
      after.push(
        (
          await client.query(
            `SELECT to_jsonb(t) AS row FROM promotions.${table} t ORDER BY to_jsonb(t)::text`,
          )
        ).rows,
      );
    assert.deepEqual(
      after,
      before,
      'REPLAY_MUST_NOT_TOUCH_TIMESTAMPS_OR_CONTENT',
    );
    assert.deepEqual(
      after.map((rows) => rows.length),
      [3, 3, 3, 1, 2, 2],
    );
    assert.deepEqual(
      (await client.query(renderSnapshot())).map((result) =>
        Number(result.rows[0].row_count),
      ),
      [3, 3, 3, 1, 2, 2],
    );
    await client.query('ROLLBACK; BEGIN; SET LOCAL ROLE po_promotions_owner');
    assert.deepEqual(
      (await client.query(renderSnapshot())).map((result) => result.rows),
      baselineReports,
    );
  });
  checks.push(
    'owner-only isolated proof: all six masters, two identical passes, deferred constraints, unchanged timestamps, rollback',
  );

  const inherited = isolatedBindings();
  for (const price of inherited.pricing.prices) {
    price.product_id = inherited.catalog.skus.find(
      (s) => s.sku === price.sku,
    ).product_id;
    price.sku = null;
    price.valid_until = null;
  }
  const inheritedBatch = prepareBatch(inherited);
  assert.deepEqual(inheritedBatch.rows, batch.rows);
  await transaction('po_promotions_owner', async (client) => {
    const sql = renderRows(inheritedBatch);
    await client.query(sql.inserts);
    await client.query(sql.assertions);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  });
  checks.push(
    'parent-price inheritance and open validities produce identical inactive masters; isolated rollback verified',
  );

  for (const change of [
    (d) => {
      d.proposed_rows.promotions[0].name += ' changed';
    },
    (d) => {
      d.proposed_rows.coupons[0].id = randomUUID();
    },
  ])
    await rejected(async (client) => {
      await client.query(rendered.inserts);
      const draft = JSON.parse(
        readFileSync(
          new URL('../inka-athletics-draft.json', import.meta.url),
          'utf8',
        ),
      );
      change(draft);
      const altered = renderRows(prepareBatch(isolatedBindings(), draft));
      await client.query(altered.inserts);
      await client.query(altered.assertions);
    }, '22012');
  await rejected(async (client) => {
    await client.query(rendered.inserts);
    await client.query(
      'INSERT INTO promotions.promotion_scopes(promotion_id,sku) VALUES ($1,$2)',
      [batch.rows.promotions[0].id, 'TEST_ONLY_EXTRA'],
    );
    await client.query(rendered.assertions);
  }, '22012');
  checks.push(
    'changed PK content, same coupon code with new ID, and extra aggregate child abort without overwrites',
  );

  await rejected(
    (client) =>
      client.query(
        "INSERT INTO promotions.promotions(name,discount_type,discount_value,modality,state,valid_from,valid_until,priority,enabled_channels) VALUES ('test','PORCENTAJE',100.001,'AUTOMATICA','INACTIVO','2026-11-01','2026-12-01',1,ARRAY['RETAIL'])",
      ),
    '23514',
  );
  await rejected(async (client) => {
    await client.query(rendered.inserts.split('\n')[0]);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  }, 'P0001');
  await rejected(
    (client) =>
      client.query(
        'INSERT INTO promotions.promotion_scopes(promotion_id,sku) VALUES ($1,$2)',
        [randomUUID(), 'TEST_ONLY_ORPHAN'],
      ),
    '23503',
  );
  await rejected(async (client) => {
    await client.query(rendered.inserts);
    await client.query(
      'INSERT INTO promotions.recommendation_items(rule_id,product_id,item_order) VALUES ($1,$2,2)',
      [
        batch.rows.recommendation_rules[0].id,
        batch.rows.recommendation_rules[0].origin_id,
      ],
    );
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  }, 'P0001');
  checks.push(
    'official CHECK/FK/deferred completeness/self-recommendation constraints remain enabled and reject invalid rows',
  );

  await transaction('po_promotions_owner', async (client) => {
    const draft = JSON.parse(
      readFileSync(
        new URL('../inka-athletics-draft.json', import.meta.url),
        'utf8',
      ),
    );
    const hostile = "Running '); COMMIT; -- \\ $guard$\n";
    draft.proposed_rows.promotions[0].name = hostile;
    const safe = renderRows(prepareBatch(isolatedBindings(), draft));
    await client.query(safe.inserts);
    await client.query(safe.assertions);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    assert.equal(
      (
        await client.query(
          'SELECT name FROM promotions.promotions WHERE id=$1',
          [batch.rows.promotions[0].id],
        )
      ).rows[0].name,
      hostile,
    );
  });
  assert.deepEqual(await structure(), structureBefore);
  assert.deepEqual(await snapshot(), baseline);
  checks.push(
    'SQL-like text round-trips literally; all master and operational data plus table structure unchanged after rollback',
  );

  const report = {
    result: 'PASS',
    scope: 'DISPOSABLE_LOCAL_ONLY',
    captured_at: new Date().toISOString(),
    backend_base_sha: spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).stdout.trim(),
    postgres_version: (await pool.query('SHOW server_version')).rows[0]
      .server_version,
    postgres_image: docker(['inspect', container, '--format', '{{.Image}}']),
    normative_commit: commit,
    batch_content_sha256: batch.content_sha256,
    tooling_sha256_lf: Object.fromEntries(
      [
        '../prepare-batch.mjs',
        '../prepare-batch.test.mjs',
        '../validate-draft.mjs',
        '../validate-draft.test.mjs',
        '../inka-athletics-draft.json',
        '../bindings.template.json',
        '../reconcile.mjs',
        '../reconcile.test.mjs',
        './isolated.mjs',
        './support/bindings.mjs',
      ].map((path) => [
        path,
        createHash('sha256')
          .update(
            readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll(
              '\r\n',
              '\n',
            ),
          )
          .digest('hex'),
      ]),
    ),
    migrations: migrationSources,
    checks,
    isolated_rows_per_pass: Object.fromEntries(
      Object.entries(batch.rows).map(([table, rows]) => [table, rows.length]),
    ),
    proof_role:
      'po_promotions_owner (isolated only; not a seed permission proof)',
    seed_role: 'po_promotions_seed',
    seed_negative_sqlstate: '42501',
    preview_guard_error: 'SEED_TRIGGER_LOCK_PRIVILEGE_UNRESOLVED',
    seed_master_load: 'BLOCKED_TRIGGER_ROW_LOCK_PRIVILEGE',
    all_data_rollback_verified: true,
    preexisting_aggregate_preserved: true,
    shared_sql_executed: false,
    shared_data_persisted: false,
    real_catalog_pricing_references: false,
    external_approval: false,
    deployment: false,
  };
  const directory = new URL('./evidence/', import.meta.url);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    new URL(
      `isolated-${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' })}.json`,
      directory,
    ),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  try {
    if (pool) await pool.end();
  } finally {
    if (container) docker(['rm', '--force', container]);
  }
}
