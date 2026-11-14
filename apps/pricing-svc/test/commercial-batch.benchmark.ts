import { createServer, type Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommercialPrices, channels } from '../src/http/commercial-prices.js';
import { CatalogContextHttp } from '../src/http/catalog-context.js';
import type { PricingConfig } from '../src/config/environment.js';
import { PriceRuleError } from '../src/domain/price.js';
import { PricingHttpError } from '../src/http/pricing-http.error.js';
import { PricingDatabase } from '../src/persistence/pricing.database.js';
import { PricingRepository } from '../src/persistence/pricing.repository.js';
import { IsolatedPostgres } from './isolated-postgres.js';

const CURRENT = new Date('2030-06-01T00:00:00Z');
const HISTORICAL = new Date('2029-06-01T00:00:00Z');
// 100 observations make the reported p99 an order statistic rather than the
// maximum of a five-request smoke sample.
const SAMPLE_COUNT = 100;
const CONTEXT_DELAY_MS = 4;
const BATCH_SIZES = [1, 20, 100] as const;
const CONCURRENCY_LEVELS = [1, 2, 4, 8, 16] as const;

interface CatalogFixtureContext {
  sku: string;
  productId: string;
  isVariant: boolean;
  active: boolean;
  eligible: boolean;
  index: number;
}

interface PriceSeed {
  productId: string | null;
  sku: string | null;
  channelId: string | null;
  index: number;
  channelIndex: number;
}

function fixtureSku(index: number): string {
  return `SKU-${String(index).padStart(3, '0')}`;
}

function fixtureContext(index: number): CatalogFixtureContext {
  const sku = fixtureSku(index);
  if (index % 17 === 0)
    return {
      sku,
      productId: `missing-price-${index}`,
      isVariant: false,
      active: true,
      eligible: true,
      index,
    };
  const isVariant = index % 3 !== 0;
  return {
    sku,
    productId: isVariant
      ? `variant-parent-${Math.floor(index / 3)}`
      : `simple-product-${index}`,
    isVariant,
    active: true,
    eligible: true,
    index,
  };
}

function definitionKey(seed: PriceSeed): string {
  return [seed.productId ?? '', seed.sku ?? '', seed.channelId ?? ''].join('|');
}

function valuesClause(rowCount: number, width: number): string {
  return Array.from({ length: rowCount }, (_, row) => {
    const columns = Array.from(
      { length: width },
      (_unused, column) => `$${row * width + column + 1}`,
    );
    return `(${columns.join(', ')})`;
  }).join(', ');
}

function priceSeeds(contexts: readonly CatalogFixtureContext[]): PriceSeed[] {
  const products = new Map<string, number>();
  for (const context of contexts)
    if (!context.productId.startsWith('missing-price-'))
      products.set(context.productId, context.index);
  const rows: PriceSeed[] = [];
  for (const [productId, index] of products) {
    rows.push({
      productId,
      sku: null,
      channelId: null,
      index,
      channelIndex: -1,
    });
    channels.forEach((channelId, channelIndex) => {
      if ((index + channelIndex) % 2 === 0)
        rows.push({ productId, sku: null, channelId, index, channelIndex });
    });
  }
  for (const context of contexts)
    if (
      context.isVariant &&
      !context.productId.startsWith('missing-price-') &&
      context.index % 10 === 1
    ) {
      const channelIndex = context.index % channels.length;
      rows.push({
        productId: null,
        sku: context.sku,
        channelId: channels[channelIndex],
        index: context.index,
        channelIndex,
      });
    }
  return rows;
}

async function seedIsolatedPricing(
  admin: Pool,
  definitions: readonly PriceSeed[],
): Promise<void> {
  const client = await admin.connect();
  await client.query('BEGIN');
  try {
    const priceValues = definitions.flatMap((row) => [
      row.productId,
      row.sku,
      row.channelId,
      2,
    ]);
    const inserted = await client.query<{
      id: string;
      product_id: string | null;
      sku: string | null;
      channel_id: string | null;
    }>(
      `INSERT INTO pricing.prices (product_id, sku, channel_id, price_version)
     VALUES ${valuesClause(definitions.length, 4)}
     RETURNING id, product_id, sku, channel_id`,
      priceValues,
    );
    const seedsByKey = new Map(
      definitions.map((seed) => [definitionKey(seed), seed]),
    );
    const validityRows = inserted.rows.flatMap((price) => {
      const seed = seedsByKey.get(
        definitionKey({
          productId: price.product_id,
          sku: price.sku,
          channelId: price.channel_id,
          index: 0,
          channelIndex: 0,
        }),
      );
      if (!seed)
        throw new Error('No se encontró la clave de la fixture local.');
      const offset = Math.max(seed.channelIndex, 0);
      const regular = 100 + (seed.index % 40) + offset;
      const historicalRegular = 70 + (seed.index % 30) + offset;
      const offer = (seed.index + offset) % 7 === 0 ? regular - 10 : null;
      const terms = (amount: number) => amount.toFixed(2);
      return [
        [
          price.id,
          terms(historicalRegular),
          null,
          'PEN',
          '2029-01-01T00:00:00.000Z',
          '2030-01-01T00:00:00.000Z',
          1,
          'fixture historial benchmark',
          null,
          false,
        ],
        [
          price.id,
          terms(regular),
          offer === null ? null : terms(offer),
          'PEN',
          '2030-01-01T00:00:00.000Z',
          null,
          2,
          'fixture vigente benchmark',
          null,
          false,
        ],
      ];
    });
    const flattened = validityRows.flat();
    await client.query(
      `INSERT INTO pricing.price_validities
       (price_id, precio_regular, precio_oferta, currency, valid_from,
        valid_until, price_version, motivo_cambio, usuario_id, is_cancelled)
     VALUES ${valuesClause(validityRows.length, 10)}`,
      flattened,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function percentile(
  values: readonly number[],
  percentileValue: number,
): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)];
}

function stats(values: readonly number[]) {
  return {
    p50Ms: Number(percentile(values, 0.5).toFixed(2)),
    p95Ms: Number(percentile(values, 0.95).toFixed(2)),
    p99Ms: Number(percentile(values, 0.99).toFixed(2)),
  };
}

function isAbsentPrice(error: unknown): boolean {
  return (
    (error instanceof PricingHttpError &&
      error.status === 404 &&
      error.code === 'PRECIO_NO_ENCONTRADO') ||
    (error instanceof PriceRuleError && error.code === 'PRECIO_NO_ENCONTRADO')
  );
}

describe('C3 Pricing: benchmark aislado de consulta comercial por lotes', () => {
  let isolated: IsolatedPostgres;
  let database: PricingDatabase;
  let repository: PricingRepository;
  let service: CommercialPrices;
  let individualContextService: CommercialPrices;
  let server: Server;
  let serverOrigin: string;
  let contexts: Map<string, CatalogFixtureContext>;
  let requests = 0;
  let activeRequests = 0;
  let maximumRequests = 0;
  let querySpy: ReturnType<typeof vi.spyOn<typeof Client.prototype, 'query'>>;

  beforeAll(async () => {
    isolated = new IsolatedPostgres();
    await isolated.start();
    contexts = new Map(
      Array.from({ length: 100 }, (_, index) => {
        const context = fixtureContext(index);
        return [context.sku, context] as const;
      }),
    );
    await seedIsolatedPricing(
      isolated.admin!,
      priceSeeds([...contexts.values()]),
    );

    server = createServer(async (request, response) => {
      requests += 1;
      activeRequests += 1;
      maximumRequests = Math.max(maximumRequests, activeRequests);
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const batch = request.method === 'POST';
        const requestedSkus = batch
          ? (
              JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                skus: string[];
              }
            ).skus
          : [];
        await delay(CONTEXT_DELAY_MS);
        const encodedSku = request.url?.match(
          /^\/api\/v1\/productos\/skus\/([^/]+)\/contexto$/,
        )?.[1];
        const sku = encodedSku ? decodeURIComponent(encodedSku) : undefined;
        if (sku === 'SKU-503' || requestedSkus.includes('SKU-503')) {
          response.writeHead(503, {
            'content-type': 'application/problem+json',
          });
          response.end(
            JSON.stringify({ status: 503, code: 'SERVICIO_NO_DISPONIBLE' }),
          );
          return;
        }
        if (batch) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              items: requestedSkus.map((requestedSku) => {
                const context = contexts.get(requestedSku);
                return context
                  ? {
                      sku: requestedSku,
                      status: 'FOUND',
                      context: {
                        sku: context.sku,
                        productId: context.productId,
                        isVariant: context.isVariant,
                        active: context.active,
                        eligible: context.eligible,
                      },
                    }
                  : {
                      sku: requestedSku,
                      status: 'SKU_NO_ENCONTRADO',
                      context: null,
                    };
              }),
            }),
          );
          return;
        }
        const context = sku ? contexts.get(sku) : undefined;
        if (!context) {
          response.writeHead(404, {
            'content-type': 'application/problem+json',
          });
          response.end(
            JSON.stringify({ status: 404, code: 'SKU_NO_ENCONTRADO' }),
          );
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            sku: context.sku,
            productId: context.productId,
            isVariant: context.isVariant,
            active: context.active,
            eligible: context.eligible,
          }),
        );
      } finally {
        activeRequests -= 1;
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('El servidor Catálogo de fixture no tiene puerto TCP.');
    serverOrigin = `http://127.0.0.1:${address.port}`;

    const config: PricingConfig = {
      nodeEnv: 'test',
      port: 3002,
      databaseUrl: isolated.runtimeUrl,
      databaseSsl: false,
      securityMode: 'G7_AUTHENTICATED',
      publicOperations: [],
      catalogUrl: serverOrigin,
    };
    database = new PricingDatabase(config);
    repository = new PricingRepository(database);
    const catalog = new CatalogContextHttp(
      config,
      async () => 'benchmark-fixture-token',
    );
    service = new CommercialPrices(repository, catalog);
    individualContextService = new CommercialPrices(repository, {
      resolve: catalog.resolve.bind(catalog),
    });
    querySpy = vi.spyOn(Client.prototype, 'query');
  }, 120_000);

  afterAll(async () => {
    querySpy?.mockRestore();
    await database?.onApplicationShutdown();
    if (server?.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await isolated?.stop();
  }, 30_000);

  function selectCountSince(callIndex: number): number {
    return selectQueriesSince(callIndex).length;
  }

  function selectQueriesSince(callIndex: number) {
    return querySpy.mock.calls.slice(callIndex).flatMap((call) => {
      const [query, parameters] = call;
      const text = typeof query === 'string' ? query : query.text;
      const values = Array.isArray(parameters)
        ? parameters
        : typeof query === 'string'
          ? []
          : query.values;
      return /^\s*select\b/i.test(text) ? [{ text, values }] : [];
    });
  }

  async function legacyBatch(
    skus: readonly string[],
    channel: (typeof channels)[number],
    at: Date,
    historical = false,
  ) {
    const items: Awaited<ReturnType<CommercialPrices['sku']>>[] = [];
    for (const sku of skus) {
      try {
        items.push(await service.sku(sku, channel, at, historical));
      } catch (error) {
        if (!isAbsentPrice(error)) throw error;
      }
    }
    return { items };
  }

  it('compara 1/20/100 SKU en los cuatro canales y verifica la equivalencia comercial', async () => {
    const cases: Array<Record<string, unknown>> = [];
    let candidateExplains: unknown[] = [];
    for (const channel of channels) {
      for (const size of BATCH_SIZES) {
        const skus = Array.from({ length: size }, (_, index) =>
          fixtureSku(index),
        );
        const oldCallIndex = querySpy.mock.calls.length;
        const oldStart = requests;
        const legacy = await legacyBatch(skus, channel, CURRENT);
        const legacySelects = selectCountSince(oldCallIndex);
        const legacyContextRequests = requests - oldStart;

        const newCallIndex = querySpy.mock.calls.length;
        const newStart = requests;
        const optimized = await service.batch(skus, channel, CURRENT);
        const optimizedSelects = selectCountSince(newCallIndex);
        const optimizedContextRequests = requests - newStart;
        expect(optimized).toEqual(legacy);
        if (size === 100 && channel === 'RETAIL') {
          const candidateQueries = selectQueriesSince(newCallIndex);
          expect(candidateQueries).toHaveLength(2);
          candidateExplains = await Promise.all(
            candidateQueries.map(async (query) => {
              const result = await isolated.admin!.query<{
                'QUERY PLAN': unknown;
              }>(
                `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`,
                query.values,
              );
              const rawPlan = result.rows[0]?.['QUERY PLAN'];
              if (!Array.isArray(rawPlan) || !rawPlan[0])
                throw new Error('PostgreSQL no devolvió un plan JSON válido.');
              const plan = rawPlan[0] as {
                Plan?: {
                  'Node Type'?: string;
                  'Relation Name'?: string;
                  'Actual Rows'?: number;
                  'Actual Total Time'?: number;
                  'Shared Hit Blocks'?: number;
                  'Shared Read Blocks'?: number;
                };
                'Planning Time'?: number;
                'Execution Time'?: number;
              };
              return {
                nodeType: plan.Plan?.['Node Type'],
                relation: plan.Plan?.['Relation Name'],
                actualRows: plan.Plan?.['Actual Rows'],
                actualTotalTimeMs: plan.Plan?.['Actual Total Time'],
                sharedHitBlocks: plan.Plan?.['Shared Hit Blocks'],
                sharedReadBlocks: plan.Plan?.['Shared Read Blocks'],
                planningTimeMs: plan['Planning Time'],
                executionTimeMs: plan['Execution Time'],
              };
            }),
          );
        }

        const legacyDurations: number[] = [];
        const optimizedDurations: number[] = [];
        for (let round = 0; round < SAMPLE_COUNT; round++) {
          const measure = async (operation: () => Promise<unknown>) => {
            const started = performance.now();
            const result = await operation();
            return { elapsed: performance.now() - started, result };
          };
          if (round % 2 === 0) {
            const old = await measure(() =>
              legacyBatch(skus, channel, CURRENT),
            );
            const next = await measure(() =>
              service.batch(skus, channel, CURRENT),
            );
            expect(next.result).toEqual(old.result);
            legacyDurations.push(old.elapsed);
            optimizedDurations.push(next.elapsed);
          } else {
            const next = await measure(() =>
              service.batch(skus, channel, CURRENT),
            );
            const old = await measure(() =>
              legacyBatch(skus, channel, CURRENT),
            );
            expect(next.result).toEqual(old.result);
            optimizedDurations.push(next.elapsed);
            legacyDurations.push(old.elapsed);
          }
        }
        cases.push({
          size,
          channel,
          legacy: {
            ...stats(legacyDurations),
            selectStatements: legacySelects,
            catalogRequests: legacyContextRequests,
          },
          batch: {
            ...stats(optimizedDurations),
            selectStatements: optimizedSelects,
            catalogRequests: optimizedContextRequests,
          },
        });
      }
    }

    console.log(
      'C3_BATCH_COMPARISON ' +
        JSON.stringify({
          environment:
            'disposable PostgreSQL 16 Docker + Catalog HTTP loopback fixture',
          catalogLatencyMs: CONTEXT_DELAY_MS,
          samplesPerCase: SAMPLE_COUNT,
          databasePoolMax: 2,
          databaseQueryTimeoutMs: 2000,
          gatewayDefaultTimeoutMs: 5000,
          note: 'Gateway timeout is documented configuration, not measured Gateway p95; Catalog fixture adds 4 ms loopback latency.',
          candidateExplains,
          cases,
        }),
    );
  }, 900_000);

  it('calibra contexto Catálogo con concurrencias 1/2/4/8/16 y registra el p95', async () => {
    const skus = Array.from({ length: 100 }, (_, index) => fixtureSku(index));
    const measurements: Array<Record<string, number>> = [];
    for (const concurrency of CONCURRENCY_LEVELS) {
      const latencies: number[] = [];
      let observedMaximum = 0;
      for (let round = 0; round < SAMPLE_COUNT; round++) {
        maximumRequests = 0;
        const started = performance.now();
        const result = await individualContextService.batch(
          skus,
          'RETAIL',
          CURRENT,
          false,
          undefined,
          concurrency,
        );
        latencies.push(performance.now() - started);
        observedMaximum = Math.max(observedMaximum, maximumRequests);
        expect(result.items.length).toBeGreaterThan(0);
        expect(maximumRequests).toBeLessThanOrEqual(concurrency);
      }
      measurements.push({
        concurrency,
        ...stats(latencies),
        observedMaximum,
      });
    }
    console.log(
      'C3_CONCURRENCY ' +
        JSON.stringify({
          size: 100,
          channel: 'RETAIL',
          catalogLatencyMs: CONTEXT_DELAY_MS,
          samples: SAMPLE_COUNT,
          databasePoolMax: 2,
          gatewayDefaultTimeoutMs: 5000,
          measurements,
        }),
    );
  }, 900_000);

  it('conserva duplicados, variantes, herencia global, vigencia histórica, ausencias y error 503', async () => {
    const duplicated = ['SKU-001', 'SKU-001', 'SKU-002'];
    const legacyDuplicate = await legacyBatch(duplicated, 'CHATBOT', CURRENT);
    const newDuplicate = await service.batch(duplicated, 'CHATBOT', CURRENT);
    expect(newDuplicate).toEqual(legacyDuplicate);
    expect(newDuplicate.items.map((item) => item.sku)).toEqual(duplicated);
    expect(newDuplicate.items[0]?.origen).toBe('SKU_OVERRIDE');
    expect(newDuplicate.items[2]?.origen).toBe('PRODUCTO');
    const globalFallback = await service.batch(
      ['SKU-004'],
      'MARKETPLACE',
      CURRENT,
    );
    expect(globalFallback.items[0]?.channel_id).toBeNull();

    const historicalSkus = ['SKU-001', 'SKU-002', 'SKU-003', 'SKU-004'];
    const oldHistorical = await legacyBatch(
      historicalSkus,
      'CHATBOT',
      HISTORICAL,
      true,
    );
    const newHistorical = await service.batch(
      historicalSkus,
      'CHATBOT',
      HISTORICAL,
      true,
    );
    expect(newHistorical).toEqual(oldHistorical);
    expect(newHistorical.items.every((item) => item.price_version === 1)).toBe(
      true,
    );

    const absentPrice = await service.batch(['SKU-000'], 'RETAIL', CURRENT);
    expect(absentPrice.items).toEqual([]);

    await expect(
      legacyBatch(['SKU-001', 'SKU-503'], 'RETAIL', CURRENT),
    ).rejects.toMatchObject({
      status: 503,
      code: 'SERVICIO_NO_DISPONIBLE',
    });
    await expect(
      service.batch(['SKU-001', 'SKU-503'], 'RETAIL', CURRENT),
    ).rejects.toMatchObject({
      status: 503,
      code: 'SERVICIO_NO_DISPONIBLE',
    });
  });
});
