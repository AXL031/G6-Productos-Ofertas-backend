import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateDraft } from './validate-draft.mjs';

const original = JSON.parse(
  readFileSync(new URL('./inka-athletics-draft.json', import.meta.url), 'utf8'),
);
test('validates only the inactive preparation and exposes unresolved references', () => {
  const report = validateDraft();
  assert.equal(report.insertable_batch, 'NO');
  assert.equal(report.shared_writes, false);
  assert.ok(report.pending_references.length > 0);
});
test('rejects a percentage above 100 without rounding it down', () => {
  const draft = structuredClone(original);
  draft.proposed_rows.promotions[0].discount_value = '100.001';
  assert.throws(() => validateDraft(draft), /INVALID_DISCOUNT/);
});
test('rejects activation, duplicated coupons and invented reference bindings', () => {
  const active = structuredClone(original);
  active.proposed_rows.coupons[0].state = 'ACTIVO';
  assert.throws(() => validateDraft(active), /INVALID_COUPON_PARENT_OR_STATE/);
  const duplicate = structuredClone(original);
  duplicate.proposed_rows.coupons.push({
    ...duplicate.proposed_rows.coupons[0],
  });
  assert.throws(() => validateDraft(duplicate), /DUPLICATE_OR_INVALID_ID/);
  const references = structuredClone(original);
  references.proposed_rows.promotion_scopes.push({ sku: 'INVENTED' });
  assert.throws(
    () => validateDraft(references),
    /REFERENCE_BINDING_REVIEW_REQUIRED/,
  );
});
