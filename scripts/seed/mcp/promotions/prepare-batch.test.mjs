import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  prepareBatch,
  resolvePrice,
  renderRollback,
  renderRows,
  renderSnapshot,
} from './prepare-batch.mjs';
import { isolatedBindings } from './test/support/bindings.mjs';

const draft = () =>
  JSON.parse(
    readFileSync(
      new URL('./inka-athletics-draft.json', import.meta.url),
      'utf8',
    ),
  );
const mutate = (change) => {
  const bindings = isolatedBindings();
  change(bindings);
  return bindings;
};

test('incomplete real bindings fail before SQL; no Catalog or Pricing reference is fabricated', () => {
  const template = JSON.parse(
    readFileSync(new URL('./bindings.template.json', import.meta.url), 'utf8'),
  );
  assert.throws(() => prepareBatch(template), /SOURCE_EVIDENCE_REQUIRED/);
  assert.throws(() => prepareBatch(), /REFERENCE_BINDINGS_REQUIRED/);
  assert.throws(
    () =>
      prepareBatch(
        mutate((b) => {
          b.review.evidence = null;
        }),
      ),
    /COMMERCIAL_REVIEW_REQUIRED/,
  );
  assert.throws(
    () =>
      prepareBatch(
        mutate((b) => {
          b.campaign_scopes[0].skus = [];
        }),
      ),
    /CAMPAIGN_SKUS_REQUIRED/,
  );
});

test('complete isolated references produce deterministic six-table inactive content and evidence hashes', () => {
  const batch = prepareBatch(isolatedBindings());
  assert.deepEqual(batch, prepareBatch(isolatedBindings()));
  assert.equal(batch.executable, false);
  assert.equal(batch.reference_status, 'SYNTHETIC_TEST_ONLY');
  assert.match(batch.content_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    Object.values(batch.rows).map((rows) => rows.length),
    [2, 2, 2, 1, 2, 2],
  );
  assert.deepEqual(batch.approvals, {
    rollback_scope: null,
    persistent_batch_and_target: null,
  });
  const realReview = isolatedBindings();
  realReview.purpose = 'REVIEW';
  for (const sku of realReview.catalog.skus)
    sku.channel_evidence = Object.fromEntries(
      sku.channels.map((c) => [c, 'test-only:channel-review']),
    );
  assert.equal(
    prepareBatch(realReview).reference_status,
    'OWNER_SOURCE_AUTHENTICITY_REQUIRES_REVIEW',
  );
});

test('missing, inactive, duplicate and wrong-channel Catalog references are rejected', () => {
  for (const change of [
    (b) => {
      b.catalog.skus[0].active = false;
    },
    (b) => {
      b.catalog.products[0].active = false;
    },
    (b) => {
      b.campaign_scopes[0].skus = ['MISSING'];
    },
  ])
    assert.throws(
      () => prepareBatch(mutate(change)),
      /PUBLISHED_ACTIVE_SKU_REQUIRED/,
    );
  assert.throws(
    () =>
      prepareBatch(
        mutate((b) => {
          b.catalog.skus[0].channels = ['RETAIL'];
        }),
      ),
    /SKU_CHANNEL_NOT_ELIGIBLE/,
  );
  assert.throws(
    () =>
      prepareBatch(
        mutate((b) => {
          b.catalog.products.push({ ...b.catalog.products[0] });
        }),
      ),
    /INVALID_CATALOG_PRODUCT/,
  );
  assert.throws(
    () =>
      prepareBatch(
        mutate((b) => {
          b.campaign_scopes[0].skus.push(b.campaign_scopes[0].skus[0]);
        }),
      ),
    /CAMPAIGN_SKUS_REQUIRED/,
  );
});

test('prices require exact positive decimals and full unambiguous campaign coverage', () => {
  for (const amount of ['0', '-1', 'NaN', 'Infinity', '1e2']) {
    assert.throws(
      () =>
        prepareBatch(
          mutate((b) => {
            b.pricing.prices[0].amount = amount;
          }),
        ),
      /INVALID_EXACT_AMOUNT/,
    );
  }
  for (const change of [
    (b) => {
      b.pricing.prices.splice(0, 1);
    },
    (b) => {
      b.pricing.prices[0].valid_until = '2026-11-03T05:00:00Z';
    },
    (b) => {
      b.pricing.prices.push({ ...b.pricing.prices[0] });
    },
  ])
    assert.throws(
      () => prepareBatch(mutate(change)),
      /PRICE_COVERAGE_OR_AMBIGUITY/,
    );
  assert.throws(
    () =>
      prepareBatch(
        mutate((b) => {
          b.pricing.prices[0].valid_from = '2026-02-30T05:00:00Z';
        }),
      ),
    /INVALID_BINDING_TIMESTAMP/,
  );
  assert.doesNotThrow(() =>
    prepareBatch(
      mutate((b) => {
        b.pricing.prices[0].amount = '0.0000000000000000000000000000000000001';
      }),
    ),
  );
});

test('channel override is selected and a partial override never silently falls back to global', () => {
  const bindings = isolatedBindings();
  bindings.pricing.prices.push({
    ...bindings.pricing.prices[0],
    channel_id: 'RETAIL',
    amount: '90.00',
  });
  assert.doesNotThrow(() => prepareBatch(bindings));
  bindings.pricing.prices.at(-1).valid_from = '2026-11-04T05:00:00Z';
  assert.throws(() => prepareBatch(bindings), /PRICE_COVERAGE_OR_AMBIGUITY/);
});

const parentPrices = () =>
  mutate((b) => {
    for (const p of b.pricing.prices) {
      p.product_id = b.catalog.skus.find((s) => s.sku === p.sku).product_id;
      p.sku = null;
      p.valid_until = null;
    }
  });

test('an SKU override in another channel does not hide the global parent price', () => {
  const b = parentPrices();
  const parent = b.pricing.prices[0];
  b.pricing.prices.push({
    ...parent,
    product_id: null,
    sku: b.catalog.skus[0].sku,
    channel_id: 'RETAIL',
    amount: '90.00',
  });
  const campaign = draft().proposed_rows.promotions[0];
  for (const channel of [null, 'MARKETPLACE', 'CHATBOT'])
    assert.equal(
      resolvePrice(
        b.pricing.prices,
        b.catalog.skus[0].sku,
        b.catalog.products[0].product_id,
        channel,
        campaign.valid_from,
        campaign.valid_until,
      ),
      parent,
    );
  assert.equal(
    resolvePrice(
      b.pricing.prices,
      b.catalog.skus[0].sku,
      b.catalog.products[0].product_id,
      'RETAIL',
      campaign.valid_from,
      campaign.valid_until,
    ),
    b.pricing.prices.at(-1),
  );
  assert.doesNotThrow(() => prepareBatch(b));
});

test('a variant inherits the open global parent price for every requested channel', () => {
  const b = parentPrices();
  const parent = b.pricing.prices[0];
  const before = structuredClone(b);
  const campaign = draft().proposed_rows.promotions[0];
  for (const channel of [null, ...b.catalog.skus[0].channels])
    assert.equal(
      resolvePrice(
        b.pricing.prices,
        b.catalog.skus[0].sku,
        b.catalog.products[0].product_id,
        channel,
        campaign.valid_from,
        campaign.valid_until,
      ),
      parent,
    );
  assert.deepEqual(prepareBatch(b).rows, prepareBatch(isolatedBindings()).rows);
  assert.deepEqual(b, before);
});

test('a partial SKU override in the requested channel rejects fallback to the full global parent', () => {
  for (const partial of [
    { valid_from: '2026-11-04T05:00:00Z' },
    { valid_until: '2026-11-04T05:00:00Z' },
  ]) {
    const b = parentPrices();
    b.pricing.prices.push({
      ...b.pricing.prices[0],
      product_id: null,
      sku: b.catalog.skus[0].sku,
      channel_id: 'RETAIL',
      amount: '90.00',
      ...partial,
    });
    const campaign = draft().proposed_rows.promotions[0];
    assert.throws(
      () =>
        resolvePrice(
          b.pricing.prices,
          b.catalog.skus[0].sku,
          b.catalog.products[0].product_id,
          'RETAIL',
          campaign.valid_from,
          campaign.valid_until,
        ),
      /PRICE_COVERAGE_OR_AMBIGUITY/,
    );
    assert.throws(() => prepareBatch(b), /PRICE_COVERAGE_OR_AMBIGUITY/);
    assert.equal(
      resolvePrice(
        b.pricing.prices,
        b.catalog.skus[0].sku,
        b.catalog.products[0].product_id,
        'MARKETPLACE',
        campaign.valid_from,
        campaign.valid_until,
      ),
      b.pricing.prices[0],
    );
  }
});

test('parent prices and open validities cover variants without copying or changing prices', () => {
  const b = parentPrices();
  const before = structuredClone(b);
  const batch = prepareBatch(b);
  assert.deepEqual(b, before);
  assert.deepEqual(batch.rows, prepareBatch(isolatedBindings()).rows);
  assert.equal(batch.validation.provenance, 'SYNTHETIC_TEST_ONLY');
});

test('parent references reject wrong targets, dual targets, ambiguity and uncovered open starts', () => {
  for (const change of [
    (b) => {
      b.pricing.prices[0].product_id = 'MISSING';
    },
    (b) => {
      b.pricing.prices[0].sku = b.catalog.skus[0].sku;
    },
  ]) {
    const b = parentPrices();
    change(b);
    assert.throws(() => prepareBatch(b), /INVALID_PRICE_REFERENCE/);
  }
  for (const change of [
    (b) => {
      b.pricing.prices.push({ ...b.pricing.prices[0] });
    },
    (b) => {
      b.pricing.prices[0].valid_from = '2026-11-03T05:00:00Z';
    },
    (b) => {
      b.pricing.prices[0].valid_until = '2026-11-02T05:00:00Z';
    },
    (b) => {
      b.pricing.prices[0].is_cancelled = true;
    },
  ]) {
    const b = parentPrices();
    change(b);
    assert.throws(() => prepareBatch(b), /PRICE_COVERAGE_OR_AMBIGUITY/);
  }
});

test('SKU override precedes parent/channel; partial override cannot hide behind an open parent', () => {
  const b = parentPrices();
  const override = {
    ...b.pricing.prices[0],
    product_id: null,
    sku: b.catalog.skus[0].sku,
    amount: '0.50',
  };
  b.pricing.prices.push(override);
  const fixed = draft();
  fixed.proposed_rows.promotions[0].discount_type = 'MONTO_FIJO';
  fixed.proposed_rows.promotions[0].discount_value = '1';
  assert.throws(() => prepareBatch(b, fixed), /NON_POSITIVE_DEMO_RESULT/);
  override.valid_from = '2026-11-04T05:00:00Z';
  assert.throws(() => prepareBatch(b), /PRICE_COVERAGE_OR_AMBIGUITY/);
});

test('BORRADOR state cannot be overridden by a supplied active flag', () => {
  for (const change of [
    (b) => {
      b.catalog.products[0].state = 'BORRADOR';
    },
    (b) => {
      b.catalog.skus[0].state = 'BORRADOR';
    },
  ])
    assert.throws(
      () => prepareBatch(mutate(change)),
      /PUBLISHED_ACTIVE_SKU_REQUIRED/,
    );
  assert.throws(
    () =>
      prepareBatch(
        mutate((b) => {
          b.catalog.products[2].state = 'BORRADOR';
        }),
      ),
    /INVALID_RECOMMENDATION_BINDING/,
  );
});

test('published Catalog enums accept ACTIVO products and ACTIVA variants without changing master rows or SQL', () => {
  const b = isolatedBindings();
  assert.ok(b.catalog.products.every((p) => p.state === 'ACTIVO'));
  assert.ok(b.catalog.skus.every((s) => s.state === 'ACTIVA'));
  const batch = prepareBatch(b);
  const legacy = structuredClone(b);
  for (const row of [...legacy.catalog.products, ...legacy.catalog.skus])
    delete row.state;
  const previous = prepareBatch(legacy);
  assert.deepEqual(batch.rows, previous.rows);
  assert.deepEqual(renderRows(batch), renderRows(previous));
  assert.equal(batch.executable, false);
  assert.equal(
    batch.validation.commercial_approval,
    'NOT_GRANTED_BY_GENERATOR',
  );
});

test('unpublished or wrong-enum variants are rejected even with active=true', () => {
  for (const state of ['BORRADOR', 'INACTIVA', 'ACTIVO', 'INACTIVO', 'UNKNOWN'])
    assert.throws(
      () =>
        prepareBatch(
          mutate((b) => {
            b.catalog.skus[0].state = state;
          }),
        ),
      /PUBLISHED_ACTIVE_SKU_REQUIRED/,
      state,
    );
  assert.throws(
    () =>
      prepareBatch(
        mutate((b) => {
          b.catalog.skus[0].active = false;
        }),
      ),
    /PUBLISHED_ACTIVE_SKU_REQUIRED/,
  );
});

test('unpublished or wrong-enum products cannot be published by an ACTIVA variant', () => {
  for (const state of ['BORRADOR', 'INACTIVO', 'ACTIVA', 'INACTIVA'])
    assert.throws(
      () =>
        prepareBatch(
          mutate((b) => {
            b.catalog.products[0].state = state;
          }),
        ),
      /PUBLISHED_ACTIVE_SKU_REQUIRED/,
      state,
    );
});

test('a simple sku_base uses its ACTIVO product state, not the variant enum', () => {
  const b = isolatedBindings();
  b.catalog.products[0].has_variants = false;
  b.catalog.products[0].sku_base = b.catalog.skus[0].sku;
  b.catalog.skus[0].state = 'ACTIVO';
  assert.doesNotThrow(() => prepareBatch(b));
  for (const state of ['BORRADOR', 'INACTIVO', 'ACTIVA', 'INACTIVA']) {
    b.catalog.skus[0].state = state;
    assert.throws(
      () => prepareBatch(b),
      /PUBLISHED_ACTIVE_SKU_REQUIRED/,
      state,
    );
  }
});

test('global pricing does not accredit channels and supplied evidence is only structural', () => {
  const b = parentPrices();
  b.purpose = 'REVIEW';
  assert.throws(() => prepareBatch(b), /CHANNEL_EVIDENCE_REQUIRED/);
  for (const sku of b.catalog.skus)
    sku.channel_evidence = Object.fromEntries(
      sku.channels.map((c) => [c, 'test-only:channel-review']),
    );
  assert.equal(
    prepareBatch(b).validation.provenance,
    'NOT_AUTHENTICATED_BY_GENERATOR',
  );
  b.catalog.skus[0].channels = [];
  assert.throws(() => prepareBatch(b), /PUBLISHED_ACTIVE_SKU_REQUIRED/);
});

test('money/currency checks preserve exactness with parent/open prices and Pricing offers', () => {
  const b = parentPrices();
  b.pricing.prices[0].currency = 'USD';
  assert.throws(() => prepareBatch(b), /CAMPAIGN_CURRENCY_REVIEW_REQUIRED/);
  b.pricing.prices[0].currency = 'PEN';
  b.pricing.prices[0].offer_amount = '100.000000000000000000001';
  assert.throws(() => prepareBatch(b), /INVALID_PRICING_OFFER/);
  b.pricing.prices[0].offer_amount = '0.000000000000000000001';
  const fixed = draft();
  fixed.proposed_rows.promotions[0].discount_type = 'MONTO_FIJO';
  fixed.proposed_rows.promotions[0].discount_value = '0.01';
  assert.throws(() => prepareBatch(b, fixed), /NON_POSITIVE_DEMO_RESULT/);
});

test('fixed discount cannot erase a price; percentages retain exact limits', () => {
  const fixed = draft();
  fixed.proposed_rows.promotions[0].discount_type = 'MONTO_FIJO';
  fixed.proposed_rows.promotions[0].discount_value = '100.0000000000000000001';
  assert.throws(
    () => prepareBatch(isolatedBindings(), fixed),
    /NON_POSITIVE_DEMO_RESULT/,
  );
  const percentage = draft();
  percentage.proposed_rows.promotions[0].discount_value = '100.001';
  assert.throws(
    () => prepareBatch(isolatedBindings(), percentage),
    /INVALID_DISCOUNT/,
  );
  percentage.proposed_rows.promotions[0].discount_value = '100';
  assert.throws(
    () => prepareBatch(isolatedBindings(), percentage),
    /NON_POSITIVE_DEMO_RESULT/,
  );
});

test('recommendations reject unknown/inactive products, self-reference, duplicate candidates and missing designs', () => {
  for (const change of [
    (b) => {
      b.recommendations[0].origin_product_id = 'MISSING';
    },
    (b) => {
      b.catalog.products[2].active = false;
    },
    (b) => {
      b.recommendations[0].candidate_product_ids = [
        b.recommendations[0].origin_product_id,
      ];
    },
    (b) => {
      b.recommendations[0].candidate_product_ids.push(
        b.recommendations[0].candidate_product_ids[0],
      );
    },
    (b) => {
      b.recommendations[0].candidate_product_ids = [];
    },
  ])
    assert.throws(
      () => prepareBatch(mutate(change)),
      /INVALID_RECOMMENDATION_BINDING/,
    );
  assert.throws(
    () =>
      prepareBatch(
        mutate((b) => {
          b.recommendations.pop();
        }),
      ),
    /EXACT_RECOMMENDATION_BINDINGS_REQUIRED/,
  );
});

test('renderer detects changed content and emits only append-only masters, exact comparisons and rollback', () => {
  const batch = prepareBatch(isolatedBindings());
  const sql = renderRollback(batch);
  assert.match(sql, /SET LOCAL ROLE po_promotions_seed/);
  assert.match(sql, /SEED_TRIGGER_LOCK_PRIVILEGE_UNRESOLVED/);
  assert.equal((sql.match(/INSERT INTO promotions\./g) || []).length, 22);
  assert.match(sql, /ON CONFLICT DO NOTHING/);
  assert.match(sql, /IS NOT DISTINCT FROM/);
  assert.match(sql, /SET CONSTRAINTS ALL IMMEDIATE/);
  assert.match(sql, /complete_items/);
  assert.ok(sql.endsWith('ROLLBACK;\n'));
  assert.doesNotMatch(
    sql,
    /^(?:UPDATE|DELETE|TRUNCATE|CREATE|ALTER|GRANT|COMMIT)\b/m,
  );
  assert.doesNotMatch(
    sql,
    /promotions\.(?:coupon_uses|inbox|outbox|.*_projection|schema_migrations)/,
  );
  assert.match(renderSnapshot(), /data_md5/);
  batch.rows.promotions[0].state = 'ACTIVO';
  assert.throws(() => renderRows(batch), /BATCH_CHANGED_REVIEW_REQUIRED/);
});

test('CLI rejects activation arguments and the unbound template without producing SQL', () => {
  const script = new URL('./prepare-batch.mjs', import.meta.url);
  for (const args of [
    ['--apply'],
    ['bindings.json', '--commit'],
    ['bindings.json', '--render-rollback', '--apply'],
    [
      new URL('./bindings.template.json', import.meta.url).pathname.replace(
        /^\/(\w:)/,
        '$1',
      ),
    ],
  ]) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(script), ...args],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(
      result.stderr,
      /BINDINGS_FILE_AND_OPTIONAL_RENDER_ONLY|SOURCE_EVIDENCE_REQUIRED/,
    );
  }
});

test('CLI prepares a complete test file and renders rollback without connecting or granting approval', () => {
  const file = join(tmpdir(), `g6-data bindings-${randomUUID()}.json`);
  try {
    writeFileSync(file, JSON.stringify(isolatedBindings()));
    const script = fileURLToPath(
      new URL('./prepare-batch.mjs', import.meta.url),
    );
    const manifest = spawnSync(process.execPath, [script, file], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(manifest.status, 0);
    const batch = JSON.parse(manifest.stdout);
    assert.equal(batch.executable, false);
    assert.equal(batch.reference_status, 'SYNTHETIC_TEST_ONLY');
    const sql = spawnSync(
      process.execPath,
      [script, file, '--render-rollback'],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(sql.status, 0);
    assert.equal(sql.stdout, renderRollback(batch));
    assert.equal(sql.stderr, '');
  } finally {
    unlinkSync(file);
  }
});
