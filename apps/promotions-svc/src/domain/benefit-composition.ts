// Approved internal G6 policy v1, used by evaluateBasket after authoritative facts.
import { Decimal } from './decimal.js';
import type { CombinationPolicy } from '../infrastructure/persistence/repositories.js';

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

// Proportional allocations can repeat infinitely as decimals (e.g. 1/3).
// Fractions preserve the exact sum without inventing a currency rounding rule.
export class ExactAmount {
  private constructor(
    readonly numerator: bigint,
    readonly denominator: bigint,
  ) {}
  private static ratio(n: bigint, d: bigint): ExactAmount {
    if (d === 0n) throw new RangeError('Zero denominator');
    if (d < 0n) [n, d] = [-n, -d];
    const divisor = gcd(n, d);
    return new ExactAmount(n / divisor, d / divisor);
  }
  static from(value: string): ExactAmount {
    const decimal = Decimal.from(value);
    return ExactAmount.ratio(decimal.coefficient, 10n ** BigInt(decimal.scale));
  }
  add(other: ExactAmount): ExactAmount {
    return ExactAmount.ratio(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }
  subtract(other: ExactAmount): ExactAmount {
    return ExactAmount.ratio(
      this.numerator * other.denominator - other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }
  multiply(other: ExactAmount): ExactAmount {
    return ExactAmount.ratio(
      this.numerator * other.numerator,
      this.denominator * other.denominator,
    );
  }
  divide(other: ExactAmount): ExactAmount {
    return ExactAmount.ratio(
      this.numerator * other.denominator,
      this.denominator * other.numerator,
    );
  }
  compare(other: ExactAmount): number {
    const difference =
      this.numerator * other.denominator - other.numerator * this.denominator;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }
  min(other: ExactAmount): ExactAmount {
    return this.compare(other) <= 0 ? this : other;
  }
}

export interface ProposalLine {
  // Unique canonical line key, after resolving identities and quantities upstream.
  key: string;
  regularSubtotal: string;
  offerSubtotal: string | null;
}
export interface ProposalPromotion {
  id: string;
  priority: number;
  usesCoupon: boolean;
  type: 'PORCENTAJE' | 'MONTO_FIJO';
  value: string;
  lineKeys: readonly string[];
  policy: CombinationPolicy;
}
interface AppliedPromotion {
  id: string;
  priority: number;
  usesCoupon: boolean;
  discount: ExactAmount;
  allocations: ReadonlyMap<string, ExactAmount>;
}
export interface ProposalResult {
  original: ExactAmount;
  discount: ExactAmount;
  result: ExactAmount;
  pricingDiscount: ExactAmount;
  applied: readonly AppliedPromotion[];
  balances: ReadonlyMap<string, ExactAmount>;
  primaryPromotionId: string | null;
  couponPromotionId: string | null;
}
export class CompositionBudgetExceeded extends Error {
  constructor() {
    super('BENEFIT_COMPOSITION_BUDGET_EXCEEDED');
  }
}
export interface CompositionBudget {
  maxWork: number;
  milliseconds: number;
}
const zero = ExactAmount.from('0');
const hundred = ExactAmount.from('100');
const sum = (amounts: Iterable<ExactAmount>) =>
  [...amounts].reduce((a, b) => a.add(b), zero);
const textOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const promotionOrder = (
  a: Pick<ProposalPromotion, 'priority' | 'id'>,
  b: Pick<ProposalPromotion, 'priority' | 'id'>,
) => a.priority - b.priority || textOrder(a.id, b.id);

function compatible(a: ProposalPromotion, b: ProposalPromotion): boolean {
  if (a.usesCoupon && b.usesCoupon) return false;
  return (
    (b.usesCoupon ? a.policy.coupon : a.policy.automaticPromotion) &&
    (a.usesCoupon ? b.policy.coupon : b.policy.automaticPromotion)
  );
}
function compareResults(a: ProposalResult, b: ProposalResult): number {
  const amountOrCoupon =
    a.result.compare(b.result) ||
    Number(a.couponPromotionId !== null) - Number(b.couponPromotionId !== null);
  if (amountOrCoupon) return amountOrCoupon;
  // An offer-only alternative has no campaign priority. For equal nonempty
  // signatures, a shorter signature avoids gratuitous zero-value participants.
  if (!a.applied.length || !b.applied.length)
    return Number(!a.applied.length) - Number(!b.applied.length);
  for (let i = 0; i < Math.min(a.applied.length, b.applied.length); i++) {
    const order = promotionOrder(a.applied[i], b.applied[i]);
    if (order) return order;
  }
  return a.applied.length - b.applied.length;
}

/** Inputs are already eligible at the same channel/instant and have one currency.
 * Enumerates compatible subsets with bounded exact arithmetic. The caller owns
 * identity/eligibility, monetary projection and HTTP DTOs; prices stay authoritative.
 */
export function composeBenefits(
  lines: readonly ProposalLine[],
  promotions: readonly ProposalPromotion[],
  budget: CompositionBudget = { maxWork: 250000, milliseconds: 100 },
): ProposalResult {
  if (
    !Number.isSafeInteger(budget.maxWork) ||
    budget.maxWork < 1 ||
    budget.maxWork > 250000 ||
    !Number.isSafeInteger(budget.milliseconds) ||
    budget.milliseconds < 1 ||
    budget.milliseconds > 1000
  )
    throw new RangeError('Invalid composition budget');
  if (lines.length > 100 || promotions.length > 12)
    throw new CompositionBudgetExceeded();
  const started = performance.now();
  let work = 0;
  const spend = () => {
    if (
      ++work > budget.maxWork ||
      performance.now() - started >= budget.milliseconds
    )
      throw new CompositionBudgetExceeded();
  };
  const boundedAmount = (value: string) => {
    spend();
    if (value.length > 128) throw new RangeError('Amount input too long');
    return ExactAmount.from(value);
  };
  if (!lines.length || new Set(lines.map((l) => l.key)).size !== lines.length)
    throw new RangeError('Expected unique, nonempty basket lines');
  const regular = new Map<string, ExactAmount>();
  const offers = new Map<string, ExactAmount>();
  for (const line of lines) {
    const amount = boundedAmount(line.regularSubtotal);
    const offer = boundedAmount(line.offerSubtotal ?? line.regularSubtotal);
    if (
      !line.key ||
      line.key.length > 256 ||
      amount.compare(zero) < 0 ||
      offer.compare(zero) < 0 ||
      offer.compare(amount) > 0
    )
      throw new RangeError('Incoherent line prices');
    regular.set(line.key, amount);
    offers.set(line.key, offer);
  }
  if (new Set(promotions.map((p) => p.id)).size !== promotions.length)
    throw new RangeError('Duplicate promotion');
  for (const p of promotions) {
    const value = boundedAmount(p.value);
    if (
      !p.id ||
      p.id.length > 256 ||
      typeof p.usesCoupon !== 'boolean' ||
      !Number.isSafeInteger(p.priority) ||
      p.priority <= 0 ||
      value.compare(zero) <= 0 ||
      !['PORCENTAJE', 'MONTO_FIJO'].includes(p.type) ||
      (p.type === 'PORCENTAJE' && value.compare(hundred) > 0) ||
      !p.lineKeys.length ||
      p.lineKeys.length > 100 ||
      p.lineKeys.some((key) => !regular.has(key)) ||
      (['pricingOffer', 'automaticPromotion', 'coupon'] as const).some(
        (key) => typeof p.policy[key] !== 'boolean',
      )
    )
      throw new RangeError('Invalid eligible promotion');
  }
  const ordered = [...promotions].sort(promotionOrder);
  const original = sum(regular.values());
  const apply = (
    selected: readonly ProposalPromotion[],
    withPricing: boolean,
  ): ProposalResult => {
    const balances = new Map(withPricing ? offers : regular);
    const pricingDiscount = original.subtract(sum(balances.values()));
    const applied: AppliedPromotion[] = [];
    for (const p of selected) {
      spend();
      const keys = [...new Set(p.lineKeys)].sort(textOrder);
      const subtotal = sum(keys.map((key) => balances.get(key)!));
      if (subtotal.compare(zero) === 0) continue;
      const value = ExactAmount.from(p.value);
      const discount =
        p.type === 'PORCENTAJE'
          ? subtotal.multiply(value).divide(hundred)
          : value.min(subtotal);
      const allocations = new Map<string, ExactAmount>();
      for (const key of keys) {
        spend();
        const balance = balances.get(key)!;
        const allocated = balance.multiply(discount).divide(subtotal);
        allocations.set(key, allocated);
        balances.set(key, balance.subtract(allocated));
      }
      applied.push({
        id: p.id,
        priority: p.priority,
        usesCoupon: p.usesCoupon,
        discount,
        allocations,
      });
    }
    const result = sum(balances.values());
    return {
      original,
      discount: original.subtract(result),
      result,
      pricingDiscount,
      applied,
      balances,
      primaryPromotionId: applied[0]?.id ?? null,
      couponPromotionId: applied.find((p) => p.usesCoupon)?.id ?? null,
    };
  };
  let winner = apply([], true);
  const consider = (selected: readonly ProposalPromotion[]) => {
    const withoutPricing = apply(selected, false);
    if (compareResults(withoutPricing, winner) < 0) winner = withoutPricing;
    if (selected.every((p) => p.policy.pricingOffer)) {
      const withPricing = apply(selected, true);
      if (compareResults(withPricing, winner) < 0) winner = withPricing;
    }
  };
  const visit = (selected: readonly ProposalPromotion[], start: number) => {
    for (let i = start; i < ordered.length; i++) {
      spend();
      const next = ordered[i];
      if (!selected.every((p) => compatible(p, next))) continue;
      const subset = [...selected, next];
      consider(subset);
      visit(subset, i + 1);
    }
  };
  visit([], 0);
  spend();
  return winner;
}
