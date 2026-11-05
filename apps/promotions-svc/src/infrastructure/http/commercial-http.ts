import {
  InternalHttpReader,
  type InternalHttpOptions,
  type InternalOperation,
} from './internal-http.js';
import {
  CommercialDependencyError,
  CommercialInputError,
  type BasketRequest,
  type CommercialContext,
  type CommercialReadContext,
} from '../../domain/commercial-context.js';
import { Decimal } from '../../domain/decimal.js';
import { validInstant } from '../../domain/date-time.js';
import { effectiveAt } from '../../domain/promotion-rules.js';
import type { RecommendationCandidate } from '../../domain/promotion-rules.js';
import { withDeadline } from '../resilience/deadline.js';

export type CommercialHttpOptions = InternalHttpOptions;

/** Real outbound client; configuration selects explicit upstreams and access mode. */
export class HttpCommercialContext implements CommercialContext {
  private readonly reader: InternalHttpReader;
  constructor(options: CommercialHttpOptions) {
    this.reader = new InternalHttpReader(options);
  }
  private read(
    operation: InternalOperation,
    path: string,
    signal: AbortSignal,
    missing = false,
    correlationId?: string,
  ) {
    return this.reader.read(operation, path, signal, missing, correlationId);
  }
  private async bounded<T>(
    operation: string,
    signal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    try {
      signal?.throwIfAborted();
      return await withDeadline(
        (timeout) =>
          work(signal ? AbortSignal.any([signal, timeout]) : timeout),
        2500,
      );
    } catch (error) {
      if (error instanceof CommercialInputError) throw error;
      throw new CommercialDependencyError(
        operation,
        'Catálogo/Pricing/Inventario + integración G6/G7',
        'identidad propia autorizada y respuesta contractual completa y coherente; sin fallback ni reintento',
      );
    }
  }

  private async product(
    id: string,
    channel: string,
    signal: AbortSignal,
    correlationId?: string,
  ) {
    const raw = await this.read(
      'obtenerProducto',
      '/productos/' +
        encodeURIComponent(id) +
        '?canal=' +
        encodeURIComponent(channel),
      signal,
      true,
      correlationId,
    );
    if (raw === null) return null; // Not commercially visible, never an authoritative admin absence.
    const row = object(raw);
    if (text(row.product_id) !== id || typeof row.tiene_variantes !== 'boolean')
      throw new Error('PRODUCT_IDENTITY_MISMATCH');
    text(row.name);
    text(row.slug);
    text(row.tipo_producto_id);
    text(row.marca_id);
    const categoryId = text(row.categoria_id);
    const brand = object(row.marca);
    if (text(brand.marca_id) !== row.marca_id)
      throw new Error('BRAND_IDENTITY_MISMATCH');
    text(brand.name);
    const variants = array(row.variants).map((value) => {
      const variant = object(value);
      return { id: text(variant.variant_id), sku: text(variant.sku) };
    });
    if (
      new Set(variants.map((v) => v.sku)).size !== variants.length ||
      new Set(variants.map((v) => v.id)).size !== variants.length
    )
      throw new Error('AMBIGUOUS_SKU');
    const skus = row.tiene_variantes
      ? variants.map((v) => v.sku)
      : [text(row.sku_base)];
    if (!row.tiene_variantes && variants.length)
      throw new Error('AMBIGUOUS_SIMPLE_PRODUCT');
    return { categoryId, skus, hasVariants: row.tiene_variantes };
  }

  private async price(
    sku: string,
    channel: string,
    at: string,
    signal: AbortSignal,
    correlationId?: string,
  ) {
    const raw = await this.read(
      'obtenerPrecioSku',
      '/precios/skus/' +
        encodeURIComponent(sku) +
        '?canal=' +
        encodeURIComponent(channel) +
        '&at=' +
        encodeURIComponent(at),
      signal,
      true,
      correlationId,
    );
    if (raw === null) return null;
    const row = object(raw);
    const regular = finitePositive(row.precio_regular);
    const offer =
      row.precio_oferta == null ? null : finitePositive(row.precio_oferta);
    const currency = text(row.currency);
    const from = text(row.valid_from);
    const until =
      row.valid_until === undefined || row.valid_until === null
        ? null
        : text(row.valid_until);
    if (
      text(row.sku) !== sku ||
      (row.channel_id !== null && row.channel_id !== channel) ||
      !validInstant(from) ||
      (until !== null && !validInstant(until)) ||
      !effectiveAt(from, until, at) ||
      !Number.isSafeInteger(row.price_version) ||
      Number(row.price_version) < 0 ||
      !['PRODUCTO', 'SKU_OVERRIDE'].includes(String(row.origen)) ||
      (offer !== null && Decimal.from(offer).compare(Decimal.from(regular)) > 0)
    )
      throw new Error('INVALID_PRICE_CONTEXT');
    text(row.vigencia_id);
    return { regular, offer, currency };
  }

  basket(
    request: BasketRequest,
    at: string,
    signal?: AbortSignal,
    context?: CommercialReadContext,
  ) {
    return this.bounded(
      'evaluarPromociones/validarCupon',
      signal,
      async (bounded) => {
        channel(request.channel_id);
        instant(at);
        if (
          !request.lines.length ||
          request.lines.some(
            (l) =>
              !l.sku || !Number.isSafeInteger(l.quantity) || l.quantity <= 0,
          )
        )
          throw new Error('CANONICAL_SKU_PRODUCT_RESOLVER_REQUIRED');
        const products = new Map<
          string,
          Awaited<ReturnType<HttpCommercialContext['product']>>
        >();
        const prices = new Map<
          string,
          Awaited<ReturnType<HttpCommercialContext['price']>>
        >();
        const lines = [];
        const contexts = new Map<string, string>();
        for (const line of request.lines) {
          let id = line.product_id;
          if (!id) {
            if (!contexts.has(line.sku)) {
              const skuContext = object(
                await this.read(
                  'obtenerContextoSku',
                  '/productos/skus/' +
                    encodeURIComponent(line.sku) +
                    '/contexto',
                  bounded,
                  false,
                  context?.correlationId,
                ),
              );
              if (
                skuContext.sku !== line.sku ||
                typeof skuContext.isVariant !== 'boolean' ||
                typeof skuContext.active !== 'boolean' ||
                typeof skuContext.eligible !== 'boolean' ||
                !skuContext.active ||
                !skuContext.eligible
              )
                throw new Error('INVALID_SKU_CONTEXT');
              contexts.set(line.sku, text(skuContext.productId));
            }
            id = contexts.get(line.sku)!;
          }
          if (!products.has(id))
            products.set(
              id,
              await this.product(
                id,
                request.channel_id,
                bounded,
                context?.correlationId,
              ),
            );
          const product = products.get(id);
          if (!product) throw new Error('SKU_NOT_COMMERCIALLY_VISIBLE');
          if (!product.skus.includes(line.sku))
            throw new CommercialInputError();
          if (!prices.has(line.sku)) {
            const price = await this.price(
              line.sku,
              request.channel_id,
              at,
              bounded,
              context?.correlationId,
            );
            if (!price) throw new Error('BASKET_PRICE_UNAVAILABLE');
            prices.set(line.sku, price);
          }
          lines.push({
            sku: line.sku,
            productId: id,
            quantity: line.quantity,
            ...prices.get(line.sku)!,
            active: true,
            channelEligible: true,
          });
        }
        if (new Set(lines.map((l) => l.currency)).size !== 1)
          throw new Error('MIXED_CURRENCIES');
        return { lines };
      },
    );
  }

  recommendationOrigin(
    productId: string,
    channelId: string,
    signal?: AbortSignal,
    context?: CommercialReadContext,
  ) {
    return this.bounded(
      'obtenerRecomendaciones/origen',
      signal,
      async (bounded) => {
        channel(channelId);
        text(productId);
        const p = await this.product(
          productId,
          channelId,
          bounded,
          context?.correlationId,
        );
        return p
          ? { active: true, channelEligible: true, categoryId: p.categoryId }
          : { active: false, channelEligible: false, categoryId: '' };
      },
    );
  }

  recommendationProducts(
    ids: readonly string[],
    channelId: string,
    signal?: AbortSignal,
    context?: CommercialReadContext,
  ) {
    return this.bounded(
      'obtenerRecomendaciones/productos',
      signal,
      async (bounded) => {
        channel(channelId);
        const result = new Map<
          string,
          Pick<
            RecommendationCandidate,
            'active' | 'channelEligible' | 'availability' | 'currentPrice'
          > | null
        >();
        const products = new Map<string, string[]>();
        const at = context?.at ?? new Date().toISOString();
        instant(at);
        const uniqueIds = [...new Set(ids)];
        uniqueIds.forEach(text);
        const details = await limitedReads(uniqueIds, bounded, (id, signal) =>
          this.product(id, channelId, signal, context?.correlationId),
        );
        for (const [index, id] of uniqueIds.entries()) {
          const p = details[index];
          if (!p) {
            result.set(id, null);
            continue;
          }
          if (p.skus.some((sku) => !sku || sku.includes(',')))
            throw new Error('UNREPRESENTABLE_SKU_LIST');
          products.set(id, p.skus);
        }
        const uniqueSkus = [...new Set([...products.values()].flat())];
        const availability = new Map<
          string,
          RecommendationCandidate['availability'] | 'INDETERMINADO'
        >();
        for (let offset = 0; offset < uniqueSkus.length; offset += 100) {
          const batch = uniqueSkus.slice(offset, offset + 100);
          const row = object(
            await this.read(
              'consultarDisponibilidadComercial',
              '/inventario/disponibilidad/comercial?skus=' +
                encodeURIComponent(batch.join(',')) +
                '&canal=' +
                encodeURIComponent(channelId),
              bounded,
              false,
              context?.correlationId,
            ),
          );
          for (const value of array(row.items)) {
            const item = object(value),
              sku = text(item.sku);
            if (
              !batch.includes(sku) ||
              availability.has(sku) ||
              ![
                'DISPONIBLE',
                'STOCK_BAJO',
                'AGOTADO',
                'INDETERMINADO',
              ].includes(String(item.status))
            )
              throw new Error('UNDETERMINED_OR_INVALID_AVAILABILITY');
            availability.set(
              sku,
              item.status as
                RecommendationCandidate['availability'] | 'INDETERMINADO',
            );
          }
        }
        const positiveSkus = uniqueSkus.filter((sku) =>
          ['DISPONIBLE', 'STOCK_BAJO'].includes(availability.get(sku) ?? ''),
        );
        const priceRows = await limitedReads(
          positiveSkus,
          bounded,
          (sku, signal) =>
            this.price(sku, channelId, at, signal, context?.correlationId),
        );
        const prices = new Map(
          positiveSkus.map((sku, index) => [sku, priceRows[index]]),
        );
        let currency: string | undefined;
        for (const [id, skus] of products) {
          const positive = skus.filter((sku) =>
            ['DISPONIBLE', 'STOCK_BAJO'].includes(availability.get(sku) ?? ''),
          );
          let minimum: string | undefined;
          for (const sku of [...positive].sort()) {
            const price = prices.get(sku);
            if (!price) continue;
            if (currency && price.currency !== currency)
              throw new Error('MIXED_CURRENCIES');
            currency = price.currency;
            const effective = price.offer ?? price.regular;
            if (
              minimum === undefined ||
              Decimal.from(effective).compare(Decimal.from(minimum)) < 0
            )
              minimum = effective;
          }
          // Null is an explicit product exclusion, never a fabricated stock state.
          if (minimum === undefined) {
            result.set(id, null);
            continue;
          }
          result.set(id, {
            active: true,
            channelEligible: true,
            availability: positive.some(
              (sku) => availability.get(sku) === 'DISPONIBLE',
            )
              ? 'DISPONIBLE'
              : 'STOCK_BAJO',
            currentPrice: Number(minimum),
          });
        }
        return result;
      },
    );
  }
}

// Four in-flight reads per recommendation call; preserve input order and stop
// queued/in-flight work on failure. The caller's total deadline is unchanged.
async function limitedReads<T, R>(
  items: readonly T[],
  parent: AbortSignal,
  read: (item: T, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const results: R[] = [];
  let next = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(4, items.length) }, async () => {
        while (next < items.length) {
          signal.throwIfAborted();
          const index = next++;
          results[index] = await read(items[index], signal);
        }
      }),
    );
    return results;
  } catch (error) {
    controller.abort();
    throw error;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_COMMERCIAL_DTO');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('INVALID_COMMERCIAL_DTO');
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('INVALID_COMMERCIAL_DTO');
  return value;
}
function finitePositive(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error('INVALID_PRICE');
  return String(value);
}
function channel(value: string) {
  if (!['MARKETPLACE', 'CHATBOT', 'RETAIL'].includes(value))
    throw new Error('UNSUPPORTED_COMMERCIAL_CHANNEL');
}
function instant(value: string) {
  if (!validInstant(value)) throw new Error('INVALID_COMMERCIAL_INSTANT');
}
