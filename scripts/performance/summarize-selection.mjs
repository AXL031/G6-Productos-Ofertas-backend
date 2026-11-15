import { mkdir, writeFile } from 'node:fs/promises';

const component = process.env.COMPONENT;
const jobResults = JSON.parse(process.env.JOB_RESULTS ?? '{}');
const scenarioJobs = {
  catalog: ['catalog_http_performance'],
  pricing: ['pricing_individual_http_performance'],
  combos: ['combos_pricing_http_performance'],
};

const selected = scenarioJobs[component] ?? [];
const scenarios = Object.fromEntries(
  selected.map((jobId) => [jobId, jobResults[jobId]?.result ?? 'missing']),
);
const complete =
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
  limitation: null,
  runId: process.env.GITHUB_RUN_ID ?? null,
};

await mkdir('.ci/performance/summary', { recursive: true });
await writeFile(
  '.ci/performance/summary/selection-summary.json',
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result, null, 2));
