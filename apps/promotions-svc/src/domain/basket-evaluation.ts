import { Decimal } from './decimal.js';
import {
  CommercialDependencyError,
  type BasketRequest,
  type ResolvedBasket,
} from './commercial-context.js';
import {
  couponRejection,
  effectiveAt,
  type CouponRejection,
} from './promotion-rules.js';
import {
  composeBenefits,
  type ProposalPromotion,
} from './benefit-composition.js';
import { projectBenefitMoney } from './benefit-money.js';
import type {
  CouponQueryRow,
  PromotionQueryRow,
} from '../infrastructure/persistence/query-repository.js';
const zero = Decimal.from(0);
export function evaluateBasket(
  request: BasketRequest,
  context: ResolvedBasket,
  promotions: readonly PromotionQueryRow[],
  coupon: (CouponQueryRow & { customerUsed: number }) | undefined,
  at: string,
  couponOnly = false,
) {
  try {
    if (
      context.lines.length !== request.lines.length ||
      !context.lines.length ||
      request.lines.length > 100
    )
      throw new CommercialDependencyError(
        'evaluación',
        'Catálogo/Pricing',
        'cesta completa y coherente con las identidades solicitadas',
      );
    const lines = context.lines.map((line, index) => {
      const input = request.lines[index];
      if (
        line.sku !== input.sku ||
        line.quantity !== input.quantity ||
        !Number.isSafeInteger(line.quantity) ||
        line.quantity <= 0 ||
        (input.product_id != null && input.product_id !== line.productId) ||
        !line.active ||
        !line.channelEligible ||
        !line.productId
      )
        throw new CommercialDependencyError(
          'elegibilidad',
          'Catálogo',
          'identidad SKU/producto y elegibilidad verificadas para el canal',
        );
      const regular = Decimal.from(line.regular);
      const offer = line.offer === null ? regular : Decimal.from(line.offer);
      if (
        regular.compare(zero) <= 0 ||
        offer.compare(zero) <= 0 ||
        offer.compare(regular) > 0
      )
        throw new CommercialDependencyError(
          'precio',
          'Pricing',
          'precio regular/oferta vigente y coherente',
        );
      return {
        ...line,
        unitRegular: regular,
        unitOffer: offer,
        regular: regular.multiply(Decimal.from(line.quantity)),
        offer: offer.multiply(Decimal.from(line.quantity)),
      };
    });
    const currency = lines[0].currency;
    if (!currency || lines.some((l) => l.currency !== currency))
      throw new CommercialDependencyError(
        'moneda',
        'Pricing',
        'moneda única conocida para evaluar la cesta',
      );
    // PEN scale is approved. Never infer another currency's scale from a price.
    if (currency !== 'PEN')
      throw new CommercialDependencyError(
        'moneda',
        'Pricing/arquitectura G6',
        'escala monetaria explícita acordada para la moneda antes de habilitarla',
      );
    const scale = 2;
    const canonical = new Map<string, (typeof lines)[number]>();
    for (const line of lines) {
      for (const price of [line.unitRegular, line.unitOffer]) {
        if (
          price.scale > scale &&
          price.coefficient % 10n ** BigInt(price.scale - scale) !== 0n
        )
          throw new RangeError('Price not representable at monetary scale');
      }
      const previous = canonical.get(line.sku);
      if (!previous) canonical.set(line.sku, { ...line });
      else {
        if (
          previous.productId !== line.productId ||
          previous.unitRegular.compare(line.unitRegular) !== 0 ||
          previous.unitOffer.compare(line.unitOffer) !== 0
        )
          throw new Error('INCONSISTENT_DUPLICATE_SKU');
        previous.regular = previous.regular.add(line.regular);
        previous.offer = previous.offer.add(line.offer);
      }
    }
    const unique = [...canonical.values()];
    const original = unique.reduce((v, l) => v.add(l.regular), zero);
    let rejection: CouponRejection | undefined =
      request.coupon_code && !coupon ? 'CUPON_NO_ENCONTRADO' : undefined;
    const eligible: ProposalPromotion[] = [];
    for (const p of promotions) {
      const scoped = unique.filter((l) =>
        p.scopes.some((s) => s.sku === l.sku || s.productId === l.productId),
      );
      const applicable =
        p.state === 'ACTIVO' &&
        effectiveAt(p.validFrom, p.validUntil, at) &&
        p.enabledChannels.includes(request.channel_id) &&
        scoped.length > 0;
      const usesCoupon = p.modality === 'CUPON';
      if (usesCoupon) {
        if (!coupon || coupon.promotionId !== p.id || !request.coupon_code)
          continue;
        rejection = couponRejection(
          {
            ...coupon,
            promotionState: p.state,
            validFrom: p.validFrom,
            validUntil: p.validUntil,
            eligible: applicable,
          },
          original,
          at,
          request.customer_ref,
        );
        if (rejection) continue;
      } else if (!applicable || couponOnly) continue;
      if (!p.policy) throw new Error('INCOMPLETE_PROMOTION_POLICY');
      const candidate = {
        id: p.id,
        priority: p.priority,
        usesCoupon,
        type: p.discountType as ProposalPromotion['type'],
        value: p.discountValue,
        lineKeys: scoped.map((l) => l.sku),
        policy: {
          pricingOffer: p.policy.pricingOffer,
          automaticPromotion: p.policy.automaticPromotion,
          coupon: p.policy.coupon,
        },
      };
      eligible.push(candidate);
    }
    const couponPromotion = eligible.find((p) => p.usesCoupon);
    const monetaryLines = unique.map((l) => ({
      key: l.sku,
      regularSubtotal: l.regular.toString(),
      // Individual validation reports the actual coupon campaign, even when a
      // mutually exclusive Pricing offer would win a full basket evaluation.
      offerSubtotal:
        couponOnly && couponPromotion && !couponPromotion.policy.pricingOffer
          ? null
          : l.offer.toString(),
    }));
    const composition = composeBenefits(monetaryLines, eligible);
    const money = projectBenefitMoney(composition, monetaryLines, scale);
    const amount = (minor: bigint) => {
      const value = Decimal.from(minor.toString() + 'e-' + scale);
      if (Decimal.from(value.toNumber()).compare(value) !== 0)
        throw new RangeError('Amount outside HTTP monetary range');
      return value;
    };
    const result = amount(money.resultMinor);
    return {
      original: amount(money.originalMinor),
      discount: amount(money.discountMinor),
      result,
      currency,
      promotionId: composition.primaryPromotionId,
      appliedCouponPromotionId: composition.couponPromotionId,
      couponRejection: rejection,
      couponApplicable: !!couponPromotion,
      couponCandidate:
        couponOnly && couponPromotion
          ? { id: couponPromotion.id, resultAmount: result }
          : undefined,
    };
  } catch (error) {
    if (error instanceof CommercialDependencyError) throw error;
    // Cardinality, work/time budgets, incoherent facts or monetary projection
    // fail the whole operation. Never publish a partial/approximate winner.
    throw new CommercialDependencyError(
      'composición de beneficios',
      'Promotions/Pricing',
      'cesta y moneda coherentes dentro de límites de composición y precisión aprobados',
    );
  }
}
