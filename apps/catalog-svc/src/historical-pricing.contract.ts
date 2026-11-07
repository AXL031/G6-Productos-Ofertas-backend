import { envelope, type CatalogEnvelope } from './catalog-messages.js';
import type { HistoricalPricingContract } from './historical-recovery.service.js';

/** ISO currency identifiers supplied explicitly by the human, never a price source. */
export function isHistoricalCurrency(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Z]{3}$/.test(value) &&
    Intl.supportedValuesOf('currency').includes(value)
  );
}

/** CONTRATO_CANDIDATO: Pricing #205 @7398e6f, not yet published in Docs. */
export class CandidateHistoricalPricingContract implements HistoricalPricingContract {
  command(
    context: Parameters<HistoricalPricingContract['command']>[0],
  ): CatalogEnvelope {
    if (!isHistoricalCurrency(context.currency))
      throw new Error('Invalid historical currency');
    return envelope(
      'pricing.product.initialization.requested',
      {
        modalidad: 'RECUPERACION_HISTORICA',
        product_id: context.productId,
        sku_base: context.skuBase,
        moneda: context.currency,
        channel_id: null,
        motivo_cambio: 'ALTA_PRODUCTO',
      },
      context.correlationId,
      context.operationId,
      context.requestId,
    );
  }
}

/** Until publication/operational approval, candidate activation is test-only. */
export function readHistoricalPricingContract(
  env: NodeJS.ProcessEnv = process.env,
): HistoricalPricingContract | null {
  const value = env.CATALOG_HISTORICAL_PRICING_CANDIDATE_ENABLED;
  if (value === undefined || value === 'false') return null;
  if (value !== 'true' || env.NODE_ENV !== 'test')
    throw new Error(
      'Historical Pricing candidate is restricted to isolated tests',
    );
  return new CandidateHistoricalPricingContract();
}
