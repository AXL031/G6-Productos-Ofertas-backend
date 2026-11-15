import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const inputDirectory = resolve(process.argv[2] ?? '.ci/performance/artifacts');
const outputDirectory = resolve(process.argv[3] ?? '.ci/performance/summary');

async function collect(directory) {
  const reports = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) reports.push(...(await collect(path)));
    else if (entry.isFile() && entry.name.endsWith('.json')) {
      try {
        const value = JSON.parse(await readFile(path, 'utf8'));
        if (
          value.results?.some(
            (row) => row.evidenceClass === 'HTTP_PROCESS_BENCHMARK',
          )
        )
          reports.push({ path, value });
      } catch (error) {
        throw new Error(
          `Invalid JSON benchmark artifact ${path}: ${error.message}`,
        );
      }
    }
  }
  return reports;
}

const reports = await collect(inputDirectory);
const pairs = new Map();
for (const { path, value } of reports) {
  const variant = value.variant;
  if (!['baseline', 'candidate'].includes(variant))
    throw new Error(`Missing baseline/candidate variant in ${path}`);
  for (const result of value.results) {
    const key = `${value.benchmark}|${result.service}|${result.endpoint}|${result.concurrency}`;
    const pair = pairs.get(key) ?? {};
    if (pair[variant]) throw new Error(`Duplicate ${variant} row for ${key}`);
    pair[variant] = { report: value, result };
    pairs.set(key, pair);
  }
}

const results = [];
for (const [key, pair] of pairs) {
  if (!pair.baseline || !pair.candidate)
    throw new Error(`No equivalent baseline/candidate HTTP case for ${key}`);
  const { baseline, candidate } = pair;
  for (const field of ['samples', 'concurrency'])
    if (baseline.result[field] !== candidate.result[field])
      throw new Error(`Incomparable ${field} for ${key}`);
  const delta = (before, after, reverse = false) => {
    if (!Number.isFinite(before) || before === 0 || !Number.isFinite(after))
      return null;
    return Number(
      (((reverse ? before - after : after - before) / before) * 100).toFixed(2),
    );
  };
  results.push({
    benchmark: candidate.report.benchmark,
    service: candidate.result.service,
    endpoint: candidate.result.endpoint,
    concurrency: candidate.result.concurrency,
    samplesPerVariant: candidate.result.samples,
    datasetProducts: candidate.result.datasetProducts ?? null,
    datasetRows: candidate.result.datasetRows ?? null,
    baselineSha: baseline.report.sha,
    candidateSha: candidate.report.sha,
    baselineP50Ms: baseline.result.p50Ms,
    candidateP50Ms: candidate.result.p50Ms,
    p50LatencyChangePercent: delta(
      baseline.result.p50Ms,
      candidate.result.p50Ms,
      true,
    ),
    baselineP95Ms: baseline.result.p95Ms,
    candidateP95Ms: candidate.result.p95Ms,
    p95LatencyChangePercent: delta(
      baseline.result.p95Ms,
      candidate.result.p95Ms,
      true,
    ),
    baselineP99Ms: baseline.result.p99Ms,
    candidateP99Ms: candidate.result.p99Ms,
    p99LatencyChangePercent: delta(
      baseline.result.p99Ms,
      candidate.result.p99Ms,
      true,
    ),
    baselineThroughputRps: baseline.result.throughputRequestsPerSecond,
    candidateThroughputRps: candidate.result.throughputRequestsPerSecond,
    throughputChangePercent: delta(
      baseline.result.throughputRequestsPerSecond,
      candidate.result.throughputRequestsPerSecond,
    ),
    baselineRequestUrlBytes: baseline.result.requestUrlBytes,
    candidateRequestUrlBytes: candidate.result.requestUrlBytes,
    requestUrlBytesChangePercent: delta(
      baseline.result.requestUrlBytes,
      candidate.result.requestUrlBytes,
    ),
    baselineResponseBodyBytes: baseline.result.responseBodyBytes,
    candidateResponseBodyBytes: candidate.result.responseBodyBytes,
    responseBodyBytesChangePercent: delta(
      baseline.result.responseBodyBytes,
      candidate.result.responseBodyBytes,
    ),
    baselineRequestBodyBytes: baseline.result.requestBodyBytes,
    candidateRequestBodyBytes: candidate.result.requestBodyBytes,
    requestBodyBytesChangePercent: delta(
      baseline.result.requestBodyBytes,
      candidate.result.requestBodyBytes,
    ),
    baselineFailures: baseline.result.failures,
    candidateFailures: candidate.result.failures,
    baselineTimeouts: baseline.result.timeouts,
    candidateTimeouts: candidate.result.timeouts,
    baselineSqlCalls: baseline.result.sqlCalls ?? null,
    candidateSqlCalls: candidate.result.sqlCalls ?? null,
    baselineSharedBlocksHit: baseline.result.sharedBlocksHit ?? null,
    candidateSharedBlocksHit: candidate.result.sharedBlocksHit ?? null,
    baselineSharedBlocksRead: baseline.result.sharedBlocksRead ?? null,
    candidateSharedBlocksRead: candidate.result.sharedBlocksRead ?? null,
    baselinePoolConnectionsObservedAfter:
      baseline.result.poolConnectionsObservedAfter ?? null,
    candidatePoolConnectionsObservedAfter:
      candidate.result.poolConnectionsObservedAfter ?? null,
    baselineDatabaseConnectionsObservedAfter:
      baseline.result.databaseConnectionsObservedAfter ?? null,
    candidateDatabaseConnectionsObservedAfter:
      candidate.result.databaseConnectionsObservedAfter ?? null,
    baselineActiveDatabaseConnectionsObservedAfter:
      baseline.result.activeDatabaseConnectionsObservedAfter ?? null,
    candidateActiveDatabaseConnectionsObservedAfter:
      candidate.result.activeDatabaseConnectionsObservedAfter ?? null,
    baselinePricingConnectionsObservedAfter:
      baseline.result.pricingConnectionsObservedAfter ?? null,
    candidatePricingConnectionsObservedAfter:
      candidate.result.pricingConnectionsObservedAfter ?? null,
    baselineCatalogConnectionsObservedAfter:
      baseline.result.catalogConnectionsObservedAfter ?? null,
    candidateCatalogConnectionsObservedAfter:
      candidate.result.catalogConnectionsObservedAfter ?? null,
    baselineActiveConnectionsObservedAfter:
      baseline.result.activeConnectionsObservedAfter ?? null,
    candidateActiveConnectionsObservedAfter:
      candidate.result.activeConnectionsObservedAfter ?? null,
    baselinePoolPeakTotalConnections:
      baseline.result.poolPeakTotalConnections ?? null,
    candidatePoolPeakTotalConnections:
      candidate.result.poolPeakTotalConnections ?? null,
    baselinePoolPeakConnectionsInUse:
      baseline.result.poolPeakConnectionsInUse ?? null,
    candidatePoolPeakConnectionsInUse:
      candidate.result.poolPeakConnectionsInUse ?? null,
    baselinePoolPeakWaitingClients:
      baseline.result.poolPeakWaitingClients ?? null,
    candidatePoolPeakWaitingClients:
      candidate.result.poolPeakWaitingClients ?? null,
    baselineExplainPlan:
      baseline.report.measurement?.explainPlans ??
      baseline.report.measurement?.explainPlan ??
      null,
    candidateExplainPlan:
      candidate.report.measurement?.explainPlans ??
      candidate.report.measurement?.explainPlan ??
      null,
    baselineRecovery: baseline.report.recovery ?? null,
    candidateRecovery: candidate.report.recovery ?? null,
  });
}

if (results.length === 0)
  throw new Error('No HTTP process benchmark rows found');
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  resolve(outputDirectory, 'g6-http-benchmark-comparison.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      evidenceClass: 'HTTP_PROCESS_BENCHMARK_COMPARISON',
      coverage: {
        measured: [
          {
            service: 'Catalog',
            endpoint: 'GET /api/v1/productos/administracion',
            runtime: 'Catalog child process + PostgreSQL 17 TLS container',
            dataset: '1000 synthetic draft products',
            authorization:
              'signed GESTOR_COMERCIAL test JWT under SIMULATED_AUTH',
          },
          {
            service: 'Gateway → Inventory',
            endpoint: 'GET /api/v1/inventario/disponibilidad/comercial',
            runtime:
              'Gateway Nest HTTP app + Inventory child process + PostgreSQL 17 container',
            dataset: 'two synthetic stock_balance rows',
            authorization: 'signed service JWT fixture',
          },
          {
            service: 'Inventory direct',
            endpoint: 'GET /api/v1/inventario/disponibilidad/comercial',
            runtime:
              'compiled Inventory Nest HTTP child process + PostgreSQL 17 container',
            dataset: 'two synthetic stock_balance rows',
            authorization:
              'signed service JWT fixture sent directly to Inventory',
          },
          {
            service: 'Combos',
            endpoint: 'GET /api/v1/combos; POST /api/v1/combos/administracion',
            runtime:
              'Combos Nest HTTP app + Catalog/Pricing child processes + PostgreSQL 17 TLS and RabbitMQ containers',
            dataset:
              'fixture products/prices plus disposable combos; create operation validates real Catalog/Pricing HTTP providers',
          },
          {
            service: 'Pricing',
            endpoint: 'GET /api/v1/precios/skus/{sku}',
            runtime:
              'Pricing Nest HTTP child process + PostgreSQL 17 TLS and RabbitMQ containers',
            dataset: 'isolated Pricing fixtures',
          },
          {
            service: 'Taxonomy',
            endpoint: 'GET /api/v1/marcas',
            runtime:
              'iniciarTaxonomySvc Nest HTTP app + PostgreSQL 17 TLS and RabbitMQ 4.2.9 containers',
            dataset: '1000 synthetic brands plus E2E fixtures',
            authorization:
              'RS256 local simulated-auth service token in isolated runner',
            databaseMetrics:
              'pg_stat_statements calls/buffers reset per window, EXPLAIN JSON, 5ms node-postgres pool occupancy sampling',
          },
        ],
        notMeasured: [
          'Promotions HTTP',
          'Price Audit HTTP',
          'Bulk HTTP',
          'Gateway other administrative screens',
        ],
        limits:
          'Combos/Pricing HTTP row does not yet collect SQL query counts, buffers, EXPLAIN plans or pool occupancy. Integration runners for Promotions, Price Audit and Bulk are not performance rows.',
      },
      rows: results,
    },
    null,
    2,
  )}\n`,
);
const columns = Object.keys(results[0]);
const csv = [
  columns.join(','),
  ...results.map((row) =>
    columns.map((column) => JSON.stringify(row[column] ?? '')).join(','),
  ),
].join('\n');
await writeFile(
  resolve(outputDirectory, 'g6-http-benchmark-comparison.csv'),
  `${csv}\n`,
);
console.log(
  `Summarized ${results.length} equivalent baseline/candidate HTTP rows.`,
);
