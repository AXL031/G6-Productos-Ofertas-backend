import { Decimal } from './decimal.js';
import {
  assertPromotion,
  assertActiveScopes,
  assertCoupon,
  assertRecommendation,
  bestAlternative,
  canChangeModality,
  couponRejection,
  discountFor,
  effectiveAt,
  rankRecommendations,
} from './promotion-rules.js';
import { evaluateBasket } from './basket-evaluation.js';
import type { NewPromotion } from '../infrastructure/persistence/repositories.js';
import type {
  PromotionQueryRow,
  CouponQueryRow,
} from '../infrastructure/persistence/query-repository.js';
const policy = {
  pricingOffer: false,
  automaticPromotion: false,
  coupon: false,
};
const at = '2026-10-22T12:00:00Z';
const configuration = (changes: Partial<NewPromotion> = {}): NewPromotion => ({
  name: 'Promotion',
  discountType: 'PORCENTAJE',
  discountValue: '15',
  modality: 'AUTOMATICA',
  state: 'ACTIVO',
  validFrom: '2026-10-01T00:00:00Z',
  validUntil: '2026-12-01T00:00:00Z',
  priority: 1,
  enabledChannels: ['MARKETPLACE'],
  ...changes,
});
const row = (changes: Partial<PromotionQueryRow> = {}): PromotionQueryRow => ({
  ...configuration(),
  id: '00000000-0000-4000-8000-000000000001',
  firstActivatedAt: at,
  createdAt: at,
  updatedAt: at,
  scopes: [
    {
      id: 'scope',
      promotionId: 'p',
      productId: 'PRODUCT',
      sku: null,
      createdAt: at,
      updatedAt: at,
    },
  ],
  policy: { promotionId: 'p', ...policy, createdAt: at, updatedAt: at },
  couponCount: 0,
  historicalUseCount: 0,
  ...changes,
});
const coupon = (changes: Partial<CouponQueryRow> = {}): CouponQueryRow => ({
  id: 'coupon',
  promotionId: row().id,
  code: 'DEMO',
  state: 'ACTIVO',
  minimumAmount: null,
  maxGlobalUses: 1,
  maxCustomerUses: null,
  cancellationPolicy: 'RESTAURAR_EN_CANCELACION',
  createdAt: at,
  updatedAt: at,
  used: 0,
  ...changes,
});
const request = {
  channel_id: 'MARKETPLACE',
  lines: [{ sku: 'SKU', quantity: 2 }],
};
const context = {
  lines: [
    {
      sku: 'SKU',
      productId: 'PRODUCT',
      quantity: 2,
      regular: '100',
      offer: null,
      currency: 'PEN',
      active: true,
      channelEligible: true,
    },
  ],
};
describe('Promotions business rules #72', () => {
  it('keeps exact decimals, percentages and fixed discounts without invented cent rounding', () => {
    expect(
      Decimal.from('0.1').add(Decimal.from('0.2')).compare(Decimal.from('0.3')),
    ).toBe(0);
    expect(
      discountFor(Decimal.from('200'), 'PORCENTAJE', '15').toNumber(),
    ).toBe(30);
    expect(discountFor(Decimal.from('30'), 'MONTO_FIJO', '50').toNumber()).toBe(
      30,
    );
    expect(
      discountFor(Decimal.from('0.001'), 'PORCENTAJE', '10').compare(
        Decimal.from('0.0001'),
      ),
    ).toBe(0);
    expect(() => Decimal.from('Infinity')).toThrow();
    expect(() => Decimal.from('1e-1000').toNumber()).toThrow(
      'DECIMAL_OUT_OF_HTTP_RANGE',
    );
  });
  it.each([
    { discountValue: '100.001' },
    { discountValue: '0' },
    { discountValue: 'NaN' },
    { priority: 0 },
    { enabledChannels: [] },
    { enabledChannels: ['MARKETPLACE', 'MARKETPLACE'] },
    { validUntil: '2026-10-01T00:00:00Z' },
  ])('rejects invalid promotion %j', (change) => {
    expect(() =>
      assertPromotion(configuration(change), [{ sku: 'SKU' }], policy),
    ).toThrow('PROMOCION_INVALIDA');
  });
  it('requires explicit scope and never treats an empty reference as omission', () => {
    assertPromotion(
      configuration(),
      [{ productId: 'PRODUCT' }, { sku: 'SKU' }],
      policy,
    );
    for (const scopes of [
      [],
      [{ productId: 'PRODUCT', sku: 'SKU' }],
      [{ productId: 'PRODUCT', sku: '' }],
      [{ sku: 'SKU' }, { sku: 'SKU' }],
    ])
      expect(() => assertPromotion(configuration(), scopes, policy)).toThrow(
        'ALCANCE_PROMOCION_INVALIDO',
      );
  });
  it('rejects unavailable references and impossible calendar dates', () => {
    assertActiveScopes(
      [{ productId: 'P' }, { sku: 'S' }],
      new Set(['P']),
      new Set(['S']),
    );
    expect(() =>
      assertActiveScopes([{ sku: 'MISSING' }], new Set(), new Set()),
    ).toThrow('ALCANCE_PROMOCION_INVALIDO');
    expect(() =>
      assertPromotion(
        configuration({ validFrom: '2026-02-30T00:00:00Z' }),
        [{ sku: 'SKU' }],
        policy,
      ),
    ).toThrow('PROMOCION_INVALIDA');
  });
  it('locks modality after activation, coupon association or any historical use', () => {
    expect(canChangeModality('INACTIVO', null, 0, 0)).toBe(true);
    for (const history of [
      {
        state: 'ACTIVO',
        firstActivatedAt: null,
        couponCount: 0,
        historicalUseCount: 0,
      },
      {
        state: 'INACTIVO',
        firstActivatedAt: at,
        couponCount: 0,
        historicalUseCount: 0,
      },
      {
        state: 'INACTIVO',
        firstActivatedAt: null,
        couponCount: 1,
        historicalUseCount: 0,
      },
      {
        state: 'INACTIVO',
        firstActivatedAt: null,
        couponCount: 0,
        historicalUseCount: 1,
      },
    ])
      expect(() =>
        assertPromotion(
          configuration({ state: 'INACTIVO', modality: 'CUPON' }),
          [{ sku: 'SKU' }],
          policy,
          { ...history, modality: 'AUTOMATICA' },
        ),
      ).toThrow('PROMOCION_INVALIDA');
    assertPromotion(
      configuration({ state: 'INACTIVO', modality: 'CUPON' }),
      [{ sku: 'SKU' }],
      policy,
      {
        state: 'INACTIVO',
        firstActivatedAt: null,
        couponCount: 0,
        historicalUseCount: 0,
        modality: 'AUTOMATICA',
      },
    );
  });
  it('normalizes only ASCII coupon letters and excludes the current row on edit', () => {
    const c = { ...coupon(), code: '  demo_1-x  ' };
    expect(assertCoupon(c, 'own', 'own')).toBe('DEMO_1-X');
    expect(() => assertCoupon(c, 'other', 'own')).toThrow('CUPON_DUPLICADO');
    for (const change of [
      { maxGlobalUses: 0 },
      { maxCustomerUses: 1.5 },
      { minimumAmount: '0' },
      { code: 'DÉMO' },
    ])
      expect(() => assertCoupon({ ...c, ...change })).toThrow(
        'LIMITE_CUPON_INVALIDO',
      );
  });
  it('uses an inclusive start and exclusive end', () => {
    expect(effectiveAt(at, '2026-10-23T00:00:00Z', at)).toBe(true);
    expect(effectiveAt('2026-10-01T00:00:00Z', at, at)).toBe(false);
  });
  it('selects no-coupon, then priority, then stable id on an exact amount tie', () => {
    const base = { resultAmount: Decimal.from(100), policy };
    const entries = [
      { ...base, id: 'z', priority: 1, usesCoupon: true },
      { ...base, id: 'b', priority: 1, usesCoupon: false },
      { ...base, id: 'a', priority: 1, usesCoupon: false },
    ];
    expect(bestAlternative(entries)?.id).toBe('a');
    expect(bestAlternative(entries.reverse())?.id).toBe('a');
  });
  it('deduplicates product/SKU scope matches and applies a fixed discount once', () => {
    const p = row({ discountType: 'MONTO_FIJO', discountValue: '50' });
    p.scopes.push({
      ...p.scopes[0],
      id: 'second',
      productId: null,
      sku: 'SKU',
    });
    const result = evaluateBasket(request, context, [p], undefined, at);
    expect(result.original.toNumber()).toBe(200);
    expect(result.discount.toNumber()).toBe(50);
    expect(result.result.toNumber()).toBe(150);
  });
  it('preserves Pricing offer as an exclusive alternative rather than discounting it twice', () => {
    const c = { lines: [{ ...context.lines[0], offer: '90' }] };
    expect(
      evaluateBasket(request, c, [row()], undefined, at).result.toNumber(),
    ).toBe(170);
    const p = row();
    p.policy = { ...p.policy!, pricingOffer: true };
    expect(
      evaluateBasket(request, c, [p], undefined, at).result.toNumber(),
    ).toBe(153);
  });
  it('excludes inactive, expired, other-channel and coupon-only promotions without a code', () => {
    for (const p of [
      row({ state: 'INACTIVO' }),
      row({ validUntil: at }),
      row({ enabledChannels: ['RETAIL'] }),
      row({ modality: 'CUPON' }),
    ])
      expect(
        evaluateBasket(
          request,
          context,
          [p],
          undefined,
          at,
        ).discount.toNumber(),
      ).toBe(0);
  });
  it('composes automatic promotions using the approved successive-discount rule', () => {
    const a = row(),
      b = row({ id: 'second' });
    a.policy = { ...a.policy!, automaticPromotion: true };
    b.policy = { ...b.policy!, automaticPromotion: true };
    for (const p of [a, b])
      expect(
        evaluateBasket(request, context, [p], undefined, at).result.toNumber(),
      ).toBe(170);
    for (const promotions of [
      [a, b],
      [b, a],
    ]) {
      const result = evaluateBasket(
        request,
        context,
        promotions,
        undefined,
        at,
      );
      expect(result.result.toNumber()).toBe(144.5);
      expect(result.promotionId).toBe(a.id);
    }
  });
  it('composes a permitted automatic/coupon pair and preserves both campaign identities internally', () => {
    const automatic = row(),
      couponPromotion = row({ id: 'coupon-parent', modality: 'CUPON' });
    automatic.policy = { ...automatic.policy!, coupon: true };
    couponPromotion.policy = {
      ...couponPromotion.policy!,
      automaticPromotion: true,
    };
    const c = {
      ...coupon({ promotionId: couponPromotion.id }),
      customerUsed: 0,
    };
    const body = { ...request, coupon_code: c.code };
    for (const p of [automatic, couponPromotion])
      expect(evaluateBasket(body, context, [p], c, at).result.toNumber()).toBe(
        170,
      );
    for (const promotions of [
      [automatic, couponPromotion],
      [couponPromotion, automatic],
    ]) {
      const result = evaluateBasket(body, context, promotions, c, at);
      expect(result.result.toNumber()).toBe(144.5);
      expect(result.promotionId).toBe(automatic.id);
      expect(result.appliedCouponPromotionId).toBe(couponPromotion.id);
    }
  });
  it.each([
    [{ state: 'INACTIVO' }, undefined, 'CUPON_INACTIVO'],
    [{ validUntil: at }, undefined, 'CUPON_FUERA_DE_VIGENCIA'],
    [{ maxCustomerUses: 1 }, null, 'CUSTOMER_REF_REQUERIDO'],
    [{ minimumAmount: '201' }, undefined, 'MONTO_MINIMO_NO_ALCANZADO'],
    [{ used: 1 }, undefined, 'CUPON_AGOTADO'],
    [
      { maxCustomerUses: 1, customerUsed: 1 },
      'buyer',
      'LIMITE_CUPON_CLIENTE_ALCANZADO',
    ],
    [{ eligible: false }, undefined, 'CUPON_NO_COMBINABLE'],
  ] as const)('returns stable coupon rejection %j', (change, buyer, code) => {
    expect(
      couponRejection(
        {
          state: 'ACTIVO',
          promotionState: 'ACTIVO',
          validFrom: '2026-10-01T00:00:00Z',
          validUntil: '2026-12-01T00:00:00Z',
          maxGlobalUses: 1,
          maxCustomerUses: null,
          minimumAmount: null,
          used: 0,
          customerUsed: 0,
          eligible: true,
          ...change,
        },
        Decimal.from(200),
        at,
        buyer,
      ),
    ).toBe(code);
  });
  it('validates coupons without mutating uses, context or campaign input', () => {
    const p = row({ modality: 'CUPON' }),
      c = { ...coupon(), customerUsed: 0 };
    const body = { ...request, coupon_code: 'DEMO' };
    const before = JSON.stringify({ body, context, p, c });
    const first = evaluateBasket(body, context, [p], c, at),
      second = evaluateBasket(body, context, [p], c, at);
    expect(first.couponApplicable).toBe(true);
    expect(second.result.compare(first.result)).toBe(0);
    expect(JSON.stringify({ body, context, p, c })).toBe(before);
  });
  it('requires bilateral permission and selects the best compatible subset', () => {
    const make = (
      id: string,
      discountValue: string,
      automaticPromotion: boolean,
    ) =>
      row({
        id,
        discountValue,
        policy: { ...row().policy!, automaticPromotion },
      });
    const exclusive = make('exclusive', '50', false),
      a = make('a', '30', true),
      b = make('b', '40', true);
    const composed = evaluateBasket(
      request,
      context,
      [exclusive, a, b],
      undefined,
      at,
    );
    expect(composed.result.toNumber()).toBe(84);
    expect(composed.promotionId).toBe('a');
    b.policy = { ...b.policy!, automaticPromotion: false };
    expect(
      evaluateBasket(
        request,
        context,
        [exclusive, a, b],
        undefined,
        at,
      ).result.toNumber(),
    ).toBe(100);
  });
  it('applies Pricing offers to a combination only if every member permits them', () => {
    const make = (id: string, discountValue: string) =>
      row({
        id,
        discountValue,
        policy: {
          ...row().policy!,
          pricingOffer: true,
          automaticPromotion: true,
        },
      });
    const a = make('a', '10'),
      b = make('b', '20');
    const facts = { lines: [{ ...context.lines[0], offer: '90' }] };
    expect(
      evaluateBasket(request, facts, [a, b], undefined, at).result.toNumber(),
    ).toBe(129.6);
    b.policy = { ...b.policy!, pricingOffer: false };
    expect(
      evaluateBasket(request, facts, [a, b], undefined, at).result.toNumber(),
    ).toBe(144);
  });
  it('allocates fixed money proportionally and rounds only the final repeating total', () => {
    const body = {
      ...request,
      lines: [
        { sku: 'A', quantity: 1 },
        { sku: 'B', quantity: 1 },
      ],
    };
    const facts = {
      lines: ['A', 'B'].map((sku, i) => ({
        ...context.lines[0],
        sku,
        quantity: 1,
        regular: String(i + 1),
      })),
    };
    const fixed = row({
      id: 'fixed',
      discountType: 'MONTO_FIJO',
      discountValue: '1',
      policy: { ...row().policy!, automaticPromotion: true },
    });
    const percent = row({
      id: 'percent',
      priority: 2,
      discountValue: '50',
      scopes: [{ ...row().scopes[0], productId: null, sku: 'A' }],
      policy: { ...row().policy!, automaticPromotion: true },
    });
    const result = evaluateBasket(body, facts, [fixed, percent], undefined, at);
    expect(result.original.toNumber()).toBe(3);
    expect(result.result.toNumber()).toBe(1.67);
    expect(result.discount.toNumber()).toBe(1.33);
    expect(result.original.compare(result.discount.add(result.result))).toBe(0);
    expect(result.promotionId).toBe('fixed');
  });
  it('consolidates duplicate SKU lines before applying a fixed discount once', () => {
    const body = {
      ...request,
      lines: [
        { sku: 'SKU', quantity: 1 },
        { sku: 'SKU', quantity: 2 },
      ],
    };
    const facts = {
      lines: body.lines.map((l) => ({
        ...context.lines[0],
        quantity: l.quantity,
      })),
    };
    const p = row({ discountType: 'MONTO_FIJO', discountValue: '50' });
    p.scopes.push({ ...p.scopes[0], productId: null, sku: 'SKU' });
    const result = evaluateBasket(body, facts, [p], undefined, at);
    expect(result.original.toNumber()).toBe(300);
    expect(result.result.toNumber()).toBe(250);
    expect(
      evaluateBasket(
        { ...body, lines: [...body.lines].reverse() },
        { lines: [...facts.lines].reverse() },
        [p],
        undefined,
        at,
      ).result.toNumber(),
    ).toBe(250);
  });
  it.each([
    { productId: 'OTHER' },
    { regular: '101' },
    { offer: '99' },
    { currency: 'USD' },
  ])('rejects incoherent duplicate SKU facts: %j', (changes) => {
    const body = { ...request, lines: [request.lines[0], request.lines[0]] };
    const facts = {
      lines: [context.lines[0], { ...context.lines[0], ...changes }],
    };
    expect(() => evaluateBasket(body, facts, [], undefined, at)).toThrow(
      'COMMERCIAL_CONTEXT_UNAVAILABLE',
    );
  });
  it('rejects unsupported currency scales, unrepresentable unit prices and lossy HTTP amounts', () => {
    for (const changes of [
      { currency: 'USD' },
      { regular: '100.001' },
      { offer: '99.999' },
      { regular: '100000000000000.01' },
    ]) {
      expect(() =>
        evaluateBasket(
          request,
          { lines: [{ ...context.lines[0], ...changes }] },
          [],
          undefined,
          at,
        ),
      ).toThrow('COMMERCIAL_CONTEXT_UNAVAILABLE');
    }
    expect(() =>
      evaluateBasket(
        { ...request, lines: [{ sku: 'SKU', quantity: 1000 }] },
        { lines: [{ ...context.lines[0], quantity: 1000, regular: '0.001' }] },
        [],
        undefined,
        at,
      ),
    ).toThrow('COMMERCIAL_CONTEXT_UNAVAILABLE');
  });
  it('rounds the total half up and picks the exact winner before monetary projection', () => {
    const body = { ...request, lines: [{ sku: 'SKU', quantity: 1 }] };
    const facts = {
      lines: [{ ...context.lines[0], quantity: 1, regular: '0.01' }],
    };
    const half = evaluateBasket(
      body,
      facts,
      [row({ discountValue: '50' })],
      undefined,
      at,
    );
    expect(half.result.toNumber()).toBe(0.01);
    expect(half.discount.toNumber()).toBe(0);
    const precise = { lines: [{ ...facts.lines[0], regular: '100' }] };
    const result = evaluateBasket(
      body,
      precise,
      [
        row({ id: 'z', discountValue: '10.0046' }),
        row({ id: 'a', discountValue: '10.0045' }),
      ],
      undefined,
      at,
    );
    expect(result.result.toNumber()).toBe(90);
    expect(result.promotionId).toBe('z');
  });
  it('validates the actual coupon independently of a better exclusive Pricing offer', () => {
    const p = row({ modality: 'CUPON' }),
      c = { ...coupon(), customerUsed: 0 };
    const body = { ...request, coupon_code: c.code },
      facts = { lines: [{ ...context.lines[0], offer: '80' }] };
    const evaluated = evaluateBasket(body, facts, [p], c, at);
    expect(evaluated.result.toNumber()).toBe(160);
    expect(evaluated.appliedCouponPromotionId).toBeNull();
    const validated = evaluateBasket(body, facts, [p], c, at, true);
    expect(validated.couponApplicable).toBe(true);
    expect(validated.couponCandidate?.id).toBe(p.id);
    expect(validated.couponCandidate?.resultAmount.toNumber()).toBe(170);
  });
  it('rejects cardinality and elapsed-time budgets instead of returning a partial winner', () => {
    const entries = Array.from({ length: 101 }, () => request.lines[0]);
    expect(() =>
      evaluateBasket(
        { ...request, lines: entries },
        { lines: entries.map(() => context.lines[0]) },
        [],
        undefined,
        at,
      ),
    ).toThrow('COMMERCIAL_CONTEXT_UNAVAILABLE');
    expect(() =>
      evaluateBasket(
        request,
        context,
        Array.from({ length: 13 }, (_, i) => row({ id: String(i) })),
        undefined,
        at,
      ),
    ).toThrow('COMMERCIAL_CONTEXT_UNAVAILABLE');
    const clock = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(101);
    try {
      expect(() =>
        evaluateBasket(request, context, [row()], undefined, at),
      ).toThrow('COMMERCIAL_CONTEXT_UNAVAILABLE');
    } finally {
      clock.mockRestore();
    }
  });
  it('requires valid active recommendation references and an explicit upsell criterion', () => {
    const rule = {
      name: 'Rule',
      recommendationType: 'UPSELL',
      originType: 'PRODUCTO',
      originId: 'ORIGIN',
      priority: 1,
      state: 'ACTIVO',
      validFrom: '2026-10-01T00:00:00Z',
      validUntil: '2026-12-01T00:00:00Z',
    };
    const products = new Set(['ORIGIN', 'TARGET']);
    const item = {
      productId: 'TARGET',
      itemOrder: 1,
      superiorityCriterion: 'MAYOR_CAPACIDAD',
    };
    assertRecommendation(rule, [item], products, new Set());
    for (const items of [
      [],
      [{ ...item, superiorityCriterion: null }],
      [{ ...item, productId: 'ORIGIN' }],
      [item, item],
      [{ ...item, productId: 'MISSING' }],
    ])
      expect(() =>
        assertRecommendation(rule, items, products, new Set()),
      ).toThrow('REGLA_RECOMENDACION_INVALIDA');
  });
  it('ranks recommendations by priority/order, filters availability and deduplicates deterministically', () => {
    const base = {
      type: 'CROSS_SELL',
      priority: 1,
      order: 1,
      ruleId: 'a',
      active: true,
      channelEligible: true,
      availability: 'DISPONIBLE' as const,
      currentPrice: null,
    };
    const candidates = [
      { ...base, productId: 'A', priority: 2 },
      { ...base, productId: 'B', order: 2 },
      { ...base, productId: 'A' },
      { ...base, productId: 'X', availability: 'AGOTADO' as const },
      { ...base, productId: 'Y', active: false },
      { ...base, productId: 'ORIGIN' },
    ];
    expect(
      rankRecommendations(candidates, 'ORIGIN').map((c) => c.productId),
    ).toEqual(['A', 'B']);
  });
});
