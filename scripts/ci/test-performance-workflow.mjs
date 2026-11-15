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

const scenarioJobs = {
  pricing_batch_benchmark: 'pricing',
  promotions_http_performance: 'promotions',
  promotions_paired_http_performance: 'promotions',
  price_audit_http_performance: 'price-audit',
  bulk_http_performance: 'bulk',
  catalog_http_performance: 'catalog',
  combos_pricing_http_performance: 'combos',
  gateway_inventory_http_performance: 'inventory-gateway',
  taxonomy_http_performance: 'taxonomy',
};

assert.match(ci, /^  automatizacion:/m, 'normal CI jobs remain present');
for (const jobId of Object.keys(scenarioJobs)) {
  assert.doesNotMatch(
    ci,
    new RegExp(`^  ${jobId}:`, 'm'),
    `${jobId} must run only in the performance workflow`,
  );
}
assert.match(performance, /^  workflow_dispatch:/m);
assert.match(performance, /baseline_sha:/);
assert.match(performance, /parallelism:[\s\S]*?default: '1'[\s\S]*?- '2'/);
assert.match(performance, /max-parallel: \$\{\{ fromJSON\(inputs\.parallelism\) \}\}/);
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
  assert.ok(block.includes(`inputs.component == '${component}'`), `${jobId} is component-selectable`);
  const dependencies = [...block.matchAll(/^    - ([A-Za-z0-9_-]+)$/gm)].map(
    (match) => match[1],
  );
  const allowedDependencies =
    jobId === 'promotions_paired_http_performance'
      ? ['preflight', 'promotions_http_performance']
      : ['preflight'];
  assert.deepEqual(dependencies, allowedDependencies, `${jobId} has no cross-component dependency`);
  assert.match(block, /timeout-minutes:/, `${jobId} has a runtime limit`);
  assert.match(block, /actions\/upload-artifact/, `${jobId} keeps scenario evidence`);
  assert.match(block, /if: always\(\)/, `${jobId} uploads evidence after failure`);
}

assert.match(summary, /'PARTIAL'/);
assert.match(summary, /integral: false/);
assert.match(summary, /component !== 'pricing'/);
assert.match(summary, /does not execute a baseline revision/);
assert.match(performance, /selection-summary\.json/);
assert.match(performance, /Obtener script de resumen[\s\S]*?actions\/checkout@v4/);
assert.match(performance, /needs\.preflight\.outputs\.baseline_sha/);
assert.match(performance, /needs\.preflight\.outputs\.candidate_sha/);
for (const jobId of ['catalog_http_performance', 'combos_pricing_http_performance']) {
  const index = jobStarts.findIndex((match) => match[1] === jobId);
  const start = jobStarts[index].index;
  const nextJob = jobStarts[index + 1]?.index ?? performance.length;
  const block = performance.slice(start, nextJob);
  assert.doesNotMatch(block, /^    strategy:/m, `${jobId} keeps the pair on one runner`);
  const runOrder = [
    'baseline-first',
    'candidate-first',
    'candidate-second',
    'baseline-second',
  ].map((label) => block.indexOf(label));
  assert.ok(runOrder.every((position) => position >= 0), `${jobId} includes all four paired runs`);
  assert.deepEqual([...runOrder].sort((a, b) => a - b), runOrder, `${jobId} alternates baseline and candidate`);
}

console.log('PASS: CI is separated; manual scenarios are selectable, bounded, verified, and evidence preserving.');
