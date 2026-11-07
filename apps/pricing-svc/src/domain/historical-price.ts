import {
  cents,
  PriceRuleError,
  validateTerms,
  type PriceValidity,
} from './price.js';

// El caller filtra elegibles en PostgreSQL con el corte persistido; no truncar límites a Date.
export function selectHistoricalValidity<T extends PriceValidity>(
  eligible: readonly T[],
  currency: string,
  expectedAmount: string | undefined,
): T | undefined {
  if (eligible.length !== 1) return undefined;
  const chosen = eligible[0];
  try {
    validateTerms(chosen);
    if (
      chosen.currency !== currency ||
      (expectedAmount !== undefined &&
        cents(chosen.precioRegular) !== cents(expectedAmount)) ||
      chosen.priceVersion < 1n ||
      chosen.priceVersion > BigInt(Number.MAX_SAFE_INTEGER)
    )
      return undefined;
    return chosen;
  } catch (error) {
    if (!(error instanceof PriceRuleError)) throw error;
    return undefined;
  }
}
