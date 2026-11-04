import { Decimal } from './decimal.js';
import { validInstant } from './date-time.js';
import type {
  NewPromotion,
  PromotionScope,
  CombinationPolicy,
  NewCoupon,
  NewRecommendation,
  RecommendationItem,
} from '../infrastructure/persistence/repositories.js';

export class PromotionRuleError extends Error {
  constructor(
    readonly code:
      | 'PROMOCION_INVALIDA'
      | 'ALCANCE_PROMOCION_INVALIDO'
      | 'LIMITE_CUPON_INVALIDO'
      | 'CUPON_DUPLICADO'
      | 'REGLA_RECOMENDACION_INVALIDA'
      | 'PRODUCTO_RECOMENDADO_INVALIDO'
      | 'PROMOCION_NO_ENCONTRADA'
      | 'CUPON_NO_ENCONTRADO'
      | 'REGLA_RECOMENDACION_NO_ENCONTRADA',
  ) {
    super(code);
  }
}
const zero = Decimal.from('0');
const channels = ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'];
const criteria = [
  'MAYOR_RENDIMIENTO',
  'MEJOR_MATERIAL',
  'MAYOR_CAPACIDAD',
  'FUNCIONALIDAD_ADICIONAL',
];
const present = (s: string | null | undefined): s is string =>
  typeof s === 'string' && !!s.trim();
const positiveInteger = (n: number) => Number.isSafeInteger(n) && n > 0;
export function validPeriod(from: string, until: string): boolean {
  return (
    validInstant(from) &&
    validInstant(until) &&
    Date.parse(from) < Date.parse(until)
  );
}
export function effectiveAt(
  from: string,
  until: string | null,
  at: string,
): boolean {
  const instant = Date.parse(at);
  return (
    Number.isFinite(instant) &&
    Date.parse(from) <= instant &&
    (until === null || instant < Date.parse(until))
  );
}
export function canChangeModality(
  state: string,
  firstActivatedAt: string | null,
  couponCount: number,
  historicalUseCount: number,
): boolean {
  return (
    state === 'INACTIVO' &&
    firstActivatedAt === null &&
    couponCount === 0 &&
    historicalUseCount === 0
  );
}
export function assertPromotion(
  p: NewPromotion,
  scopes: readonly PromotionScope[],
  policy: CombinationPolicy,
  previous?: {
    modality: string;
    state: string;
    firstActivatedAt: string | null;
    couponCount: number;
    historicalUseCount: number;
  },
): void {
  try {
    const amount = Decimal.from(p.discountValue);
    if (
      !present(p.name) ||
      !['PORCENTAJE', 'MONTO_FIJO'].includes(p.discountType) ||
      amount.compare(zero) <= 0 ||
      (p.discountType === 'PORCENTAJE' &&
        amount.compare(Decimal.from(100)) > 0) ||
      !validPeriod(p.validFrom, p.validUntil) ||
      !positiveInteger(p.priority) ||
      !['ACTIVO', 'INACTIVO'].includes(p.state) ||
      !['AUTOMATICA', 'CUPON'].includes(p.modality) ||
      !p.enabledChannels.length ||
      new Set(p.enabledChannels).size !== p.enabledChannels.length ||
      p.enabledChannels.some((c) => !channels.includes(c)) ||
      (['pricingOffer', 'automaticPromotion', 'coupon'] as const).some(
        (k) => typeof policy[k] !== 'boolean',
      )
    )
      throw new Error();
    if (
      previous &&
      previous.modality !== p.modality &&
      (p.state !== 'INACTIVO' ||
        !canChangeModality(
          previous.state,
          previous.firstActivatedAt,
          previous.couponCount,
          previous.historicalUseCount,
        ))
    )
      throw new Error();
  } catch {
    throw new PromotionRuleError('PROMOCION_INVALIDA');
  }
  const identities = scopes.map((s) =>
    present(s.productId) && s.sku == null
      ? 'P:' + s.productId
      : present(s.sku) && s.productId == null
        ? 'S:' + s.sku
        : '',
  );
  if (
    !identities.length ||
    identities.includes('') ||
    new Set(identities).size !== identities.length
  )
    throw new PromotionRuleError('ALCANCE_PROMOCION_INVALIDO');
}
export function normalizeCouponCode(code: string): string {
  return code.trim().replace(/[a-z]/g, (c) => c.toUpperCase());
}
export function assertActiveScopes(
  scopes: readonly PromotionScope[],
  activeProducts: ReadonlySet<string>,
  activeSkus: ReadonlySet<string>,
): void {
  if (
    !scopes.length ||
    scopes.some((s) =>
      s.productId != null
        ? !activeProducts.has(s.productId)
        : s.sku == null || !activeSkus.has(s.sku),
    )
  )
    throw new PromotionRuleError('ALCANCE_PROMOCION_INVALIDO');
}
export function assertCoupon(
  c: NewCoupon,
  duplicateId?: string,
  ownId?: string,
): string {
  const normalized = normalizeCouponCode(c.code);
  try {
    if (
      !/^[A-Z0-9_-]+$/.test(normalized) ||
      !['ACTIVO', 'INACTIVO'].includes(c.state) ||
      !['RESTAURAR_EN_CANCELACION', 'NO_RESTAURAR'].includes(
        c.cancellationPolicy,
      ) ||
      (c.minimumAmount != null &&
        Decimal.from(c.minimumAmount).compare(zero) <= 0) ||
      [c.maxCustomerUses, c.maxGlobalUses].some(
        (n) => n != null && !positiveInteger(n),
      )
    )
      throw new Error();
  } catch {
    throw new PromotionRuleError('LIMITE_CUPON_INVALIDO');
  }
  if (duplicateId && duplicateId !== ownId)
    throw new PromotionRuleError('CUPON_DUPLICADO');
  return normalized;
}
export function assertRecommendation(
  rule: NewRecommendation,
  items: readonly RecommendationItem[],
  activeProducts: ReadonlySet<string>,
  activeCategories: ReadonlySet<string>,
): void {
  if (
    !present(rule.name) ||
    !['CROSS_SELL', 'UPSELL'].includes(rule.recommendationType) ||
    !['ACTIVO', 'INACTIVO'].includes(rule.state) ||
    !['PRODUCTO', 'CATEGORIA'].includes(rule.originType) ||
    !positiveInteger(rule.priority) ||
    !validPeriod(rule.validFrom, rule.validUntil) ||
    !(rule.originType === 'PRODUCTO' ? activeProducts : activeCategories).has(
      rule.originId,
    ) ||
    !items.length ||
    new Set(items.map((i) => i.productId)).size !== items.length ||
    items.some(
      (i) =>
        !activeProducts.has(i.productId) ||
        !positiveInteger(i.itemOrder) ||
        (rule.originType === 'PRODUCTO' && i.productId === rule.originId) ||
        (rule.recommendationType === 'UPSELL' &&
          !criteria.includes(i.superiorityCriterion ?? '')) ||
        (i.superiorityCriterion != null &&
          !criteria.includes(i.superiorityCriterion)) ||
        [...(i.commercialJustification ?? '')].length > 500,
    )
  )
    throw new PromotionRuleError('REGLA_RECOMENDACION_INVALIDA');
}
export interface BenefitCandidate {
  id: string;
  priority: number;
  usesCoupon: boolean;
  resultAmount: Decimal;
  policy: CombinationPolicy;
}
export function bestAlternative(
  candidates: readonly BenefitCandidate[],
): BenefitCandidate | undefined {
  return [...candidates].sort(
    (a, b) =>
      a.resultAmount.compare(b.resultAmount) ||
      Number(a.usesCoupon) - Number(b.usesCoupon) ||
      a.priority - b.priority ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0];
}
export function discountFor(
  subtotal: Decimal,
  type: string,
  value: string,
): Decimal {
  const amount =
    type === 'PORCENTAJE'
      ? subtotal.percent(Decimal.from(value))
      : Decimal.from(value);
  return amount.min(subtotal);
}
export type CouponRejection =
  | 'CUPON_NO_ENCONTRADO'
  | 'CUPON_INACTIVO'
  | 'CUPON_FUERA_DE_VIGENCIA'
  | 'MONTO_MINIMO_NO_ALCANZADO'
  | 'CUPON_AGOTADO'
  | 'LIMITE_CUPON_CLIENTE_ALCANZADO'
  | 'CUSTOMER_REF_REQUERIDO'
  | 'CUPON_NO_COMBINABLE';
export function couponRejection(
  c: {
    state: string;
    promotionState: string;
    validFrom: string;
    validUntil: string;
    maxGlobalUses: number | null;
    maxCustomerUses: number | null;
    minimumAmount: string | null;
    used: number;
    customerUsed: number;
    eligible: boolean;
  },
  subtotal: Decimal,
  at: string,
  customerRef?: string | null,
): CouponRejection | undefined {
  if (c.state !== 'ACTIVO' || c.promotionState !== 'ACTIVO')
    return 'CUPON_INACTIVO';
  if (!effectiveAt(c.validFrom, c.validUntil, at))
    return 'CUPON_FUERA_DE_VIGENCIA';
  if (c.maxCustomerUses !== null && !customerRef)
    return 'CUSTOMER_REF_REQUERIDO';
  if (
    c.minimumAmount !== null &&
    subtotal.compare(Decimal.from(c.minimumAmount)) < 0
  )
    return 'MONTO_MINIMO_NO_ALCANZADO';
  if (c.maxGlobalUses !== null && c.used >= c.maxGlobalUses)
    return 'CUPON_AGOTADO';
  if (c.maxCustomerUses !== null && c.customerUsed >= c.maxCustomerUses)
    return 'LIMITE_CUPON_CLIENTE_ALCANZADO';
  if (!c.eligible) return 'CUPON_NO_COMBINABLE';
}
export interface RecommendationCandidate {
  productId: string;
  type: string;
  priority: number;
  order: number;
  ruleId: string;
  active: boolean;
  channelEligible: boolean;
  availability: 'DISPONIBLE' | 'STOCK_BAJO' | 'AGOTADO';
  currentPrice: number | null;
}
export function rankRecommendations(
  candidates: readonly RecommendationCandidate[],
  origin: string,
): RecommendationCandidate[] {
  const seen = new Set<string>();
  return [...candidates]
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        a.order - b.order ||
        (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0) ||
        (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0),
    )
    .filter((c) => {
      if (
        c.productId === origin ||
        !c.active ||
        !c.channelEligible ||
        c.availability === 'AGOTADO' ||
        seen.has(c.productId)
      )
        return false;
      seen.add(c.productId);
      return true;
    });
}
