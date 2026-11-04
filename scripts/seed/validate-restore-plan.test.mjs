import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRestorePlan } from './validate-restore-plan.mjs';

const original = JSON.parse(
  readFileSync(new URL('./restore-plan.json', import.meta.url), 'utf8'),
);

test('reports preparation separately from restoration and verifies evidence hashes', () => {
  const report = validateRestorePlan(structuredClone(original));
  assert.equal(report.result, 'PASS');
  assert.equal(report.verified_hashes, 3);
  assert.equal(report.sql_executed, false);
  assert.equal(report.data_persisted, false);
  assert.equal(report.commercial_restore, 'NOT_EXECUTED');
});

test('rejects changed targets and attempts to permit execution', () => {
  for (const change of [
    (plan) => {
      plan.target.project_ref = 'another-project';
    },
    (plan) => {
      plan.target.verify_only = false;
    },
    (plan) => {
      plan.sql_execution = true;
    },
    (plan) => {
      plan.persistent_execution = true;
    },
  ]) {
    const plan = structuredClone(original);
    change(plan);
    assert.throws(
      () => validateRestorePlan(plan),
      /TARGET_MISMATCH|EXECUTION_NOT_ALLOWED/,
    );
  }
});

test('does not treat an unapproved batch or altered ownership as eligible', () => {
  const batch = structuredClone(original);
  batch.restore_entries.push({ file: original.excluded[0].file });
  assert.throws(
    () => validateRestorePlan(batch),
    /APPROVED_FIXTURE_REVIEW_REQUIRED/,
  );
  const owner = structuredClone(original);
  owner.inventory[0].owner = 'Another owner';
  assert.throws(() => validateRestorePlan(owner), /OWNER_OR_APPROVAL_MISMATCH/);
});

test('rejects missing exclusions and paths outside the seed directory', () => {
  const exclusions = structuredClone(original);
  exclusions.excluded = [];
  assert.throws(() => validateRestorePlan(exclusions), /MUST_REMAIN_EXCLUDED/);
  const outside = structuredClone(original);
  outside.inventory.find((entry) => entry.schema === 'promotions').draft =
    'package.json';
  assert.throws(
    () => validateRestorePlan(outside),
    /SOURCE_OUTSIDE_SEED_DIRECTORY/,
  );
});
