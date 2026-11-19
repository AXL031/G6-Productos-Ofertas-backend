import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { officialMigrations as promotionsMigrations } from '../../apps/promotions-svc/test/support/official-migrations.mjs';

const docsSha = 'df0b09c651fab7f8fcdc693211109573f5e39a12';
const inventoryMigrations = [
  [
    '0001_inventory_initial.sql',
    '3f9db5f62391680a5fae6d16a77a86b67cf0b9d02837bf22c6b73890165bd0b8',
  ],
  [
    '0002_order_id_operaciones_disponibilidad.sql',
    'fb34676d4583f6923d04ad2e86acd55857b4a7a63fe3c7b78a61b5ed1bbe148a',
  ],
];

type Context =
  | 'catalog'
  | 'inventory'
  | 'pricing'
  | 'taxonomy'
  | 'price-audit'
  | 'promotions'
  | 'combos';

async function serviceSql(context: Context, path: string) {
  return readFile(
    new URL(`../../apps/${context}-svc/${path}`, import.meta.url),
    'utf8',
  );
}

async function officialSql(
  context: 'inventory-svc' | 'taxonomy' | 'combos',
  file: string,
  checksum: string,
) {
  const response = await fetch(
    `https://raw.githubusercontent.com/Taller-SW-Web/G6-Productos-Ofertas-docs/${docsSha}/datos/${context}/migrations/${file}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) throw new Error('OFFICIAL_SQL_UNAVAILABLE_' + context);
  const sql = (await response.text()).replaceAll('\r\n', '\n');
  if (createHash('sha256').update(sql).digest('hex') !== checksum)
    throw new Error('OFFICIAL_SQL_HASH_MISMATCH_' + context);
  return sql;
}

export async function prepareInitializationDatabases(source: string) {
  const url = new URL(source);
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    url.username !== 'postgres' ||
    !/^\/g6_init_h5_test_[a-z0-9]+$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error('DISPOSABLE_LOCAL_DATABASE_REQUIRED');

  const control = new Pool({
    connectionString: url.href,
    connectionTimeoutMillis: 2000,
  });
  const inspectPools: Pool[] = [];
  const close = async () => {
    await Promise.all([...inspectPools, control].map((pool) => pool.end()));
  };
  try {
    const existing = await control.query(
      "SELECT 1 FROM pg_database WHERE datname IN ('g6_h5_catalog','g6_h5_inventory','g6_h5_pricing','g6_h5_taxonomy','g6_h5_price_audit','g6_h5_promotions','g6_h5_combos')",
    );
    if (existing.rowCount) throw new Error('EMPTY_POSTGRES_INSTANCE_REQUIRED');

    async function prepare(context: Context) {
      const schema = context.replace('-', '_');
      const name = 'g6_h5_' + schema;
      const owner = 'po_' + schema + '_owner';
      const user = schema + '_app';
      const password = randomUUID();
      await control.query(
        `CREATE ROLE ${owner} NOLOGIN; CREATE ROLE ${user} LOGIN PASSWORD '${password}'`,
      );
      await control.query(`CREATE DATABASE ${name}`);
      const adminUrl = new URL(url);
      adminUrl.pathname = '/' + name;
      const pool = new Pool({
        connectionString: adminUrl.href,
        connectionTimeoutMillis: 2000,
      });
      inspectPools.push(pool);
      const runtimeUrl = new URL(adminUrl);
      runtimeUrl.username = user;
      runtimeUrl.password = password;
      return { pool, runtimeUrl, owner, user, password, name };
    }

    async function ownerSql(pool: Pool, owner: string, scripts: string[]) {
      const client = await pool.connect();
      try {
        await client.query('SET ROLE ' + owner);
        for (const script of scripts) await client.query(script);
      } finally {
        client.release(true);
      }
    }

    const catalog = await prepare('catalog');
    await catalog.pool.query(
      'CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner',
    );
    await ownerSql(
      catalog.pool,
      catalog.owner,
      await Promise.all(
        [
          'test/fixtures/0001_create_catalog.sql',
          'migrations/0002_create_sku_barcodes.sql',
          'migrations/0003_product_publication_history.sql',
          'migrations/0004_historical_preparation_requests.sql',
          'migrations-candidate/h5/0001_outbox_delivery.sql',
        ].map((path) => serviceSql('catalog', path)),
      ),
    );

    const inventory = await prepare('inventory');
    for (const [file, checksum] of inventoryMigrations)
      await inventory.pool.query(
        await officialSql('inventory-svc', file, checksum),
      );
    await inventory.pool.query(
      await serviceSql(
        'inventory',
        'migrations/20261104_0001_lifecycle_offline_reconciliation.sql',
      ),
    );
    await inventory.pool.query(`
      ALTER SCHEMA inventory OWNER TO po_inventory_owner;
      ALTER TABLE inventory.outbox OWNER TO po_inventory_owner;
      GRANT USAGE ON SCHEMA inventory TO inventory_app;
      GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA inventory TO inventory_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA inventory TO inventory_app
    `);
    await ownerSql(inventory.pool, inventory.owner, [
      await serviceSql(
        'inventory',
        'migrations-candidate/h5/0001_outbox_delivery.sql',
      ),
    ]);

    const pricing = await prepare('pricing');
    await pricing.pool.query(`
      CREATE SCHEMA pricing AUTHORIZATION po_pricing_owner;
      CREATE SCHEMA extensions;
      CREATE EXTENSION btree_gist WITH SCHEMA extensions;
      GRANT USAGE ON SCHEMA extensions TO po_pricing_owner
    `);
    await ownerSql(pricing.pool, pricing.owner, [
      await serviceSql('pricing', 'test/fixtures/pricing.sql'),
    ]);
    for (const file of [
      '0002_schedule_effective_events.sql',
      '0003_initialization_operation_index.sql',
    ])
      await pricing.pool.query(
        await serviceSql('pricing', 'migrations/' + file),
      );
    await ownerSql(
      pricing.pool,
      pricing.owner,
      await Promise.all(
        [
          '0001_outbox_delivery.sql',
          '0002_price_changed_promotions.sql',
          '0003_catalog_initialization_results.sql',
        ].map((file) =>
          serviceSql('pricing', 'migrations-candidate/h5/' + file),
        ),
      ),
    );

    const prepareTaxonomy = async () => {
      const taxonomy = await prepare('taxonomy');
      await taxonomy.pool.query(
        'CREATE SCHEMA taxonomy AUTHORIZATION po_taxonomy_owner',
      );
      await ownerSql(
        taxonomy.pool,
        taxonomy.owner,
        await Promise.all([
          officialSql(
            'taxonomy',
            '0001_create_taxonomy.sql',
            '8c71c5b24c70aedacb59801a3403423a933dae83fdc3aaacc8970fe840c21072',
          ),
          serviceSql(
            'taxonomy',
            'migrations/0002_deactivation_source_version.sql',
          ),
          serviceSql(
            'taxonomy',
            'migrations/0003_deactivation_timeout_setting.sql',
          ),
          serviceSql(
            'taxonomy',
            'migrations-candidate/h5/0001_outbox_delivery.sql',
          ),
        ]),
      );
      return taxonomy;
    };
    const preparePriceConsumers = async () => {
      const audit = await prepare('price-audit');
      await audit.pool.query(
        'CREATE ROLE price_audit_archiver NOLOGIN; CREATE SCHEMA price_audit AUTHORIZATION po_price_audit_owner',
      );
      const auditSql = await serviceSql(
        'price-audit',
        'test/fixtures/price-audit.sql',
      );
      if (
        createHash('sha256')
          .update(auditSql.replaceAll('\r\n', '\n'))
          .digest('hex') !==
        '7d890955717025572da03d258168d81e9b7fa38c797f1b697527f0d4cab89afc'
      )
        throw new Error('PRICE_AUDIT_SQL_HASH_MISMATCH');
      await ownerSql(audit.pool, audit.owner, [
        auditSql,
        await serviceSql(
          'price-audit',
          'migrations/0002_typed_price_change.sql',
        ),
      ]);
      const promotions = await prepare('promotions');
      await promotions.pool.query(
        'CREATE ROLE po_promotions_runtime NOLOGIN; GRANT po_promotions_runtime TO promotions_app; CREATE SCHEMA promotions AUTHORIZATION po_promotions_owner',
      );
      await ownerSql(
        promotions.pool,
        promotions.owner,
        await promotionsMigrations(),
      );
      return { audit, promotions };
    };
    const prepareCombos = async () => {
      const combos = await prepare('combos');
      await combos.pool.query(
        'CREATE SCHEMA combos AUTHORIZATION po_combos_owner',
      );
      await ownerSql(combos.pool, combos.owner, [
        await officialSql(
          'combos',
          '0001_create_combos_persistence.sql',
          'deca86e2768c949c4628c7601c186633029d6b29df5ce7d67aeed2db0c66a14c',
        ),
      ]);
      await combos.pool.query(`GRANT USAGE ON SCHEMA combos TO combos_app;
        GRANT SELECT, INSERT, UPDATE ON combos.inbox, combos.component_projection TO combos_app;
        GRANT SELECT ON combos.combo_items TO combos_app`);
      return combos;
    };
    return {
      catalog,
      inventory,
      pricing,
      prepareTaxonomy,
      preparePriceConsumers,
      prepareCombos,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
