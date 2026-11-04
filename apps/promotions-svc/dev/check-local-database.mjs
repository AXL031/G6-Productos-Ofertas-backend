import assert from 'node:assert/strict';
import { TLSSocket } from 'node:tls';
import { nativeCouponResources } from '../../../dist/apps/promotions-svc/coupons/coupon-providers.js';
import {
  PromotionsConfigService,
  readPromotionsEnvironment,
  validatePromotionsConfiguration,
} from '../../../dist/apps/promotions-svc/infrastructure/config/promotions-config.js';

let resources;
let client;
try {
  const settings = validatePromotionsConfiguration(readPromotionsEnvironment());
  resources = nativeCouponResources(new PromotionsConfigService(settings));
  client = await resources.pool.connect();
  const socket = client.connection?.stream;
  assert.ok(
    socket instanceof TLSSocket && socket.encrypted && socket.authorized,
  );
  await client.query('BEGIN READ ONLY');
  const identity = (
    await client.query(
      `SELECT current_user=$1 AS expected_login,
    current_database()=$2 AS expected_database,
    (SELECT NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)
      FROM pg_roles WHERE rolname=current_user) AS unprivileged_login,
    has_schema_privilege(current_user,'promotions','USAGE') AS own_schema_usage,
    (SELECT bool_and(has_table_privilege(current_user, 'promotions.' || name, 'SELECT'))
      FROM unnest(ARRAY['promotions','promotion_scopes','combination_policy','coupons','recommendation_rules','recommendation_items']) AS name)
      AS own_master_select`,
      [settings.database.user.split('.')[0], settings.database.database],
    )
  ).rows[0];
  assert.ok(Object.values(identity).every((value) => value === true));
  const counts = {};
  for (const table of [
    'promotions',
    'promotion_scopes',
    'combination_policy',
    'coupons',
    'recommendation_rules',
    'recommendation_items',
  ]) {
    // Identifiers are a fixed internal allowlist, never input or external schema references.
    counts[table] = (
      await client.query(
        `SELECT count(*)::text AS rows FROM promotions.${table}`,
      )
    ).rows[0].rows;
  }
  await client.query('ROLLBACK');
  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        mode: 'AUTHENTICATED_READ_ONLY',
        scope: 'OWN_PROMOTIONS_SCHEMA_ONLY',
        tls_authorized: true,
        identity,
        counts,
        data_persisted: false,
        grants_changed: false,
        credentials_printed: false,
        captured_on: '2026-10-16',
        timezone: 'America/Lima',
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      result: 'FAIL',
      code: 'LOCAL_DATABASE_CHECK_FAILED',
      database_code:
        typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)
          ? error.code
          : null,
      credentials_printed: false,
    }),
  );
  process.exitCode = 1;
} finally {
  if (client) {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
  await resources?.onModuleDestroy();
}
