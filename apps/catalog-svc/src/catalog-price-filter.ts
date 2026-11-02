import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CatalogConfig } from './config.js';
import type { Canal, ProductQuery } from './commercial.types.js';
import { compareDecimal, parseDecimalJson } from './decimal.js';

export const CATALOG_PRICING_IDENTITY = Symbol('CATALOG_PRICING_IDENTITY');
/** G7-owned integration boundary. Never receives a consumer's incoming Bearer. */
export interface CatalogPricingIdentity {
  authorization(signal: AbortSignal): Promise<string>;
}
export interface PriceCandidate {
  productId: string;
  sku: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function instant(value: unknown): number {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    throw new Error();
  const time = Date.parse(value);
  if (
    !Number.isFinite(time) ||
    new Date(value.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) !==
      value.slice(0, 10)
  )
    throw new Error();
  return time;
}

@Injectable()
export class CatalogPriceFilter {
  constructor(
    @Optional()
    @Inject(CatalogConfig)
    private readonly config?: Pick<CatalogConfig, 'pricingOrigin' | 'readDemo'>,
    @Optional()
    @Inject(CATALOG_PRICING_IDENTITY)
    private readonly identity?: CatalogPricingIdentity,
  ) {}

  private async batch(
    skus: string[],
    canal: Canal | undefined,
    at: string,
    correlation: string,
    signal: AbortSignal,
  ): Promise<Array<{ sku: string; effective: string; currency: string }>> {
    if (
      !this.config?.pricingOrigin ||
      (!this.config.readDemo?.restricted && !this.identity)
    )
      throw new Error();
    // A comma cannot be represented unambiguously by the batch CSV contract.
    const individual = skus.length === 1 && skus[0].includes(',');
    if (skus.some((sku) => !sku || (!individual && sku.includes(','))))
      throw new Error();
    const authorization = this.config.readDemo?.restricted
      ? undefined
      : await this.identity!.authorization(signal);
    signal.throwIfAborted();
    if (
      !this.config.readDemo?.restricted &&
      (typeof authorization !== 'string' ||
        !/^Bearer [^\s]+$/i.test(authorization))
    )
      throw new Error();
    const url = new URL(
      individual
        ? '/api/v1/precios/skus/' + encodeURIComponent(skus[0])
        : '/api/v1/precios',
      this.config.pricingOrigin,
    );
    url.search = new URLSearchParams({
      at,
    }).toString();
    if (!individual) url.searchParams.set('skus', skus.join(','));
    if (canal !== undefined) url.searchParams.set('canal', canal);
    const response = await fetch(url, {
      headers: {
        ...(authorization ? { authorization } : {}),
        'X-Correlation-Id': correlation,
      },
      redirect: 'error',
      signal,
    });
    if (
      response.status !== 200 ||
      response.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      throw new Error();
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) throw new Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const raw: unknown = individual
      ? { items: [JSON.parse(text)] }
      : JSON.parse(text);
    const parsed = parseDecimalJson(text);
    const body = individual ? { items: [parsed] } : parsed;
    if (
      !record(body) ||
      !Array.isArray(body.items) ||
      !record(raw) ||
      !Array.isArray(raw.items) ||
      body.items.length > skus.length
    )
      throw new Error();
    const requested = new Set(skus),
      seen = new Set<string>();
    const rawItems = raw.items;
    return body.items.map((row: unknown, index: number) => {
      const original: unknown = rawItems[index];
      if (
        !record(original) ||
        typeof original.precio_regular !== 'number' ||
        !Number.isFinite(original.precio_regular) ||
        typeof original.price_version !== 'number' ||
        !Number.isInteger(original.price_version) ||
        original.price_version < 0 ||
        !record(row) ||
        typeof row.sku !== 'string' ||
        !requested.has(row.sku) ||
        seen.has(row.sku) ||
        typeof row.precio_regular !== 'string' ||
        compareDecimal(row.precio_regular, 0) <= 0 ||
        typeof row.currency !== 'string' ||
        !/^[A-Z]{3}$/.test(row.currency) ||
        (row.channel_id !== null && row.channel_id !== canal) ||
        typeof row.price_version !== 'string' ||
        typeof row.vigencia_id !== 'string' ||
        !row.vigencia_id ||
        typeof row.origen !== 'string' ||
        !['PRODUCTO', 'SKU_OVERRIDE'].includes(String(row.origen)) ||
        instant(row.valid_from) > Date.parse(at) ||
        (row.valid_until !== null &&
          row.valid_until !== undefined &&
          instant(row.valid_until) <= Date.parse(at))
      )
        throw new Error();
      if (
        row.precio_oferta !== null &&
        row.precio_oferta !== undefined &&
        (typeof original.precio_oferta !== 'number' ||
          !Number.isFinite(original.precio_oferta) ||
          typeof row.precio_oferta !== 'string' ||
          compareDecimal(row.precio_oferta, 0) <= 0 ||
          compareDecimal(row.precio_oferta, row.precio_regular) >= 0)
      )
        throw new Error();
      seen.add(row.sku);
      return {
        sku: row.sku,
        effective: (row.precio_oferta ?? row.precio_regular) as string,
        currency: row.currency,
      };
    });
  }

  async matchingProducts(
    candidates: readonly PriceCandidate[],
    query: ProductQuery,
    correlationId?: string,
  ): Promise<string[]> {
    try {
      if (!candidates.length) return [];
      const skus = [...new Set(candidates.map((c) => c.sku))];
      const csvSkus = skus.filter((sku) => !sku.includes(','));
      const batches: string[][] = [];
      for (let start = 0; start < csvSkus.length; start += 100)
        batches.push(csvSkus.slice(start, start + 100));
      batches.push(
        ...skus.filter((sku) => sku.includes(',')).map((sku) => [sku]),
      );
      const owners = new Map<string, string>();
      for (const row of candidates) {
        if (owners.has(row.sku) && owners.get(row.sku) !== row.productId)
          throw new Error();
        owners.set(row.sku, row.productId);
      }
      const at = new Date().toISOString(),
        correlation = correlationId ?? randomUUID();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Pricing deadline'));
        }, 5000);
      });
      const matches = new Set<string>();
      let cursor = 0;
      try {
        const worker = async () => {
          while (cursor < batches.length) {
            const batch = batches[cursor++];
            const rows = await this.batch(
              batch,
              query.canal,
              at,
              correlation,
              controller.signal,
            );
            for (const row of rows)
              if (
                row.currency === 'PEN' &&
                (query.precioMin === undefined ||
                  compareDecimal(row.effective, query.precioMin) >= 0) &&
                (query.precioMax === undefined ||
                  compareDecimal(row.effective, query.precioMax) <= 0)
              )
                matches.add(owners.get(row.sku)!);
          }
        };
        await Promise.race([
          deadline,
          Promise.all(
            Array.from({ length: Math.min(3, batches.length) }, worker),
          ),
        ]);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
      return [...matches];
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}
