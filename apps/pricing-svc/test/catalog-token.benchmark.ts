import { createServer, type Server } from 'node:http';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignedUser } from './signed-user.js';
import { validateEnvironment } from '../src/config/environment.js';
import { CatalogServiceToken } from '../src/http/catalog-token.js';
import { PricingReadGuard } from '../src/http/pricing-read.guard.js';

const WARMUP_WAVES = 5;
const SAMPLE_WAVES = 100;
const CONCURRENCY_LEVELS = [1, 4, 16] as const;
const ISSUER_DELAY_MS = 4;
const outputRoot = resolve(
  process.env.G6_PERFORMANCE_OUTPUT ?? '.ci/performance',
);

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

describe('Pricing token issuer cold-start benchmark (signed test issuer)', () => {
  const identity = new SignedUser();
  let server: Server;
  let origin = '';
  let tokenRequests = 0;
  let requestBytes = 0;
  let responseBytes = 0;
  let active = 0;
  let maximumActive = 0;
  let failures = 0;
  let config: ReturnType<typeof validateEnvironment>;
  let guard: PricingReadGuard;

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/jwks') {
        response.end(JSON.stringify({ keys: [identity.jwk] }));
        return;
      }
      tokenRequests += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString('utf8');
        requestBytes += Buffer.byteLength(body);
        const scope = new URLSearchParams(body).get('scope') ?? '';
        await delay(ISSUER_DELAY_MS);
        const payload = JSON.stringify({
          accessToken: identity.token({
            tipo: 'servicio',
            sub: 'modulo-productos',
            aud: 'api-productos',
            scope,
            exp: Math.floor(Date.now() / 1000) + 300,
          }),
          tokenType: 'Bearer',
          expiresIn: 300,
          scopes: [scope],
        });
        responseBytes += Buffer.byteLength(payload);
        response.end(payload);
      } catch {
        failures += 1;
        response.statusCode = 500;
        response.end('{}');
      } finally {
        active -= 1;
      }
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Issuer fixture sin puerto.');
    origin = `http://127.0.0.1:${address.port}`;
    identity.issuer = origin;
    config = validateEnvironment({
      NODE_ENV: 'test',
      PRICING_SVC_PORT: '3002',
      DATABASE_URL: 'postgresql://pricing:fixture@127.0.0.1:5432/pricing',
      AUTH_ISSUER: origin,
      AUTH_JWKS_URL: `${origin}/jwks`,
      PRICING_SERVICE_TOKEN_URL: `${origin}/api/v1/auth/token`,
      PRICING_SERVICE_CLIENT_SECRET: 'benchmark-only-secret',
    });
    guard = new PricingReadGuard(config);
    await new CatalogServiceToken(config, guard).get('catalogo:leer');
    tokenRequests = 0;
    requestBytes = 0;
    responseBytes = 0;
    active = 0;
    maximumActive = 0;
    failures = 0;
  }, 30_000);

  afterAll(async () => {
    server?.closeAllConnections();
    if (server?.listening)
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
  });

  it('mide emisión concurrente por nivel y escribe JSON/CSV reproducibles', async () => {
    const rows: Array<Record<string, number | string>> = [];
    for (const concurrency of CONCURRENCY_LEVELS) {
      const samples: number[] = [];
      tokenRequests = 0;
      requestBytes = 0;
      responseBytes = 0;
      maximumActive = 0;
      failures = 0;
      for (let wave = 0; wave < SAMPLE_WAVES + WARMUP_WAVES; wave += 1) {
        const service = new CatalogServiceToken(config, guard);
        const started = performance.now();
        const results = await Promise.all(
          Array.from({ length: concurrency }, () =>
            service.get('catalogo:leer'),
          ),
        );
        const elapsed = performance.now() - started;
        expect(new Set(results).size).toBe(1);
        if (wave === WARMUP_WAVES - 1) {
          // Warmup requests are intentionally excluded from every metric.
          tokenRequests = 0;
          requestBytes = 0;
          responseBytes = 0;
          maximumActive = 0;
          failures = 0;
        } else if (wave >= WARMUP_WAVES) samples.push(elapsed);
      }
      const totalMs = samples.reduce((sum, value) => sum + value, 0);
      const logicalRequests = samples.length * concurrency;
      rows.push({
        component: 'pricing-token-issuer-client',
        evidenceClass: 'COMPONENT_MICROBENCHMARK',
        concurrency,
        coldStartWaves: samples.length,
        logicalRequests,
        p50Ms: Number(percentile(samples, 0.5).toFixed(3)),
        p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
        p99Ms: Number(percentile(samples, 0.99).toFixed(3)),
        logicalRequestsPerSecond: Number(
          ((logicalRequests * 1000) / totalMs).toFixed(2),
        ),
        issuerCalls: tokenRequests,
        issuerCallsPerWave: Number((tokenRequests / samples.length).toFixed(3)),
        issuerCallsPerLogicalRequest: Number(
          (tokenRequests / logicalRequests).toFixed(4),
        ),
        maxConcurrentIssuerCalls: maximumActive,
        issuerRequestBodyBytes: requestBytes,
        issuerResponseBodyBytes: responseBytes,
        failures,
      });
    }
    const report = {
      schemaVersion: 1,
      benchmark: 'pricing-token-issuer-cold-start',
      sha: execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
      branch: execFileSync('git', ['branch', '--show-current'], {
        encoding: 'utf8',
      }).trim(),
      node: process.version,
      runner: {
        os: process.platform,
        arch: process.arch,
        cpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
      },
      scope: {
        serviceProcess: false,
        database: false,
        rabbitMq: false,
        requestLevel: 'Pricing token client → local signed issuer',
        limitation:
          'No es benchmark de servicio HTTP ni sustituye pruebas de rendimiento por bounded context.',
      },
      issuer: {
        type: 'local signed test issuer',
        delayMs: ISSUER_DELAY_MS,
        productionAccess: false,
      },
      warmupWaves: WARMUP_WAVES,
      sampleWaves: SAMPLE_WAVES,
      results: rows,
    };
    await mkdir(outputRoot, { recursive: true });
    await writeFile(
      resolve(outputRoot, 'pricing-token-benchmark.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    const header = Object.keys(rows[0] ?? {})
      .map(csvCell)
      .join(',');
    const csv =
      [
        header,
        ...rows.map((row) => Object.values(row).map(csvCell).join(',')),
      ].join('\n') + '\n';
    await writeFile(resolve(outputRoot, 'pricing-token-benchmark.csv'), csv);
    expect(failures).toBe(0);
    expect(
      rows.every(
        (row) =>
          row.issuerCallsPerWave === 1 &&
          row.issuerCalls === row.coldStartWaves &&
          row.issuerCallsPerLogicalRequest === 1 / row.concurrency,
      ),
    ).toBe(true);
  }, 120_000);
});
