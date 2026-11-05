import {
  BearerProvider,
  FetchLike,
  IntegrationFailure,
} from './catalog-sku-context.client.js';

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
function validIsoDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = Number(match[6]);
  const offsetHours = Number(match[8] ?? 0);
  const offsetMinutes = Number(match[9] ?? 0);
  const monthDays = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= monthDays[month - 1]! &&
    hours <= 23 &&
    minutes <= 59 &&
    seconds <= 59 &&
    (match[7] === 'Z' ||
      (offsetHours <= 14 &&
        offsetMinutes <= 59 &&
        (offsetHours < 14 || offsetMinutes === 0))) &&
    Number.isFinite(Date.parse(value))
  );
}

export class PricingClient {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceBearer: BearerProvider,
    private readonly fetcher: FetchLike = fetch,
    private readonly invalidateBearer?: () => void,
    private readonly totalDeadlineMs = 15000,
  ) {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new IntegrationFailure('PRICING', 'INVALID_CONFIGURATION');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      (fetcher === fetch &&
        url.protocol === 'http:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
        !url.hostname.endsWith('-svc') &&
        !url.hostname.endsWith('.svc'))
    )
      throw new IntegrationFailure('PRICING', 'INVALID_CONFIGURATION');
  }

  async getPrices(
    skus: string[],
    at: string,
    channel: string | undefined,
    correlationId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ResolvedSkuPrice[]> {
    if (!validIsoDateTime(at))
      throw new IntegrationFailure('PRICING', 'INVALID_REQUEST');
    if (
      skus.length === 0 ||
      new Set(skus).size !== skus.length ||
      skus.some((sku) => typeof sku !== 'string' || !sku.trim())
    )
      throw new IntegrationFailure('PRICING', 'INVALID_REQUEST');
    if (
      channel !== undefined &&
      !['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'].includes(channel)
    )
      throw new IntegrationFailure('PRICING', 'INVALID_REQUEST');
    const totalSignal = AbortSignal.timeout(this.totalDeadlineMs);
    const operationSignal = options.signal
      ? AbortSignal.any([totalSignal, options.signal])
      : totalSignal;
    let bearer = await this.serviceBearer(operationSignal);
    if (!bearer) throw new IntegrationFailure('PRICING', 'AUTH_NOT_CONFIGURED');
    const results: ResolvedSkuPrice[] = [];
    const groups: string[][] = [];
    const batchable = skus.filter((sku) => !sku.includes(','));
    for (let index = 0; index < batchable.length; index += 100)
      groups.push(batchable.slice(index, index + 100));
    for (const sku of skus.filter((item) => item.includes(',')))
      groups.push([sku]);
    for (const group of groups) {
      operationSignal.throwIfAborted();
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
      for (let attempt = 0; ; attempt += 1) {
        try {
          response = await this.fetcher(url, {
            redirect: 'error',
            headers: {
              accept: 'application/json',
              authorization: `Bearer ${bearer}`,
              'x-correlation-id': correlationId,
            },
            signal: AbortSignal.any([
              operationSignal,
              AbortSignal.timeout(5000),
            ]),
          });
        } catch (error) {
          throw new IntegrationFailure(
            'PRICING',
            error instanceof Error && error.name === 'TimeoutError'
              ? 'TIMEOUT'
              : 'NETWORK_FAILURE',
          );
        }
        if (response.status !== 401 || attempt > 0 || !this.invalidateBearer)
          break;
        await response.body?.cancel();
        this.invalidateBearer();
        bearer = await this.serviceBearer(operationSignal);
        if (!bearer)
          throw new IntegrationFailure('PRICING', 'AUTH_NOT_CONFIGURED');
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new IntegrationFailure(
          'PRICING',
          'SERVICE_AUTH_REJECTED',
          response.status,
        );
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new IntegrationFailure(
          'PRICING',
          response.status === 503 ? 'UNAVAILABLE' : 'UPSTREAM_FAILURE',
          response.status,
        );
      }
      let payload: unknown;
      try {
        const contentType = response.headers
          .get('content-type')
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase();
        if (contentType !== 'application/json') throw new Error();
        const reader = response.body?.getReader();
        if (!reader) throw new Error();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 1024 * 1024) throw new Error();
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
        }
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      } catch {
        throw new IntegrationFailure('PRICING', 'INVALID_RESPONSE');
      }
      const rows =
        payload && typeof payload === 'object' && 'items' in payload
          ? (payload as { items: unknown }).items
          : [payload];
      if (!Array.isArray(rows) || rows.length !== group.length)
        throw new IntegrationFailure('PRICING', 'PRICE_MISSING');
      const groupSkus = new Set<string>();
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
          !validIsoDateTime(p.valid_from) ||
          (p.valid_until !== undefined &&
            p.valid_until !== null &&
            !validIsoDateTime(p.valid_until)) ||
          typeof p.price_version !== 'number' ||
          !Number.isSafeInteger(p.price_version) ||
          p.price_version < 0 ||
          typeof p.vigencia_id !== 'string' ||
          !p.vigencia_id ||
          !['PRODUCTO', 'SKU_OVERRIDE'].includes(p.origen)
        )
          throw new IntegrationFailure('PRICING', 'INVALID_RESPONSE');
        if (groupSkus.has(p.sku))
          throw new IntegrationFailure('PRICING', 'DUPLICATE_PRICE');
        groupSkus.add(p.sku);
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
        if (regular <= 0n || publicPrice <= 0n)
          throw new IntegrationFailure('PRICING', 'INVALID_PRICE');
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
