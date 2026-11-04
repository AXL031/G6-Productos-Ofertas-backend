import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const draftPath = 'scripts/seed/mcp/promotions/inka-athletics-draft.json';
const technicalPath = 'scripts/seed/demo/promotions/001_stock_projection.json';

function requireCondition(condition, code) {
  assert.ok(condition, code);
}

function sourcePath(filename) {
  requireCondition(typeof filename === 'string', 'INVALID_SOURCE');
  const absolute = realpathSync(resolve(root, filename));
  const local = relative(realpathSync(resolve(root, 'scripts/seed')), absolute);
  requireCondition(
    local !== '..' &&
      !local.startsWith('../') &&
      !local.startsWith('..\\') &&
      !isAbsolute(local),
    'SOURCE_OUTSIDE_SEED_DIRECTORY',
  );
  return absolute;
}

const readJson = (filename) =>
  JSON.parse(readFileSync(sourcePath(filename), 'utf8'));

// Validates the current preparation only. Never executes the runner, SQL or a connection.
export function validateRestorePlan(
  plan = readJson('scripts/seed/restore-plan.json'),
) {
  requireCondition(
    plan.version === 1 && plan.issue === 112,
    'INVALID_RESTORE_PLAN',
  );
  requireCondition(
    plan.mode === 'dry_run' &&
      plan.sql_execution === false &&
      plan.persistent_execution === false,
    'EXECUTION_NOT_ALLOWED',
  );
  requireCondition(
    plan.runner === 'scripts/seed/run.mjs' &&
      plan.registry === 'scripts/seed/registry.json' &&
      plan.identity_manifest === 'scripts/seed/dataset.json',
    'EXISTING_DATA_MECHANISM_REQUIRED',
  );
  sourcePath(plan.runner);
  const registry = readJson(plan.registry);
  const identities = readJson(plan.identity_manifest);
  requireCondition(
    plan.target?.environment === 'shared' &&
      plan.target.project_ref === registry.project_ref &&
      plan.target.database === registry.database &&
      plan.target.verify_only === true &&
      registry.environments.shared.verify_only === true &&
      registry.environments.shared.production === false,
    'TARGET_MISMATCH_OR_NOT_VERIFY_ONLY',
  );
  requireCondition(
    identities.status === 'PENDING_OWNER_REVIEW',
    'IDENTITY_REVIEW_STATUS_CHANGED',
  );
  requireCondition(
    plan.status === 'PREPARED_NO_APPROVED_COMMERCIAL_FIXTURES' &&
      Array.isArray(plan.restore_entries) &&
      plan.restore_entries.length === 0 &&
      Array.isArray(plan.ledger_proposal?.recorded_executions) &&
      plan.ledger_proposal.recorded_executions.length === 0,
    'APPROVED_FIXTURE_REVIEW_REQUIRED',
  );
  const schemas = [
    'taxonomy',
    'catalog',
    'pricing',
    'inventory',
    'promotions',
    'combos',
  ];
  requireCondition(
    Array.isArray(plan.inventory) &&
      plan.inventory.length === schemas.length &&
      new Set(plan.inventory.map((entry) => entry.schema)).size ===
        schemas.length,
    'INCOMPLETE_DATA_INVENTORY',
  );
  for (const entry of plan.inventory) {
    requireCondition(
      schemas.includes(entry.schema) &&
        registry.schemas[entry.schema]?.owner === entry.owner &&
        Array.isArray(entry.approved_commercial_fixtures) &&
        entry.approved_commercial_fixtures.length === 0,
      'OWNER_OR_APPROVAL_MISMATCH',
    );
    if (entry.draft) sourcePath(entry.draft);
  }
  requireCondition(Array.isArray(plan.excluded), 'EXCLUSIONS_REQUIRED');
  for (const filename of [draftPath, technicalPath]) {
    requireCondition(
      plan.excluded.some(
        (entry) => entry.file === filename && entry.reason?.trim(),
      ),
      'DRAFT_AND_PROJECTION_MUST_REMAIN_EXCLUDED',
    );
    sourcePath(filename);
  }
  const draft = readJson(draftPath);
  requireCondition(
    draft.executable === false &&
      draft.status === 'DRAFT_REFERENCE_BINDING_REQUIRED' &&
      draft.project === plan.target.project_ref &&
      draft.schema === 'promotions' &&
      draft.classification === 'demo' &&
      draft.synthetic === true &&
      draft.approvals.rollback_scope === null &&
      draft.approvals.persistent_batch_and_target === null,
    'DRAFT_STATUS_CHANGED_REVIEW_REQUIRED',
  );
  for (const table of ['promotions', 'coupons']) {
    requireCondition(
      draft.proposed_rows[table].every((row) => row.state === 'INACTIVO'),
      'DEMO_MUST_REMAIN_INACTIVE',
    );
  }
  const sums = readFileSync(
    sourcePath('scripts/seed/mcp/promotions/SHA256SUMS'),
    'utf8',
  )
    .trim()
    .split(/\r?\n/);
  requireCondition(sums.length === 3, 'UNEXPECTED_HASH_INVENTORY');
  const hashed = new Set();
  for (const line of sums) {
    const match =
      /^([a-f0-9]{64})  (baseline-2026-10-16\.json|inka-athletics-draft\.json|trigger-body-review-2026-10-16\.json)$/.exec(
        line,
      );
    requireCondition(match && !hashed.has(match[2]), 'INVALID_HASH_MANIFEST');
    hashed.add(match[2]);
    const bytes = readFileSync(
      sourcePath(`scripts/seed/mcp/promotions/${match[2]}`),
    );
    requireCondition(
      createHash('sha256').update(bytes).digest('hex') === match[1],
      'FIXTURE_HASH_MISMATCH',
    );
  }
  return {
    result: 'PASS',
    scope: 'PLAN_VALIDATION_ONLY',
    plan_version: plan.version,
    target: plan.target,
    plan_sha256: createHash('sha256')
      .update(JSON.stringify(plan))
      .digest('hex'),
    identity_status: identities.status,
    approved_restore_entries: 0,
    verified_hashes: hashed.size,
    sql_executed: false,
    data_persisted: false,
    commercial_restore: 'NOT_EXECUTED',
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    requireCondition(
      process.argv.length === 2,
      'NO_EXECUTION_ARGUMENTS_SUPPORTED',
    );
    console.log(JSON.stringify(validateRestorePlan(), null, 2));
  } catch (error) {
    const code =
      error instanceof assert.AssertionError
        ? error.message
        : 'PLAN_VALIDATION_FAILED';
    console.error(/^[A-Z_]+$/.test(code) ? code : 'PLAN_VALIDATION_FAILED');
    process.exitCode = 1;
  }
}
