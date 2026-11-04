import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const draftUrl = new URL('./inka-athletics-draft.json', import.meta.url);
const tables = [
  'promotions',
  'promotion_scopes',
  'combination_policy',
  'coupons',
  'recommendation_rules',
  'recommendation_items',
];
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
function check(value, code) {
  assert.ok(value, code);
}
function decimal(value) {
  check(
    typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value),
    'INVALID_EXACT_DECIMAL',
  );
  const [whole, fraction = ''] = value.split('.');
  return {
    amount: BigInt(whole + fraction),
    scale: 10n ** BigInt(fraction.length),
  };
}
export function validateDraft(
  draft = JSON.parse(readFileSync(draftUrl, 'utf8')),
) {
  check(
    draft.issue === 15 &&
      draft.classification === 'demo' &&
      draft.synthetic === true &&
      draft.executable === false &&
      draft.status === 'DRAFT_REFERENCE_BINDING_REQUIRED',
    'PREPARATION_ONLY_REQUIRED',
  );
  check(
    draft.schema === 'promotions' && draft.project === 'slzglmtiyrzygpkiuthf',
    'INVALID_DESTINATION',
  );
  check(
    draft.approvals.rollback_scope === null &&
      draft.approvals.persistent_batch_and_target === null,
    'APPROVAL_CHANGED_REVIEW_REQUIRED',
  );
  check(
    Object.keys(draft.proposed_rows).length === tables.length &&
      tables.every((table) => Array.isArray(draft.proposed_rows[table])),
    'INVALID_MASTER_TABLES',
  );
  const ids = new Set();
  const promotions = new Map();
  const codes = new Set();
  for (const promotion of draft.proposed_rows.promotions) {
    check(
      uuid.test(promotion.id) && !ids.has(promotion.id),
      'DUPLICATE_OR_INVALID_ID',
    );
    ids.add(promotion.id);
    check(
      promotion.state === 'INACTIVO' && promotion.first_activated_at === null,
      'DEMO_MUST_REMAIN_INACTIVE',
    );
    check(
      ['CUPON', 'AUTOMATICA'].includes(promotion.modality) &&
        ['PORCENTAJE', 'MONTO_FIJO'].includes(promotion.discount_type),
      'INVALID_PROMOTION_TYPE',
    );
    const discount = decimal(promotion.discount_value);
    check(
      discount.amount > 0n &&
        (promotion.discount_type !== 'PORCENTAJE' ||
          discount.amount <= 100n * discount.scale),
      'INVALID_DISCOUNT',
    );
    check(
      Number.isInteger(promotion.priority) &&
        promotion.priority > 0 &&
        Number.isFinite(Date.parse(promotion.valid_from)) &&
        Date.parse(promotion.valid_from) < Date.parse(promotion.valid_until),
      'INVALID_PERIOD_OR_PRIORITY',
    );
    check(
      promotion.enabled_channels.length > 0 &&
        new Set(promotion.enabled_channels).size ===
          promotion.enabled_channels.length &&
        promotion.enabled_channels.every((channel) =>
          ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'].includes(channel),
        ),
      'INVALID_CHANNELS',
    );
    promotions.set(promotion.id, promotion);
  }
  for (const policy of draft.proposed_rows.combination_policy) {
    check(
      promotions.has(policy.promotion_id) &&
        ['pricing_offer', 'automatic_promotion', 'coupon'].every(
          (key) => typeof policy[key] === 'boolean',
        ),
      'INVALID_COMBINATION_POLICY',
    );
  }
  for (const id of promotions.keys())
    check(
      draft.proposed_rows.combination_policy.filter(
        (policy) => policy.promotion_id === id,
      ).length === 1,
      'EXACTLY_ONE_POLICY_REQUIRED',
    );
  for (const coupon of draft.proposed_rows.coupons) {
    check(
      uuid.test(coupon.id) && !ids.has(coupon.id),
      'DUPLICATE_OR_INVALID_ID',
    );
    ids.add(coupon.id);
    check(
      coupon.state === 'INACTIVO' &&
        promotions.get(coupon.promotion_id)?.modality === 'CUPON',
      'INVALID_COUPON_PARENT_OR_STATE',
    );
    check(
      typeof coupon.code === 'string' &&
        /^[A-Z0-9_-]+$/.test(coupon.code) &&
        !codes.has(coupon.code),
      'INVALID_OR_DUPLICATE_CODE',
    );
    codes.add(coupon.code);
    for (const key of ['max_global_uses', 'max_customer_uses'])
      check(
        coupon[key] === null ||
          (Number.isInteger(coupon[key]) && coupon[key] > 0),
        'INVALID_LIMIT',
      );
    if (coupon.minimum_amount !== null)
      check(decimal(coupon.minimum_amount).amount > 0n, 'INVALID_MINIMUM');
    check(
      ['RESTAURAR_EN_CANCELACION', 'NO_RESTAURAR'].includes(
        coupon.cancellation_policy,
      ),
      'INVALID_CANCELLATION_POLICY',
    );
  }
  check(
    draft.proposed_rows.promotion_scopes.length === 0 &&
      draft.proposed_rows.recommendation_rules.length === 0 &&
      draft.proposed_rows.recommendation_items.length === 0,
    'REFERENCE_BINDING_REVIEW_REQUIRED',
  );
  check(
    draft.reference_requirements.length > 0 &&
      draft.reference_requirements.every(
        (dependency) =>
          dependency.owner &&
          dependency.operation &&
          dependency.condition &&
          dependency.status === 'PENDING',
      ),
    'DEPENDENCIES_MUST_BE_EXPLICIT',
  );
  check(
    draft.proposed_recommendations.every(
      (rule) =>
        rule.state === 'INACTIVO' &&
        rule.binding_status === 'PENDING_CATALOG_AND_PRICING',
    ),
    'RECOMMENDATION_BINDING_REQUIRED',
  );
  check(promotions.size > 0 && codes.size > 0, 'EMPTY_DRAFT');
  return {
    result: 'PASS',
    scope: 'DRAFT_INTERNAL_VALIDATION_ONLY',
    validation: {
      structural: 'PASS',
      provenance: 'NOT_CHECKED_BY_DRAFT_VALIDATOR',
      commercial_approval: 'PENDING',
    },
    draft_json_sha256: createHash('sha256')
      .update(JSON.stringify(draft))
      .digest('hex'),
    promotions: promotions.size,
    coupons: codes.size,
    pending_references: draft.reference_requirements,
    executable: false,
    shared_writes: false,
    insertable_batch: 'NO',
    commercial_consistency: 'PENDING_PUBLISHED_CATALOG_AND_PRICING',
  };
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    check(process.argv.length === 2, 'NO_EXECUTION_ARGUMENTS_SUPPORTED');
    console.log(JSON.stringify(validateDraft(), null, 2));
  } catch (error) {
    console.error(
      error instanceof assert.AssertionError && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : 'DRAFT_VALIDATION_FAILED',
    );
    process.exitCode = 1;
  }
}
