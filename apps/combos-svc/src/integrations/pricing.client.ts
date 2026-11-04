import { FetchLike, IntegrationFailure } from './catalog-sku-context.client.js';

export interface ResolvedSkuPrice {
  sku: string;
  precio_regular: string;
  precio_publico: string;
  currency: string;
  channel_id: string | null;
}
interface PriceWire {
  sku: string;
  precio_regular: number | string;
  precio_oferta?: number | string | null;
  currency: string;
  channel_id: string | null;
  valid_from: string;
  valid_until?: string | null;
  price_version: number;
  vigencia_id: string;
  origen: 'PRODUCTO' | 'SKU_OVERRIDE';
}

function cents(value: number | string): bigint {
  const text = String(value);
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(text))
    throw new IntegrationFailure('PRICING', 'INVALID_PRICE');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
}
function amount(value: bigint): string {
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

export class PricingClient {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceBearer: () => string | undefined,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  async getPrices(
    skus: string[],
    at: string,
    channel: string | undefined,
    correlationId: string,
  ): Promise<ResolvedSkuPrice[]> {
    const bearer = this.serviceBearer();
    if (!bearer) throw new IntegrationFailure('PRICING', 'AUTH_NOT_CONFIGURED');
    const results: ResolvedSkuPrice[] = [];
    const groups: string[][] = [];
    const batchable = skus.filter((sku) => !sku.includes(','));
    if (batchable.length) groups.push(batchable);
    for (const sku of skus.filter((item) => item.includes(',')))
      groups.push([sku]);
    for (const group of groups) {
      const batch = group.length > 1 || !group[0]!.includes(',');
      const url = batch
        ? new URL('/api/v1/precios', this.baseUrl)
        : new URL(
            `/api/v1/precios/skus/${encodeURIComponent(group[0]!)}`,
            this.baseUrl,
          );
      if (batch) url.searchParams.set('skus', group.join(','));
      url.searchParams.set('at', at);
      if (channel) url.searchParams.set('canal', channel);
      let response: Response;
      try {
        response = await this.fetcher(url, {
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${bearer}`,
            'x-correlation-id': correlationId,
          },
          signal: AbortSignal.timeout(5000),
        });
      } catch (error) {
        throw new IntegrationFailure(
          'PRICING',
          error instanceof Error && error.name === 'TimeoutError'
            ? 'TIMEOUT'
            : 'NETWORK_FAILURE',
        );
      }
      if (response.status === 401 || response.status === 403)
        throw new IntegrationFailure(
          'PRICING',
          'SERVICE_AUTH_REJECTED',
          response.status,
        );
      if (!response.ok)
        throw new IntegrationFailure(
          'PRICING',
          response.status === 503 ? 'UNAVAILABLE' : 'UPSTREAM_FAILURE',
          response.status,
        );
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new IntegrationFailure('PRICING', 'INVALID_RESPONSE');
      }
      const rows =
        payload && typeof payload === 'object' && 'items' in payload
          ? (payload as { items: unknown }).items
          : [payload];
      if (!Array.isArray(rows) || rows.length !== group.length)
        throw new IntegrationFailure('PRICING', 'PRICE_MISSING');
      for (const row of rows) {
        if (!row || typeof row !== 'object')
          throw new IntegrationFailure('PRICING', 'INVALID_RESPONSE');
        const p = row as PriceWire;
        if (
          typeof p.sku !== 'string' ||
          !group.includes(p.sku) ||
          typeof p.currency !== 'string' ||
          !p.currency ||
          !(p.channel_id === null || typeof p.channel_id === 'string') ||
          typeof p.valid_from !== 'string' ||
          (p.valid_until !== undefined &&
            p.valid_until !== null &&
            typeof p.valid_until !== 'string') ||
          typeof p.price_version !== 'number' ||
          !Number.isInteger(p.price_version) ||
          p.price_version < 0 ||
          typeof p.vigencia_id !== 'string' ||
          !p.vigencia_id ||
          !['PRODUCTO', 'SKU_OVERRIDE'].includes(p.origen)
        )
          throw new IntegrationFailure('PRICING', 'INVALID_RESPONSE');
        const start = Date.parse(p.valid_from);
        const end =
          p.valid_until == null ? Infinity : Date.parse(p.valid_until);
        const instant = Date.parse(at);
        if (
          !Number.isFinite(start) ||
          !(Number.isFinite(end) || end === Infinity) ||
          !Number.isFinite(instant) ||
          start > instant ||
          instant >= end
        )
          throw new IntegrationFailure('PRICING', 'PRICE_NOT_CURRENT');
        const regular = cents(p.precio_regular);
        const publicPrice =
          p.precio_oferta == null ? regular : cents(p.precio_oferta);
        results.push({
          sku: p.sku,
          precio_regular: amount(regular),
          precio_publico: amount(publicPrice),
          currency: p.currency,
          channel_id: p.channel_id,
        });
      }
    }
    if (
      results.length !== skus.length ||
      new Set(results.map((p) => p.sku)).size !== skus.length ||
      skus.some((sku) => !results.some((p) => p.sku === sku))
    )
      throw new IntegrationFailure('PRICING', 'PRICE_MISSING');
    const first = results[0]!;
    if (
      results.some(
        (p) =>
          p.currency !== first.currency || p.channel_id !== first.channel_id,
      )
    )
      throw new IntegrationFailure('PRICING', 'CONTEXT_MISMATCH');
    return results;
  }
}

export function sumPrice(
  prices: ResolvedSkuPrice[],
  quantities: ReadonlyMap<string, number>,
  field: 'precio_regular' | 'precio_publico',
): bigint {
  return prices.reduce(
    (sum, price) =>
      sum + cents(price[field]) * BigInt(quantities.get(price.sku) ?? 0),
    0n,
  );
}
