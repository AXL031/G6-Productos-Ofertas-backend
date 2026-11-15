import { mkdir, writeFile } from 'node:fs/promises';

const component = process.env.COMPONENT;
const jobResults = JSON.parse(process.env.JOB_RESULTS ?? '{}');
const scenarioJobs = {
  pricing: ['pricing_batch_benchmark'],
  promotions: [
    'promotions_http_performance',
    'promotions_paired_http_performance',
  ],
  'price-audit': ['price_audit_http_performance'],
  bulk: ['bulk_http_performance'],
  catalog: ['catalog_http_performance'],
  'inventory-gateway': ['gateway_inventory_http_performance'],
  combos: ['combos_pricing_http_performance'],
  taxonomy: ['taxonomy_http_performance'],
};

const selected = scenarioJobs[component] ?? [];
const scenarios = Object.fromEntries(
  selected.map((jobId) => [jobId, jobResults[jobId]?.result ?? 'missing']),
);
const complete =
  component !== 'pricing' &&
  jobResults.preflight?.result === 'success' &&
  selected.length > 0 &&
  selected.every((jobId) => scenarios[jobId] === 'success');
const result = {
  classification: complete ? 'PASS_SELECTED_SCENARIOS' : 'PARTIAL',
  integral: false,
  component,
  scenarios,
  baselineSha: jobResults.preflight?.outputs?.baseline_sha ?? null,
  candidateSha: jobResults.preflight?.outputs?.candidate_sha ?? null,
  limitation:
    component === 'pricing'
      ? 'The existing batch harness compares legacy and optimized algorithms within the candidate; it does not execute a baseline revision or measure the individual HTTP endpoint.'
      : null,
  runId: process.env.GITHUB_RUN_ID ?? null,
};

await mkdir('.ci/performance/summary', { recursive: true });
await writeFile(
  '.ci/performance/summary/selection-summary.json',
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result, null, 2));
