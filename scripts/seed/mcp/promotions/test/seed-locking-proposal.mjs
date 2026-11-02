import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  columns,
  prepareBatch,
  renderRows,
  renderRollback,
} from '../prepare-batch.mjs';
import { isolatedBindings } from './support/bindings.mjs';

// No caller DSN, .env, shared connection, migration writer or apply mode.
assert.equal(
  process.argv.length,
  2,
  'NO_TARGET_OR_EXECUTION_OPTIONS_SUPPORTED',
);
assert.ok(!process.env.DOCKER_HOST, 'REMOTE_DOCKER_NOT_ALLOWED');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const { Pool } = createRequire(resolve(root, 'package.json'))('pg');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
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
].map(([name, expected]) => {
  const sql = readFileSync(
    resolve(
      root,
      `node_modules/.cache/promotions-work/datos_promotions_migrations_${name}.sql`,
    ),
    'utf8',
  ).replaceAll('\r\n', '\n');
  assert.equal(
    createHash('sha1')
      .update(`blob ${Buffer.byteLength(sql)}\0${sql}`)
      .digest('hex'),
    expected,
    'OFFICIAL_MIGRATION_CHANGED',
  );
  return { name, git_blob: expected, sha256: hash(sql), sql };
});
const fixture = readFileSync(
  new URL('./support/seed-locking-proposal.sql', import.meta.url),
  'utf8',
);
function docker(args, env = process.env) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 90000,
    env,
  });
  assert.equal(result.status, 0, 'ISOLATED_DOCKER_FAILED');
  return result.stdout.trim();
}
assert.match(
  docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']),
  /^(?:npipe|unix):\/\//,
  'LOCAL_DOCKER_REQUIRED',
);
const password = randomUUID();
let container, admin, seed, inherited, runtime, report;
const checks = [];
try {
  container = docker(
    [
      'run',
      '--rm',
      '--detach',
      '--name',
      `g6-cueva-locking-${randomUUID()}`,
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
  const config = {
    host: '127.0.0.1',
    port: Number(ports['5432/tcp'][0].HostPort),
    password,
    database: 'postgres',
    ssl: false,
    options: '',
    connectionTimeoutMillis: 1000,
    max: 2,
  };
  admin = new Pool({ ...config, user: 'postgres' });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try {
      await admin.query('SELECT 1');
      ready = true;
    } catch {
      await delay(500);
    }
  }
  assert.ok(ready, 'POSTGRES_START_TIMEOUT');
  await admin.query(`CREATE ROLE po_promotions_owner NOLOGIN; CREATE ROLE po_promotions_seed NOLOGIN NOINHERIT;
    CREATE ROLE po_promotions_runtime NOLOGIN;
    CREATE ROLE test_seed_login LOGIN NOINHERIT PASSWORD '${password}';
    CREATE ROLE test_seed_inherited LOGIN INHERIT PASSWORD '${password}';
    CREATE ROLE test_seed_delegate NOLOGIN;
    CREATE ROLE test_runtime_login LOGIN NOINHERIT PASSWORD '${password}';
    GRANT po_promotions_seed TO test_seed_login, test_seed_inherited;
    GRANT test_seed_delegate TO test_seed_login;
    GRANT po_promotions_runtime TO test_runtime_login;
    CREATE SCHEMA promotions AUTHORIZATION po_promotions_owner;
    REVOKE ALL ON SCHEMA promotions FROM PUBLIC;`);
  const installer = await admin.connect();
  try {
    await installer.query('BEGIN; SET LOCAL ROLE po_promotions_owner');
    for (const m of migrations) await installer.query(m.sql);
    await installer.query(`GRANT USAGE ON SCHEMA promotions TO po_promotions_seed;
      GRANT SELECT,INSERT ON ${Object.keys(columns)
        .map((t) => `promotions.${t}`)
        .join(',')} TO po_promotions_seed;
      GRANT EXECUTE ON FUNCTION promotions.fn_valid_channels(text[]),promotions.fn_normalize_code(text) TO po_promotions_seed; COMMIT;`);
  } finally {
    installer.release();
  }
  seed = new Pool({ ...config, user: 'test_seed_login' });
  inherited = new Pool({ ...config, user: 'test_seed_inherited' });
  runtime = new Pool({ ...config, user: 'test_runtime_login' });
  const tables = (
    await admin.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='promotions' ORDER BY tablename",
    )
  ).rows.map((r) => r.tablename);
  assert.ok(tables.every((t) => /^[a-z_]+$/.test(t)));
  const snapshot = async () =>
    Object.fromEntries(
      await Promise.all(
        tables.map(async (t) => [
          t,
          (
            await admin.query(
              `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS data FROM promotions.${t} t`,
            )
          ).rows[0].data,
        ]),
      ),
    );
  const definitions = async () =>
    (
      await admin.query(
        "SELECT p.proname, pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='promotions' AND p.proname <> 'test_seed_append_only_guard' ORDER BY p.proname",
      )
    ).rows;
  const originalDefinitions = await definitions();
  const empty = await snapshot();
  const batch = prepareBatch(isolatedBindings());
  const rendered = renderRows(batch);
  async function tx(pool, role, work) {
    const c = await pool.connect();
    try {
      await c.query(
        "BEGIN; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='250ms'",
      );
      if (role) {
        assert.ok(
          [
            'po_promotions_seed',
            'po_promotions_owner',
            'test_seed_delegate',
            'po_promotions_runtime',
          ].includes(role),
        );
        await c.query(`SET LOCAL ROLE ${role}`);
      }
      return await work(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }
  async function rejected(pool, role, sql, code = '42501', message) {
    await assert.rejects(
      () => tx(pool, role, (c) => c.query(sql)),
      (e) => e.code === code && (!message || e.message === message),
    );
  }
  await tx(seed, 'po_promotions_seed', async (c) => {
    const identity = (
      await c.query(
        'SELECT current_user AS role,session_user AS login,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=session_user) AS privileged',
      )
    ).rows[0];
    assert.deepEqual(identity, {
      role: 'po_promotions_seed',
      login: 'test_seed_login',
      privileged: false,
    });
  });
  await assert.rejects(
    () =>
      tx(seed, 'po_promotions_seed', async (c) => {
        await c.query(rendered.inserts);
      }),
    (e) => e.code === '42501',
  );
  assert.deepEqual(await snapshot(), empty);
  checks.push(
    'Original SELECT/INSERT-only seed reproduces 42501 through unchanged invoker triggers; authenticated non-superuser login',
  );

  await tx(admin, 'po_promotions_owner', async (c) => {
    await c.query(fixture);
    await c.query('COMMIT');
  });
  // A NOINHERIT login can SET ROLE away from seed; session_user must still guard it.
  await admin.query(`GRANT USAGE ON SCHEMA promotions TO test_seed_delegate;
    GRANT SELECT,UPDATE(id) ON promotions.promotions,promotions.recommendation_rules TO test_seed_delegate;`);
  for (const table of ['promotions', 'recommendation_rules'])
    await rejected(
      seed,
      'test_seed_delegate',
      `UPDATE promotions.${table} SET id=id WHERE false`,
      '42501',
      'SEED_APPEND_ONLY',
    );
  await tx(runtime, 'po_promotions_runtime', async (c) => {
    assert.equal(
      (
        await c.query(
          "SELECT pg_has_role(session_user,'po_promotions_seed','MEMBER') AS seed",
        )
      ).rows[0].seed,
      false,
    );
    await c.query('UPDATE promotions.promotions SET name=name WHERE false');
  });
  checks.push(
    'SET ROLE escape by NOINHERIT seed login rejected through session_user membership; independent authenticated runtime remains writable',
  );
  await admin.query(
    'ALTER ROLE po_promotions_seed RENAME TO test_missing_seed_role',
  );
  try {
    await rejected(
      runtime,
      'po_promotions_runtime',
      'UPDATE promotions.promotions SET name=name WHERE false',
      '42501',
      'SEED_ROLE_UNAVAILABLE',
    );
  } finally {
    await admin.query(
      'ALTER ROLE test_missing_seed_role RENAME TO po_promotions_seed',
    );
  }
  checks.push(
    'Missing expected seed role fails closed even for independent runtime; role restored in disposable database',
  );
  await tx(seed, 'po_promotions_seed', async (c) => {
    for (const t of Object.keys(columns)) {
      const p = (
        await c.query(
          "SELECT has_table_privilege(current_user,$1,'UPDATE') AS general_update,has_column_privilege(current_user,$1,$2,'UPDATE') AS id_update,has_any_column_privilege(current_user,$1,'UPDATE') AS any_update,has_table_privilege(current_user,$1,'DELETE,TRUNCATE') AS destroy",
          [`promotions.${t}`, Object.keys(columns[t])[0]],
        )
      ).rows[0];
      const parent = ['promotions', 'recommendation_rules'].includes(t);
      assert.deepEqual(p, {
        general_update: false,
        id_update: parent,
        any_update: parent,
        destroy: false,
      });
    }
    assert.equal(
      (
        await c.query(
          "SELECT has_schema_privilege(current_user,'promotions','CREATE') AS allowed",
        )
      ).rows[0].allowed,
      false,
    );
  });
  const preview = await seed.connect();
  try {
    await preview.query(renderRollback(batch));
  } finally {
    await preview.query('ROLLBACK');
    preview.release();
  }
  assert.deepEqual(await snapshot(), empty);
  checks.push(
    'Candidate grants UPDATE(id) only on two parents, no table UPDATE; original six-master preview succeeds as seed and fully rolls back',
  );

  const load = async () =>
    tx(seed, 'po_promotions_seed', async (c) => {
      await c.query(rendered.inserts);
      await c.query(rendered.assertions);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE; COMMIT');
    });
  await load();
  const baseline = await snapshot();
  await load();
  assert.deepEqual(await snapshot(), baseline);
  assert.deepEqual(
    Object.keys(columns).map((t) => baseline[t].length),
    [2, 2, 2, 1, 2, 2],
  );
  checks.push(
    'Restricted seed commits only synthetic masters inside disposable database; identical retry in a new transaction preserves all values/timestamps',
  );

  for (const t of ['promotions', 'recommendation_rules']) {
    for (const sql of [
      `UPDATE promotions.${t} SET id=id`,
      `UPDATE promotions.${t} SET id=id WHERE false`,
      `WITH changed AS (UPDATE promotions.${t} SET id=id RETURNING id) SELECT * FROM changed`,
      `MERGE INTO promotions.${t} t USING (SELECT id FROM promotions.${t}) s ON t.id=s.id WHEN MATCHED THEN UPDATE SET id=t.id`,
    ]) {
      await rejected(
        seed,
        'po_promotions_seed',
        sql,
        '42501',
        'SEED_APPEND_ONLY',
      );
      await rejected(inherited, null, sql, '42501', 'SEED_APPEND_ONLY');
    }
  }
  for (const sql of [
    'UPDATE promotions.promotions SET name=name',
    'DELETE FROM promotions.promotions',
    'TRUNCATE promotions.promotions',
    'ALTER TABLE promotions.promotions DISABLE TRIGGER ALL',
    'SET session_replication_role=replica',
    'SET ROLE po_promotions_owner',
    'CREATE TABLE promotions.forbidden(id integer)',
    'SELECT * FROM promotions.outbox',
  ])
    await rejected(seed, 'po_promotions_seed', sql);
  const firstInsert = rendered.inserts
    .split('\n')[0]
    .replace(
      'ON CONFLICT DO NOTHING',
      'ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id',
    );
  await rejected(
    seed,
    'po_promotions_seed',
    firstInsert,
    '42501',
    'SEED_APPEND_ONLY',
  );
  assert.deepEqual(await snapshot(), baseline);
  checks.push(
    'Direct, zero-row, CTE, MERGE and UPSERT UPDATE rejected; inherited seed identity also rejected; DELETE/TRUNCATE/DDL/owner/replication bypass/technical access denied',
  );

  const holder = await seed.connect();
  try {
    await holder.query('BEGIN; SET LOCAL ROLE po_promotions_seed');
    await holder.query(
      'INSERT INTO promotions.promotion_scopes(id,promotion_id,sku) VALUES ($1,$2,$3)',
      [randomUUID(), batch.rows.promotions[0].id, 'TEST_ONLY_LOCK_SCOPE'],
    );
    await tx(runtime, 'po_promotions_runtime', async (c) => {
      await c.query('UPDATE promotions.promotions SET name=name WHERE id=$1', [
        batch.rows.promotions[1].id,
      ]);
    });
    await rejected(
      runtime,
      'po_promotions_runtime',
      `UPDATE promotions.promotions SET name=name WHERE id='${batch.rows.promotions[0].id}'`,
      '55P03',
    );
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  assert.deepEqual(await snapshot(), baseline);
  checks.push(
    'Original child trigger keeps parent row lock: authenticated runtime UPDATE on same parent times out (55P03), independent parent works; rollback preserves fixture',
  );

  await assert.rejects(
    () =>
      tx(seed, 'po_promotions_seed', (c) =>
        c.query(
          "INSERT INTO promotions.promotion_scopes(promotion_id,sku) VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff','TEST_ONLY_MISSING')",
        ),
      ),
    (e) => e.code === '23503',
  );
  assert.deepEqual(await snapshot(), baseline);
  assert.deepEqual(await definitions(), originalDefinitions);
  const guard = (
    await admin.query(
      "SELECT prosecdef,proconfig FROM pg_proc WHERE oid='promotions.test_seed_append_only_guard()'::regprocedure",
    )
  ).rows[0];
  assert.equal(guard.prosecdef, false);
  assert.deepEqual(guard.proconfig, ['search_path=pg_catalog']);
  checks.push(
    'Official function definitions and foreign keys unchanged; new statement guard is SECURITY INVOKER with fixed pg_catalog search_path',
  );

  await tx(admin, 'po_promotions_owner', async (c) => {
    await c.query(`REVOKE UPDATE(id) ON promotions.promotions,promotions.recommendation_rules FROM po_promotions_seed;
    DROP TRIGGER test_seed_append_only_guard ON promotions.promotions;
    DROP TRIGGER test_seed_append_only_guard ON promotions.recommendation_rules;
    DROP FUNCTION promotions.test_seed_append_only_guard(); COMMIT;`);
  });
  await rejected(
    seed,
    'po_promotions_seed',
    'SELECT id FROM promotions.promotions FOR UPDATE',
  );
  assert.deepEqual(await snapshot(), baseline);
  assert.deepEqual(await definitions(), originalDefinitions);
  checks.push(
    'Candidate ACL/triggers removed locally; original seed lock rejection restored without modifying master data or historical functions',
  );
  report = {
    result: 'PASS',
    scope: 'DISPOSABLE_LOCAL_PROPOSAL_ONLY',
    captured_at: new Date().toISOString(),
    tested_base_sha: spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).stdout.trim(),
    postgres_version: (await admin.query('SHOW server_version')).rows[0]
      .server_version,
    normative_commit: 'c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b',
    migrations: migrations.map(({ sql, ...m }) => m),
    source_sha256: Object.fromEntries(
      [
        './seed-locking-proposal.mjs',
        './support/seed-locking-proposal.sql',
        '../prepare-batch.mjs',
        './support/bindings.mjs',
      ].map((p) => [p, hash(readFileSync(new URL(p, import.meta.url)))]),
    ),
    checks,
    authenticated_login: 'test_seed_login',
    effective_role: 'po_promotions_seed',
    inherited_identity_tested: true,
    seed_table_update_granted: false,
    candidate_column_grants: [
      'promotions.promotions.id',
      'promotions.recommendation_rules.id',
    ],
    candidate_security_definer: false,
    existing_function_definitions_unchanged: true,
    runtime_sql_changed: false,
    generator_sql_changed: false,
    synthetic_rows_in_disposable_database: 11,
    shared_connections: 0,
    shared_writes: false,
    shared_permissions_changed: false,
    approval: 'PENDING_LOPEZ_BD_MARCO_REVIEW',
    production_seed_gate: 'SEED_TRIGGER_LOCK_PRIVILEGE_UNRESOLVED',
  };
} finally {
  await Promise.all([
    seed?.end(),
    inherited?.end(),
    runtime?.end(),
    admin?.end(),
  ]);
  if (container) docker(['rm', '--force', container]);
}
report.disposable_container_removed = true;
writeFileSync(
  new URL('./evidence/seed-locking-proposal-2026-11-01.json', import.meta.url),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
