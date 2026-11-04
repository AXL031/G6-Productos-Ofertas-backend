import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reconcile } from './reconcile.mjs';
import { prepareBatch } from './prepare-batch.mjs';

const capture = () =>
  JSON.parse(
    readFileSync(
      new URL('./supabase-readonly-2026-10-24.json', import.meta.url),
      'utf8',
    ),
  );

test('observed capture reconciles real candidates without granting approval or changing source data', () => {
  const snapshot = capture();
  const before = structuredClone(snapshot);
  const { bindings, report } = reconcile(snapshot);
  assert.deepEqual(snapshot, before);
  assert.deepEqual(reconcile(snapshot), { bindings, report });
  assert.equal(report.executable, false);
  assert.equal(report.observed.products, 20);
  assert.equal(report.observed.variants, 51);
  assert.equal(report.observed.active_products, 0);
  assert.equal(report.observed.parent_prices, 20);
  assert.equal(report.observed.open_validities, 20);
  assert.ok(
    bindings.catalog.products.every((p) => !p.active && p.state === 'BORRADOR'),
  );
  assert.ok(
    bindings.catalog.skus.every((s) => !s.active && s.channels.length === 0),
  );
  assert.deepEqual(bindings.campaign_scopes[0].skus, [
    'ADI-RF3-GRI-38',
    'NIK-REV7-NEG-41',
    'NIK-REV7-NEG-42',
  ]);
  assert.deepEqual(bindings.campaign_scopes[1].skus, ['ADI-ENT22-AZU-M']);
  assert.equal(bindings.pricing.prices.length, 6);
  assert.ok(bindings.pricing.prices.every((p) => p.sku === null));
  for (const ref of report.campaigns.flatMap((c) => c.references)) {
    assert.equal(ref.price_status, 'COVERED_GLOBAL_REFERENCE_ONLY');
    assert.equal(ref.price_origin, 'PRODUCTO');
  }
  assert.equal(report.schedule.dates_changed, false);
  assert.equal(report.schedule.purpose, 'FUTURE_CAMPAIGN_PREPARATION');
  assert.throws(() => prepareBatch(bindings), /COMMERCIAL_REVIEW_REQUIRED/);
  bindings.review = { reviewer: 'test-only', evidence: 'test-only' };
  assert.throws(() => prepareBatch(bindings), /PUBLISHED_ACTIVE_SKU_REQUIRED/);
});

test('report lists independent blockers, absent inventory, absent candidate and seed locking evidence', () => {
  const { report, bindings } = reconcile(capture());
  for (const code of [
    'PUBLISHED_ACTIVE_SKU_REQUIRED',
    'CHANNEL_EVIDENCE_REQUIRED',
    'RECOMMENDATION_AVAILABILITY_PENDING',
    'RECOMMENDATION_CANDIDATE_REQUIRED',
    'SEED_TRIGGER_LOCK_PRIVILEGE_UNRESOLVED',
    'COMMERCIAL_REVIEW_REQUIRED',
  ])
    assert.ok(
      report.blockers.some(
        (b) => b.code === code && b.owner && b.operation && b.condition,
      ),
    );
  assert.ok(
    report.recommendations[0].candidates.every((c) =>
      c.inventory_records.every((i) => i.registered_locations === 0),
    ),
  );
  assert.deepEqual(bindings.recommendations[1].candidate_product_ids, []);
  assert.ok(
    report.locking_functions.every(
      (f) => f.contains_for_update && !f.security_definer,
    ),
  );
  assert.ok(
    report.seed_privileges.every((p) => p.insert && !p.update_any_column),
  );
});

test('reconciliation distinguishes ACTIVA variants from ACTIVO simple products without granting approval', () => {
  const snapshot = capture();
  for (const p of snapshot.products) p.state = 'ACTIVO';
  for (const s of snapshot.skus) s.state = 'ACTIVA';
  const before = structuredClone(snapshot);
  const { bindings, report } = reconcile(snapshot);
  assert.deepEqual(snapshot, before);
  assert.ok(bindings.catalog.skus.every((s) => s.active));
  assert.ok(bindings.catalog.skus.some((s) => s.state === 'ACTIVA'));
  assert.ok(bindings.catalog.skus.some((s) => s.state === 'ACTIVO'));
  assert.ok(
    !report.blockers.some((b) => b.code === 'PUBLISHED_ACTIVE_SKU_REQUIRED'),
  );
  assert.equal(report.executable, false);
  assert.equal(bindings.review.reviewer, null);
  assert.ok(bindings.catalog.skus.every((s) => s.channels.length === 0));
  assert.ok(
    report.blockers.some((b) => b.code === 'CHANNEL_EVIDENCE_REQUIRED'),
  );
  assert.ok(
    report.blockers.some(
      (b) => b.code === 'SEED_TRIGGER_LOCK_PRIVILEGE_UNRESOLVED',
    ),
  );
  assert.throws(() => prepareBatch(bindings), /COMMERCIAL_REVIEW_REQUIRED/);
});

test('reconciliation keeps BORRADOR, INACTIVA and wrong-enum variants unpublished', () => {
  for (const state of ['BORRADOR', 'INACTIVA', 'ACTIVO']) {
    const snapshot = capture();
    for (const p of snapshot.products) p.state = 'ACTIVO';
    for (const s of snapshot.skus) s.state = 'ACTIVA';
    const variant = snapshot.skus.find((s) => s.sku === 'ADI-RF3-GRI-38');
    variant.state = state;
    const { bindings, report } = reconcile(snapshot);
    assert.equal(
      bindings.catalog.skus.find((s) => s.sku === variant.sku).active,
      false,
      state,
    );
    assert.ok(
      report.blockers.some((b) => b.code === 'PUBLISHED_ACTIVE_SKU_REQUIRED'),
      state,
    );
  }
});

test('missing/ambiguous parent or future open validity is reported without fabricating fallback', () => {
  for (const change of [
    (s) => {
      s.prices = s.prices.filter(
        (p) => p.product_id !== 'fedeecfb-c7f5-56cf-c31b-9cdf10b47058',
      );
    },
    (s) => {
      s.prices.push({ ...s.prices.find((p) => p.amount === '279.90') });
    },
    (s) => {
      s.prices.find((p) => p.amount === '279.90').valid_from =
        '2026-11-05T05:00:00Z';
    },
  ]) {
    const s = capture();
    change(s);
    assert.ok(
      reconcile(s).report.blockers.some(
        (b) => b.code === 'PRICE_COVERAGE_OR_AMBIGUITY',
      ),
    );
  }
  const missing = capture();
  missing.products = missing.products.filter(
    (p) => p.name !== 'adidas Entrada 22',
  );
  const result = reconcile(missing);
  assert.ok(
    result.report.blockers.some(
      (b) => b.code === 'CATALOG_CANDIDATE_NOT_FOUND',
    ),
  );
  assert.deepEqual(result.bindings.campaign_scopes[1].skus, []);
});

test('snapshot/hash checks are structural, fail closed and never expose an execution mode', () => {
  const s = capture();
  s.transaction_read_only = 'off';
  assert.throws(() => reconcile(s), /READ_ONLY_CAPTURE_REQUIRED/);
  const script = fileURLToPath(new URL('./reconcile.mjs', import.meta.url));
  const snapshot = fileURLToPath(
    new URL('./supabase-readonly-2026-10-24.json', import.meta.url),
  );
  for (const args of [
    [snapshot, '--apply'],
    [snapshot, '--bindings', '--commit'],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
  const output = spawnSync(process.execPath, [script, snapshot], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(output.status, 0);
  assert.deepEqual(JSON.parse(output.stdout), reconcile(capture()).report);
  const bindings = spawnSync(
    process.execPath,
    [script, snapshot, '--bindings'],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(bindings.status, 0);
  assert.deepEqual(JSON.parse(bindings.stdout), reconcile(capture()).bindings);
});
