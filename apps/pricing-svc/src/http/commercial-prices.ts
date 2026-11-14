import { Inject, Injectable, Optional } from '@nestjs/common';
import { resolvePrice } from '../domain/resolve-price.js';
import { PriceRuleError } from '../domain/price.js';
import { PricingRepository } from '../persistence/pricing.repository.js';
import { PricingHttpError } from './pricing-http.error.js';
import { wireMoney, wireVersion } from './pricing-reads.js';

export const PRICING_CATALOG_CONTEXT = Symbol('PRICING_CATALOG_CONTEXT');
// Puerto interno: requiere un provider autoritativo; no define otro endpoint de Catálogo.
export interface PricingCatalogContext {
  resolve(
    sku: string,
    correlationId?: string,
  ): Promise<{
    sku: string;
    productId: string;
    isVariant: boolean;
    active: boolean;
    eligible: boolean;
  } | null>;
}
export const channels = ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'] as const;
const MAX_CATALOG_CONTEXT_CONCURRENCY = 8;
type CommercialCandidates = Awaited<
  ReturnType<PricingRepository['readCandidates']>
>;
export function parseCommercialQuery(
  query: Record<string, unknown>,
  batch = false,
) {
  if (
    Object.keys(query).some(
      (k) => !['canal', 'at', ...(batch ? ['skus'] : [])].includes(k),
    )
  )
    throw new PricingHttpError(400, 'VALIDACION');
  if (
    query.canal !== undefined &&
    (typeof query.canal !== 'string' ||
      !channels.includes(query.canal as (typeof channels)[number]))
  )
    throw new PricingHttpError(400, 'VALIDACION');
  let at = new Date();
  if (query.at !== undefined) {
    const value = query.at;
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        value,
      ) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) !==
        value.slice(0, 10)
    )
      throw new PricingHttpError(400, 'VALIDACION');
    at = new Date(value);
  }
  const skus =
    batch && typeof query.skus === 'string' ? query.skus.split(',') : [];
  if (
    batch &&
    (!skus.length || skus.length > 100 || skus.some((sku) => !sku.trim()))
  )
    throw new PricingHttpError(400, 'VALIDACION');
  return {
    channel: query.canal as (typeof channels)[number] | undefined,
    at,
    skus,
    historical: query.at !== undefined,
  };
}
@Injectable()
export class CommercialPrices {
  constructor(
    @Inject(PricingRepository) private readonly repository: PricingRepository,
    @Optional()
    @Inject(PRICING_CATALOG_CONTEXT)
    private readonly catalog?: PricingCatalogContext,
  ) {}

  private async resolveContext(
    sku: string,
    correlationId?: string,
  ): Promise<Awaited<ReturnType<PricingCatalogContext['resolve']>>> {
    if (!this.catalog)
      throw new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    let context: Awaited<ReturnType<PricingCatalogContext['resolve']>>;
    try {
      context = await this.catalog.resolve(sku, correlationId);
    } catch {
      throw new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    }
    if (context === null) return null;
    if (
      !context ||
      context.sku !== sku ||
      typeof context.productId !== 'string' ||
      !context.productId.trim() ||
      typeof context.isVariant !== 'boolean' ||
      typeof context.active !== 'boolean' ||
      typeof context.eligible !== 'boolean'
    )
      throw new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    return context;
  }

  private price(
    sku: string,
    context: NonNullable<Awaited<ReturnType<PricingCatalogContext['resolve']>>>,
    definitions: CommercialCandidates,
    channel: (typeof channels)[number] | undefined,
    at: Date,
    historical: boolean,
  ) {
    const channelId = channel ?? null;
    const resolved = resolvePrice(definitions, context, channelId, at);
    let effectiveChannel: (typeof channels)[number] | null = null;
    if (resolved.definition.channelId !== null) {
      if (channel === undefined || resolved.definition.channelId !== channelId)
        throw new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE');
      effectiveChannel = channel;
    }
    const validity = definitions
      .flatMap((definition) => definition.validities)
      .find((candidate) => candidate === resolved.validity)!;
    return {
      sku,
      precio_regular: wireMoney(validity.precioRegular),
      precio_oferta:
        validity.precioOferta === null
          ? null
          : wireMoney(validity.precioOferta),
      currency: validity.currency,
      channel_id: effectiveChannel,
      valid_from: validity.validFrom.toISOString(),
      valid_until: validity.validUntil?.toISOString() ?? null,
      price_version: wireVersion(
        historical ? validity.priceVersion : resolved.definition.priceVersion,
      ),
      vigencia_id: validity.id,
      origen: resolved.origen,
    };
  }

  async sku(
    sku: string,
    channel: (typeof channels)[number] | undefined,
    at: Date,
    historical = false,
    correlationId?: string,
  ) {
    if (!sku.trim()) throw new PricingHttpError(400, 'VALIDACION');
    const context = await this.resolveContext(sku, correlationId);
    if (context === null)
      throw new PricingHttpError(404, 'PRECIO_NO_ENCONTRADO');
    if (!context.active || !context.eligible)
      throw new PricingHttpError(404, 'PRECIO_NO_ENCONTRADO');
    const channelId = channel ?? null;
    const definitions = await this.repository.readCandidates(
      context.productId,
      sku,
      channelId,
      at,
    );
    return this.price(sku, context, definitions, channel, at, historical);
  }
  async batch(
    skus: string[],
    channel: (typeof channels)[number] | undefined,
    at: Date,
    historical = false,
    correlationId?: string,
    // Interno para calibración; no forma parte de los parámetros HTTP.
    contextConcurrency = MAX_CATALOG_CONTEXT_CONCURRENCY,
  ) {
    if (!skus.length) return { items: [] };
    if (skus.some((sku) => !sku.trim()))
      throw new PricingHttpError(400, 'VALIDACION');
    if (!this.catalog)
      throw new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    const concurrency =
      Number.isSafeInteger(contextConcurrency) && contextConcurrency > 0
        ? Math.min(contextConcurrency, 16)
        : MAX_CATALOG_CONTEXT_CONCURRENCY;
    const uniqueSkus = [...new Set(skus)];
    const contexts = new Map<
      string,
      Awaited<ReturnType<PricingCatalogContext['resolve']>>
    >();
    let cursor = 0;
    let failed = false;
    let failure: unknown;
    const worker = async () => {
      while (!failed) {
        const index = cursor++;
        if (index >= uniqueSkus.length) return;
        const sku = uniqueSkus[index]!;
        try {
          contexts.set(sku, await this.resolveContext(sku, correlationId));
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.min(concurrency, uniqueSkus.length),
        },
        worker,
      ),
    );
    if (failed) throw failure;

    const eligibleContexts = uniqueSkus.flatMap((sku) => {
      const context = contexts.get(sku);
      return context && context.active && context.eligible
        ? [{ sku, productId: context.productId, context }]
        : [];
    });
    const candidates = await this.repository.readCandidatesBatch(
      eligibleContexts,
      channel ?? null,
      at,
    );
    const definitionsBySku = new Map(
      candidates.map(({ sku, definitions }) => [sku, definitions]),
    );
    const items: Awaited<ReturnType<CommercialPrices['sku']>>[] = [];
    for (const sku of skus) {
      const context = contexts.get(sku);
      if (!context || !context.active || !context.eligible) continue;
      try {
        items.push(
          this.price(
            sku,
            context,
            definitionsBySku.get(sku) ?? [],
            channel,
            at,
            historical,
          ),
        );
      } catch (error) {
        // La consulta no tiene errores por fila: solo omite ausencias contractuales.
        if (
          !(
            error instanceof PricingHttpError &&
            error.status === 404 &&
            error.code === 'PRECIO_NO_ENCONTRADO'
          ) &&
          !(
            error instanceof PriceRuleError &&
            error.code === 'PRECIO_NO_ENCONTRADO'
          )
        )
          throw error;
      }
    }
    return { items };
  }
}
