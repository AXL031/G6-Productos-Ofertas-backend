import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ci = await readFile('.github/workflows/ci.yml', 'utf8');
const performance = await readFile(
  '.github/workflows/performance-g6.yml',
  'utf8',
);
const summary = await readFile(
  'scripts/performance/summarize-selection.mjs',
  'utf8',
);
const pricingPersistence = await readFile(
  'apps/pricing-svc/test/persistence.e2e-spec.ts',
  'utf8',
);

const scenarioJobs = {
  catalog_http_performance: 'catalog',
  pricing_individual_http_performance: 'pricing',
  combos_pricing_http_performance: 'combos',
};

assert.match(ci, /^  automatizacion:/m, 'normal CI jobs remain present');
assert.match(ci, /mode:[\s\S]*?options: \[ci, benchmark\]/);
assert.match(
  ci,
  /component:[\s\S]*?options: \[catalog, pricing, combos, promotions, price-audit, bulk\]/,
  'the existing manual entry point exposes the requested component benchmarks',
);
assert.match(
  ci,
  /benchmark_focalizado:[\s\S]*?uses: \.\/\.github\/workflows\/performance-g6\.yml/,
);
assert.match(ci, /inputs\.mode != 'benchmark'/);
for (const jobId of Object.keys(scenarioJobs)) {
  assert.doesNotMatch(
    ci,
    new RegExp(`^  ${jobId}:`, 'm'),
    `${jobId} must run only in the performance workflow`,
  );
}
assert.match(performance, /^  workflow_dispatch:/m);
assert.match(performance, /^  workflow_call:/m);
assert.match(
  performance,
  /\^\(catalog\|pricing\|combos\|promotions\|price-audit\|bulk\|inventory-gateway\|taxonomy\)\$/,
  'preflight accepts every implemented component scenario',
);
assert.match(performance, /baseline_sha:/);
assert.match(performance, /parallelism:[\s\S]*?default: '1'[\s\S]*?- '2'/);
assert.match(
  performance,
  /max-parallel: \$\{\{ fromJSON\(inputs\.parallelism\) \}\}/,
);
assert.match(performance, /\^\[0-9a-fA-F\]\{40\}\$/);
assert.match(performance, /git fetch --no-tags origin/);
assert.match(performance, /git cat-file -e/);
assert.match(performance, /concurrency:/);

const jobStarts = [...performance.matchAll(/^  ([A-Za-z0-9_-]+):/gm)];
for (const [jobId, component] of Object.entries(scenarioJobs)) {
  const index = jobStarts.findIndex((match) => match[1] === jobId);
  assert.notEqual(index, -1, `${jobId} exists in the focused workflow`);
  const start = jobStarts[index].index;
  const nextJob = jobStarts[index + 1]?.index ?? performance.length;
  const block = performance.slice(start, nextJob);
  assert.ok(
    block.includes(`inputs.component == '${component}'`),
    `${jobId} is component-selectable`,
  );
  const dependencies = [...block.matchAll(/^    - ([A-Za-z0-9_-]+)$/gm)].map(
    (match) => match[1],
  );
  const allowedDependencies =
    jobId === 'promotions_paired_http_performance'
      ? ['preflight', 'promotions_http_performance']
      : ['preflight'];
  assert.deepEqual(
    dependencies,
    allowedDependencies,
    `${jobId} has no cross-component dependency`,
  );
  assert.match(block, /timeout-minutes:/, `${jobId} has a runtime limit`);
  assert.match(
    block,
    /actions\/upload-artifact/,
    `${jobId} keeps scenario evidence`,
  );
  assert.match(
    block,
    /if: always\(\)/,
    `${jobId} uploads evidence after failure`,
  );
}

assert.match(summary, /'PARTIAL'/);
assert.match(summary, /integral: false/);
assert.match(summary, /pricing: \['pricing_individual_http_performance'\]/);
assert.doesNotMatch(summary, /pricing_batch_benchmark/);
assert.match(
  performance,
  /inputs\.component == 'pricing' && inputs\.include_legacy_pricing/,
);
assert.match(performance, /selection-summary\.json/);
assert.match(
  performance,
  /Obtener script de resumen[\s\S]*?actions\/checkout@v4/,
);
assert.match(performance, /needs\.preflight\.outputs\.baseline_sha/);
assert.match(performance, /needs\.preflight\.outputs\.candidate_sha/);
assert.match(performance, /G6_PERFORMANCE_SHA/);
assert.match(
  pricingPersistence,
  /mide GET individual HTTP de SKU con PostgreSQL desechable/,
);
for (const jobId of [
  'catalog_http_performance',
  'pricing_individual_http_performance',
  'combos_pricing_http_performance',
]) {
  const index = jobStarts.findIndex((match) => match[1] === jobId);
  const start = jobStarts[index].index;
  const nextJob = jobStarts[index + 1]?.index ?? performance.length;
  const block = performance.slice(start, nextJob);
  assert.doesNotMatch(
    block,
    /^    strategy:/m,
    `${jobId} keeps the pair on one runner`,
  );
  if (jobId === 'pricing_individual_http_performance') {
    const runOrder = [
      'baseline-first',
      'candidate-first',
      'candidate-second',
      'baseline-second',
    ].map((label) => block.indexOf(label));
    assert.ok(
      runOrder.every((position) => position >= 0),
      `${jobId} includes all four paired runs`,
    );
    assert.deepEqual(
      [...runOrder].sort((a, b) => a - b),
      runOrder,
      `${jobId} alternates baseline and candidate`,
    );
    continue;
  }
  const runOrder = [
    'baseline-first',
    'candidate-first',
    'candidate-second',
    'baseline-second',
  ].map((label) => block.indexOf(label));
  assert.ok(
    runOrder.every((position) => position >= 0),
    `${jobId} includes all four paired runs`,
  );
  assert.deepEqual(
    [...runOrder].sort((a, b) => a - b),
    runOrder,
    `${jobId} alternates baseline and candidate`,
  );
}

console.log(
  'PASS: CI is separated; manual scenarios are selectable, bounded, verified, and evidence preserving.',
);
