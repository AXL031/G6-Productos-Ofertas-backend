import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateDraft } from './validate-draft.mjs';

// Local review format, not an HTTP DTO, an owner contract or permission to load.
const draftUrl = new URL('./inka-athletics-draft.json', import.meta.url);
const hash = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const check = (value, code) => assert.ok(value, code);
const text = (value) =>
  typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
const unique = (values) => new Set(values).size === values.length;
const activeProduct = (p) =>
  p?.active === true && (p.state === undefined || p.state === 'ACTIVO');
const time = (value) => {
  check(
    typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    'INVALID_BINDING_TIMESTAMP',
  );
  const parsed = new Date(value);
  check(
    parsed.toISOString().slice(0, 19) === value.slice(0, 19),
    'INVALID_BINDING_TIMESTAMP',
  );
  return parsed.getTime();
};
const decimal = (value) => {
  check(
    typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value),
    'INVALID_EXACT_AMOUNT',
  );
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole + fraction);
  check(amount > 0n, 'INVALID_EXACT_AMOUNT');
  return { amount, scale: 10n ** BigInt(fraction.length) };
};
function id(key) {
  const bytes = createHash('sha256').update(`DATA-005:${key}`).digest();
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const columns = {
  promotions: {
    id: 'uuid',
    name: 'text',
    discount_type: 'text',
    discount_value: 'numeric',
    modality: 'text',
    state: 'text',
    valid_from: 'timestamptz',
    valid_until: 'timestamptz',
    priority: 'integer',
    enabled_channels: 'text[]',
    first_activated_at: 'timestamptz',
  },
  promotion_scopes: {
    id: 'uuid',
    promotion_id: 'uuid',
    product_id: 'text',
    sku: 'text',
  },
  combination_policy: {
    promotion_id: 'uuid',
    pricing_offer: 'boolean',
    automatic_promotion: 'boolean',
    coupon: 'boolean',
  },
  coupons: {
    id: 'uuid',
    promotion_id: 'uuid',
    code: 'text',
    state: 'text',
    minimum_amount: 'numeric',
    max_global_uses: 'integer',
    max_customer_uses: 'integer',
    cancellation_policy: 'text',
  },
  recommendation_rules: {
    id: 'uuid',
    name: 'text',
    recommendation_type: 'text',
    origin_type: 'text',
    origin_id: 'text',
    priority: 'integer',
    state: 'text',
    valid_from: 'timestamptz',
    valid_until: 'timestamptz',
  },
  recommendation_items: {
    id: 'uuid',
    rule_id: 'uuid',
    product_id: 'text',
    item_order: 'integer',
    superiority_criterion: 'text',
    commercial_justification: 'text',
  },
};

function evidence(source) {
  check(
    text(source?.reference) && /^[a-f0-9]{64}$/.test(source.sha256),
    'SOURCE_EVIDENCE_REQUIRED',
  );
}

const endTime = (value) => (value === null ? Infinity : time(value));

// Conservative whole-window reconciliation, not Pricing's runtime resolver.
// One target/currency per row; a partial override must never be hidden by fallback.
export function resolvePrice(prices, sku, productId, channel, from, until) {
  from = time(from);
  until = time(until);
  check(from < until, 'INVALID_PRICE_WINDOW');
  // Resolve the target only among prices applicable to the requested channel.
  const applicable = prices.filter(
    (p) => p.channel_id === channel || p.channel_id === null,
  );
  const overlaps = applicable.filter(
    (p) =>
      p.is_cancelled !== true &&
      (p.sku === sku || (p.sku == null && p.product_id === productId)) &&
      time(p.valid_from) < until &&
      endTime(p.valid_until) > from,
  );
  const skuOverrides = overlaps.filter((p) => p.sku === sku);
  const target = skuOverrides.length ? skuOverrides : overlaps;
  const overrides = target.filter((p) => p.channel_id === channel);
  const selected = overrides.length
    ? overrides
    : target.filter((p) => p.channel_id === null);
  check(
    selected.length === 1 &&
      time(selected[0].valid_from) <= from &&
      endTime(selected[0].valid_until) >= until,
    'PRICE_COVERAGE_OR_AMBIGUITY',
  );
  decimal(selected[0].amount);
  return selected[0];
}

export function prepareBatch(
  bindings,
  draft = JSON.parse(readFileSync(draftUrl, 'utf8')),
) {
  validateDraft(draft);
  check(
    bindings?.version === 1 && bindings.issue === 15,
    'REFERENCE_BINDINGS_REQUIRED',
  );
  check(
    ['REVIEW', 'ISOLATED_TEST'].includes(bindings.purpose),
    'REFERENCE_PURPOSE_REQUIRED',
  );
  evidence(bindings.catalog?.source);
  evidence(bindings.pricing?.source);
  check(
    text(bindings.review?.reviewer) && text(bindings.review?.evidence),
    'COMMERCIAL_REVIEW_REQUIRED',
  );
  check(
    Array.isArray(bindings.catalog.products) &&
      Array.isArray(bindings.catalog.skus) &&
      Array.isArray(bindings.pricing.prices),
    'REFERENCE_LISTS_REQUIRED',
  );
  const products = new Map();
  for (const p of bindings.catalog.products) {
    check(
      text(p.product_id) &&
        !products.has(p.product_id) &&
        typeof p.active === 'boolean',
      'INVALID_CATALOG_PRODUCT',
    );
    products.set(p.product_id, p);
  }
  const skus = new Map();
  for (const s of bindings.catalog.skus) {
    check(
      text(s.sku) &&
        !skus.has(s.sku) &&
        products.has(s.product_id) &&
        typeof s.active === 'boolean' &&
        Array.isArray(s.channels) &&
        unique(s.channels) &&
        s.channels.every((c) =>
          ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'].includes(c),
        ),
      'INVALID_CATALOG_SKU',
    );
    skus.set(s.sku, s);
  }
  for (const p of bindings.pricing.prices) {
    check(
      ((skus.has(p.sku) && p.product_id == null) ||
        (p.sku == null && products.has(p.product_id))) &&
        typeof p.currency === 'string' &&
        /^[A-Z]{3}$/.test(p.currency) &&
        (p.is_cancelled === undefined || typeof p.is_cancelled === 'boolean') &&
        (p.channel_id === null ||
          ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'].includes(
            p.channel_id,
          )) &&
        time(p.valid_from) < endTime(p.valid_until),
      'INVALID_PRICE_REFERENCE',
    );
    decimal(p.amount);
    if (p.offer_amount != null) {
      const regular = decimal(p.amount);
      const offer = decimal(p.offer_amount);
      check(
        offer.amount * regular.scale < regular.amount * offer.scale,
        'INVALID_PRICING_OFFER',
      );
    }
  }
  const rows = structuredClone(draft.proposed_rows);
  check(
    Array.isArray(bindings.campaign_scopes) &&
      bindings.campaign_scopes.length === rows.promotions.length &&
      unique(bindings.campaign_scopes.map((s) => s.promotion_id)),
    'EXACT_CAMPAIGN_BINDINGS_REQUIRED',
  );
  for (const p of rows.promotions) {
    const binding = bindings.campaign_scopes.find(
      (s) => s.promotion_id === p.id,
    );
    check(
      Array.isArray(binding?.skus) &&
        binding.skus.length > 0 &&
        unique(binding.skus),
      'CAMPAIGN_SKUS_REQUIRED',
    );
    const discount = decimal(p.discount_value);
    for (const sku of [...binding.skus].sort()) {
      const s = skus.get(sku);
      const product = products.get(s?.product_id);
      const publishedState =
        product?.has_variants === false && product.sku_base === sku
          ? 'ACTIVO'
          : 'ACTIVA';
      check(
        s?.active === true &&
          activeProduct(product) &&
          (s.state === undefined || s.state === publishedState) &&
          s.channels.length > 0,
        'PUBLISHED_ACTIVE_SKU_REQUIRED',
      );
      for (const channel of p.enabled_channels) {
        check(s.channels.includes(channel), 'SKU_CHANNEL_NOT_ELIGIBLE');
        if (bindings.purpose === 'REVIEW') {
          check(
            text(s.channel_evidence?.[channel]),
            'CHANNEL_EVIDENCE_REQUIRED',
          );
        }
        const resolved = resolvePrice(
          bindings.pricing.prices,
          sku,
          s.product_id,
          channel,
          p.valid_from,
          p.valid_until,
        );
        check(resolved.currency === 'PEN', 'CAMPAIGN_CURRENCY_REVIEW_REQUIRED');
        const price = decimal(resolved.offer_amount ?? resolved.amount);
        // Positive exact result; does not round money or change Pricing's values.
        check(
          p.discount_type === 'PORCENTAJE'
            ? discount.amount < 100n * discount.scale
            : discount.amount * price.scale < price.amount * discount.scale,
          'NON_POSITIVE_DEMO_RESULT',
        );
      }
      rows.promotion_scopes.push({
        id: id(`scope:${p.id}:${sku}`),
        promotion_id: p.id,
        product_id: null,
        sku,
      });
    }
  }
  check(
    Array.isArray(bindings.recommendations) &&
      bindings.recommendations.length === draft.proposed_recommendations.length,
    'EXACT_RECOMMENDATION_BINDINGS_REQUIRED',
  );
  for (const [index, design] of draft.proposed_recommendations.entries()) {
    const b = bindings.recommendations[index];
    check(
      activeProduct(products.get(b?.origin_product_id)) &&
        Array.isArray(b.candidate_product_ids) &&
        b.candidate_product_ids.length > 0 &&
        unique(b.candidate_product_ids) &&
        b.candidate_product_ids.every(
          (candidate) =>
            activeProduct(products.get(candidate)) &&
            candidate !== b.origin_product_id,
        ),
      'INVALID_RECOMMENDATION_BINDING',
    );
    check(
      design.recommendation_type === 'CROSS_SELL' &&
        design.origin_type === 'PRODUCTO',
      'UNSUPPORTED_DRAFT_DESIGN',
    );
    const ruleId = id(`rule:${index}`);
    rows.recommendation_rules.push({
      id: ruleId,
      name: design.name,
      recommendation_type: design.recommendation_type,
      origin_type: design.origin_type,
      origin_id: b.origin_product_id,
      priority: index + 1,
      state: 'INACTIVO',
      valid_from: rows.promotions[0].valid_from,
      valid_until: rows.promotions[1].valid_until,
    });
    b.candidate_product_ids.forEach((productId, order) =>
      rows.recommendation_items.push({
        id: id(`item:${ruleId}:${productId}`),
        rule_id: ruleId,
        product_id: productId,
        item_order: order + 1,
        superiority_criterion: null,
        commercial_justification: design.reason,
      }),
    );
  }
  for (const [table, values] of Object.entries(rows)) {
    check(
      columns[table] &&
        values.every(
          (row) =>
            Object.keys(row).length === Object.keys(columns[table]).length &&
            Object.keys(columns[table]).every((key) => Object.hasOwn(row, key)),
        ),
      'UNEXPECTED_MASTER_COLUMNS',
    );
  }
  const content = {
    version: 1,
    issue: 15,
    classification: 'demo',
    synthetic: true,
    schema: draft.schema,
    project: draft.project,
    status: 'PREPARED_REQUIRES_OWNER_AND_TARGET_APPROVAL',
    executable: false,
    normative_source: draft.normative_source,
    draft_sha256: hash(draft),
    bindings_sha256: hash(bindings),
    source_evidence: {
      catalog: bindings.catalog.source,
      pricing: bindings.pricing.source,
      review: bindings.review,
    },
    reference_status:
      bindings.purpose === 'ISOLATED_TEST'
        ? 'SYNTHETIC_TEST_ONLY'
        : 'OWNER_SOURCE_AUTHENTICITY_REQUIRES_REVIEW',
    validation: {
      structural: 'PASS',
      provenance:
        bindings.purpose === 'ISOLATED_TEST'
          ? 'SYNTHETIC_TEST_ONLY'
          : 'NOT_AUTHENTICATED_BY_GENERATOR',
      commercial_approval: 'NOT_GRANTED_BY_GENERATOR',
    },
    approvals: { rollback_scope: null, persistent_batch_and_target: null },
    rows,
  };
  return { ...content, content_sha256: hash(content) };
}

function validateBatch(batch) {
  const { content_sha256, ...content } = batch;
  check(
    hash(content) === content_sha256 &&
      batch.issue === 15 &&
      batch.version === 1 &&
      batch.schema === 'promotions' &&
      batch.project === 'slzglmtiyrzygpkiuthf' &&
      batch.executable === false &&
      batch.status === 'PREPARED_REQUIRES_OWNER_AND_TARGET_APPROVAL' &&
      batch.approvals.rollback_scope === null &&
      batch.approvals.persistent_batch_and_target === null,
    'BATCH_CHANGED_REVIEW_REQUIRED',
  );
  check(
    Object.keys(batch.rows).length === Object.keys(columns).length,
    'UNEXPECTED_MASTER_TABLES',
  );
  for (const [table, definition] of Object.entries(columns)) {
    check(
      Array.isArray(batch.rows[table]) &&
        batch.rows[table].length > 0 &&
        batch.rows[table].every(
          (row) =>
            Object.keys(row).length === Object.keys(definition).length &&
            Object.keys(definition).every((key) => Object.hasOwn(row, key)),
        ),
      'UNEXPECTED_MASTER_COLUMNS',
    );
  }
  check(
    ['promotions', 'coupons', 'recommendation_rules'].every((table) =>
      batch.rows[table].every((row) => row.state === 'INACTIVO'),
    ) && batch.rows.promotions.every((row) => row.first_activated_at === null),
    'DEMO_MUST_REMAIN_INACTIVE',
  );
}

function literal(value, type) {
  if (value === null) return `NULL::${type}`;
  if (type === 'text[]')
    return `ARRAY[${value.map((v) => literal(v, 'text')).join(',')}]::text[]`;
  if (type === 'boolean') {
    check(typeof value === 'boolean', 'INVALID_SQL_BOOLEAN');
    return String(value);
  }
  if (type === 'integer') {
    check(
      Number.isInteger(value) && value > 0 && value <= 2147483647,
      'INVALID_SQL_INTEGER',
    );
    return String(value);
  }
  check(
    (typeof value === 'string' || typeof value === 'number') &&
      !String(value).includes('\0'),
    'INVALID_SQL_VALUE',
  );
  return `E'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''")}'::${type}`;
}

// No connection here. Static identifiers only; all values are escaped and cast.
export function renderRows(batch) {
  validateBatch(batch);
  const inserts = [],
    assertions = [];
  for (const [table, definition] of Object.entries(columns)) {
    const keys = Object.keys(definition);
    for (const row of batch.rows[table]) {
      const values = keys.map((key) => literal(row[key], definition[key]));
      inserts.push(
        `INSERT INTO promotions.${table} (${keys.join(',')}) VALUES (${values.join(',')}) ON CONFLICT DO NOTHING;`,
      );
      // Division by zero aborts even when a uniqueness conflict was on another key.
      assertions.push(
        `SELECT 1 / CASE WHEN count(*) = 1 THEN 1 ELSE 0 END AS exact_${table} FROM promotions.${table} WHERE ${keys.map((key, index) => `${key} IS NOT DISTINCT FROM ${values[index]}`).join(' AND ')};`,
      );
    }
  }
  for (const p of batch.rows.promotions) {
    for (const table of ['promotion_scopes', 'combination_policy', 'coupons']) {
      const expected = batch.rows[table].filter(
        (r) => r.promotion_id === p.id,
      ).length;
      assertions.push(
        `SELECT 1 / CASE WHEN count(*) = ${expected} THEN 1 ELSE 0 END AS complete_${table} FROM promotions.${table} WHERE promotion_id = ${literal(p.id, 'uuid')};`,
      );
    }
  }
  for (const r of batch.rows.recommendation_rules) {
    const expected = batch.rows.recommendation_items.filter(
      (item) => item.rule_id === r.id,
    ).length;
    assertions.push(
      `SELECT 1 / CASE WHEN count(*) = ${expected} THEN 1 ELSE 0 END AS complete_items FROM promotions.recommendation_items WHERE rule_id = ${literal(r.id, 'uuid')};`,
    );
  }
  return { inserts: inserts.join('\n'), assertions: assertions.join('\n') };
}

export function renderSnapshot() {
  return Object.entries(columns)
    .map(
      ([table, definition]) =>
        `SELECT '${table}' AS master_table, count(*) AS row_count, md5(coalesce(string_agg(row_to_json(snapshot)::text, E'\\n' ORDER BY row_to_json(snapshot)::text),'')) AS data_md5 FROM (SELECT ${Object.keys(definition).join(',')} FROM promotions.${table}) snapshot;`,
    )
    .join('\n');
}

export function renderRollback(batch) {
  const { inserts, assertions } = renderRows(batch);
  return [
    '-- REVIEW ONLY. Shared execution needs authorization of this exact SQL/hash and target.',
    `-- project_ref=${batch.project}; schema=promotions; mode=review_rollback_only.`,
    `-- batch_sha256=${batch.content_sha256}; no COMMIT/apply mode.`,
    'BEGIN;',
    "SET LOCAL statement_timeout = '15s';",
    "SET LOCAL lock_timeout = '3s';",
    'SET LOCAL ROLE po_promotions_seed;',
    "DO $guard$ BEGIN IF current_user <> 'po_promotions_seed' THEN RAISE EXCEPTION 'SEED_ROLE_REQUIRED'; END IF;",
    "IF NOT has_any_column_privilege(current_user,'promotions.promotions','UPDATE') OR NOT has_any_column_privilege(current_user,'promotions.recommendation_rules','UPDATE') THEN RAISE EXCEPTION 'SEED_TRIGGER_LOCK_PRIVILEGE_UNRESOLVED'; END IF; END $guard$;",
    renderSnapshot(),
    inserts,
    assertions,
    'SET CONSTRAINTS ALL IMMEDIATE;',
    'SET CONSTRAINTS ALL DEFERRED;',
    inserts,
    assertions,
    'SET CONSTRAINTS ALL IMMEDIATE;',
    renderSnapshot(),
    'ROLLBACK;',
    'BEGIN READ ONLY;',
    'SET LOCAL ROLE po_promotions_seed;',
    renderSnapshot(),
    'ROLLBACK;',
    '',
  ].join('\n');
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const args = process.argv.slice(2);
    check(
      (args.length === 1 ||
        (args.length === 2 && args[1] === '--render-rollback')) &&
        !args[0].startsWith('-'),
      'BINDINGS_FILE_AND_OPTIONAL_RENDER_ONLY',
    );
    const batch = prepareBatch(JSON.parse(readFileSync(args[0], 'utf8')));
    process.stdout.write(
      args[1] ? renderRollback(batch) : `${JSON.stringify(batch, null, 2)}\n`,
    );
  } catch (error) {
    const message =
      error instanceof assert.AssertionError
        ? error.message
        : 'BATCH_PREPARATION_FAILED';
    console.error(
      /^[A-Z_]+$/.test(message) ? message : 'BATCH_PREPARATION_FAILED',
    );
    process.exitCode = 1;
  }
}
