import {
  ExactAmount,
  proposeCombination,
  type ProposalLine,
  type ProposalPromotion,
  type ProposalResult,
} from './combination-policy.js';

const line = (
  key = 'A',
  regularSubtotal = '100',
  offerSubtotal: string | null = null,
): ProposalLine => ({ key, regularSubtotal, offerSubtotal });
const promotion = (
  id: string,
  changes: Partial<ProposalPromotion> = {},
): ProposalPromotion => ({
  id,
  priority: 1,
  usesCoupon: false,
  type: 'PORCENTAJE',
  value: '10',
  lineKeys: ['A'],
  policy: { pricingOffer: false, automaticPromotion: true, coupon: true },
  ...changes,
});
const amount = (actual: ExactAmount, expected: string) =>
  expect(actual.compare(ExactAmount.from(expected))).toBe(0);
function conserved(result: ProposalResult) {
  const zero = ExactAmount.from('0');
  amount(result.discount.add(result.result).subtract(result.original), '0');
  let totalDiscount = result.pricingDiscount;
  for (const p of result.applied) {
    const allocated = [...p.allocations.values()].reduce(
      (a, b) => a.add(b),
      zero,
    );
    expect(allocated.compare(p.discount)).toBe(0);
    totalDiscount = totalDiscount.add(p.discount);
  }
  expect(totalDiscount.compare(result.discount)).toBe(0);
  const balances = [...result.balances.values()];
  expect(balances.every((b) => b.compare(zero) >= 0)).toBe(true);
  expect(balances.reduce((a, b) => a.add(b), zero).compare(result.result)).toBe(
    0,
  );
}

describe('Combination proposal v1 (isolated, not an HTTP policy)', () => {
  it('keeps repeating allocations exact without selecting a monetary scale', () => {
    const third = ExactAmount.from('1').divide(ExactAmount.from('3'));
    expect(third.numerator).toBe(1n);
    expect(third.denominator).toBe(3n);
    amount(third.add(third).add(third), '1');
    amount(ExactAmount.from('0.1').add(ExactAmount.from('0.2')), '0.3');
    expect(() => third.divide(ExactAmount.from('0'))).toThrow(
      'Zero denominator',
    );
  });
  it('applies 10% and 20% successively, not as an added percentage', () => {
    const result = proposeCombination(
      [line()],
      [promotion('a'), promotion('b', { value: '20' })],
    );
    amount(result.result, '72');
    amount(result.applied[0].discount, '10');
    amount(result.applied[1].discount, '18');
    expect(result.primaryPromotionId).toBe('a');
    expect(result.couponPromotionId).toBeNull();
    conserved(result);
  });
  it('allocates a fixed discount once across eligible residual subtotals', () => {
    const result = proposeCombination(
      [line('A', '60'), line('B', '40')],
      [
        promotion('fixed', {
          priority: 1,
          type: 'MONTO_FIJO',
          value: '30',
          lineKeys: ['A', 'B', 'A'],
        }),
        promotion('percent', { priority: 2, value: '50' }),
      ],
    );
    amount(result.applied[0].allocations.get('A')!, '18');
    amount(result.applied[0].allocations.get('B')!, '12');
    amount(result.balances.get('A')!, '21');
    amount(result.balances.get('B')!, '28');
    amount(result.result, '49');
    conserved(result);
  });
  it('preserves exact conservation with overlapping scopes and thirds', () => {
    const result = proposeCombination(
      [line('A', '1'), line('B', '2')],
      [
        promotion('fixed', {
          type: 'MONTO_FIJO',
          value: '1',
          lineKeys: ['B', 'A'],
        }),
        promotion('percent', { priority: 2, value: '50' }),
      ],
    );
    expect(result.result.numerator).toBe(5n);
    expect(result.result.denominator).toBe(3n);
    expect(result.applied[0].allocations.get('A')!.numerator).toBe(1n);
    expect(result.applied[0].allocations.get('A')!.denominator).toBe(3n);
    conserved(result);
  });
  it('orders mixed discounts by priority before stable id', () => {
    const fixed = promotion('fixed', { type: 'MONTO_FIJO', value: '20' });
    const percent = promotion('percent', { priority: 2, value: '50' });
    const first = proposeCombination([line()], [percent, fixed]);
    amount(first.result, '40');
    const second = proposeCombination(
      [line()],
      [
        { ...fixed, priority: 2 },
        { ...percent, priority: 1 },
      ],
    );
    amount(second.result, '30');
    conserved(first);
    conserved(second);
  });
  it('finds the best compatible subset rather than greedily choosing one campaign', () => {
    const result = proposeCombination(
      [line()],
      [
        promotion('exclusive', {
          value: '50',
          policy: {
            pricingOffer: false,
            automaticPromotion: false,
            coupon: false,
          },
        }),
        promotion('a', { value: '30' }),
        promotion('b', { value: '40' }),
      ],
    );
    amount(result.result, '42');
    expect(result.applied.map((p) => p.id)).toEqual(['a', 'b']);
    conserved(result);
  });
  it('requires bilateral permission even for disjoint scopes', () => {
    const a = promotion('a', { value: '50' });
    const b = promotion('b', {
      value: '50',
      lineKeys: ['B'],
      policy: { pricingOffer: false, automaticPromotion: false, coupon: true },
    });
    const result = proposeCombination([line(), line('B')], [a, b]);
    amount(result.result, '150');
    expect(result.applied.map((p) => p.id)).toEqual(['a']);
    conserved(result);
  });
  it('requires compatibility with every member, not just the first', () => {
    const result = proposeCombination(
      [line()],
      [
        promotion('auto'),
        promotion('coupon-a', { usesCoupon: true, value: '20' }),
        promotion('coupon-b', { usesCoupon: true, value: '30' }),
      ],
    );
    amount(result.result, '63');
    expect(result.applied.map((p) => p.id)).toEqual(['auto', 'coupon-b']);
    expect(result.couponPromotionId).toBe('coupon-b');
    conserved(result);
  });
  it('uses the automatic/coupon permission in the appropriate direction', () => {
    const auto = promotion('auto', {
      value: '20',
      policy: { pricingOffer: false, automaticPromotion: true, coupon: false },
    });
    const coupon = promotion('coupon', { usesCoupon: true, value: '30' });
    amount(proposeCombination([line()], [auto, coupon]).result, '70');
    amount(
      proposeCombination(
        [line()],
        [{ ...auto, policy: { ...auto.policy, coupon: true } }, coupon],
      ).result,
      '56',
    );
  });
  it('compares an offer-only alternative and combines only when allowed', () => {
    const p = promotion('auto', { value: '15' });
    const exclusive = proposeCombination([line('A', '100', '80')], [p]);
    amount(exclusive.result, '80');
    expect(exclusive.primaryPromotionId).toBeNull();
    const combined = proposeCombination(
      [line('A', '100', '80')],
      [{ ...p, policy: { ...p.policy, pricingOffer: true } }],
    );
    amount(combined.result, '68');
    amount(combined.pricingDiscount, '20');
    conserved(exclusive);
    conserved(combined);
  });
  it('requires all members to allow Pricing while still evaluating regular-price subsets', () => {
    const result = proposeCombination(
      [line('A', '100', '90')],
      [
        promotion('a', { value: '50' }),
        promotion('b', {
          value: '5',
          policy: {
            pricingOffer: true,
            automaticPromotion: true,
            coupon: true,
          },
        }),
      ],
    );
    amount(result.result, '47.5');
    amount(result.pricingDiscount, '0');
    conserved(result);
  });
  it('caps fixed benefits at the remaining scope and never consumes a zero-saving coupon', () => {
    const result = proposeCombination(
      [line('A', '30')],
      [
        promotion('auto', { type: 'MONTO_FIJO', value: '50', priority: 2 }),
        promotion('coupon', { usesCoupon: true, value: '100' }),
      ],
    );
    amount(result.result, '0');
    expect(result.couponPromotionId).toBeNull();
    expect(result.applied.map((p) => p.id)).toEqual(['auto']);
    conserved(result);
  });
  it('does not divide a zero residual subtotal or attribute an empty benefit', () => {
    const result = proposeCombination(
      [line('A', '0'), line('B', '20')],
      [promotion('empty', { type: 'MONTO_FIJO', value: '1' })],
    );
    amount(result.result, '20');
    expect(result.applied).toEqual([]);
    conserved(result);
  });
  it('breaks exact ties without coupon, then priority, then stable id', () => {
    const exclusive = {
      pricingOffer: false,
      automaticPromotion: false,
      coupon: false,
    };
    const result = proposeCombination(
      [line()],
      [
        promotion('coupon', {
          priority: 1,
          usesCoupon: true,
          policy: exclusive,
        }),
        promotion('z', { priority: 2, policy: exclusive }),
        promotion('b', { priority: 1, policy: exclusive }),
        promotion('a', { priority: 1, policy: exclusive }),
      ],
    );
    amount(result.result, '90');
    expect(result.primaryPromotionId).toBe('a');
  });
  it('returns the actual coupon identity separately from the primary campaign', () => {
    const result = proposeCombination(
      [line()],
      [
        promotion('auto'),
        promotion('coupon', { priority: 2, usesCoupon: true }),
      ],
    );
    expect(result.primaryPromotionId).toBe('auto');
    expect(result.couponPromotionId).toBe('coupon');
    expect(result.applied.map((p) => p.id)).toEqual(['auto', 'coupon']);
    amount(result.result, '81');
    conserved(result);
  });
  it('is invariant under input ordering and repeated evaluation without mutating inputs', () => {
    const lines = [line('A', '60'), line('B', '40')];
    const promotions = [
      promotion('b', { lineKeys: ['B'], value: '20' }),
      promotion('a', { type: 'MONTO_FIJO', value: '15', lineKeys: ['B', 'A'] }),
    ];
    const before = JSON.stringify({ lines, promotions });
    const first = proposeCombination(lines, promotions);
    const second = proposeCombination(
      [...lines].reverse(),
      [...promotions].reverse(),
    );
    expect(first.result.compare(second.result)).toBe(0);
    expect(first.applied.map((p) => p.id)).toEqual(
      second.applied.map((p) => p.id),
    );
    expect(
      proposeCombination(lines, promotions).result.compare(first.result),
    ).toBe(0);
    expect(JSON.stringify({ lines, promotions })).toBe(before);
    conserved(first);
    conserved(second);
  });
  it.each([
    [[], []],
    [[line(), line()], []],
    [[line('A', '-1')], []],
    [[line('A', '100', '101')], []],
    [[line()], [promotion('a', { value: '0' })]],
    [[line()], [promotion('a', { value: '101' })]],
    [[line()], [promotion('a', { priority: 0 })]],
    [[line()], [promotion('a', { lineKeys: ['UNKNOWN'] })]],
    [[line()], [promotion('a'), promotion('a')]],
  ] as const)('rejects invalid prototype inputs %#', (lines, promotions) => {
    expect(() => proposeCombination(lines, promotions)).toThrow();
  });
  it('matches an independent integer oracle over compatible percentage subsets', () => {
    // Three automatic campaigns plus one coupon: all 128 assignments of the
    // relevant type-wide flags, not arbitrary pair-specific compatibility.
    // The oracle uses integer products rather than the reference allocator.
    for (let graph = 0; graph < 128; graph++) {
      const offers = [10, 20, 30, 40];
      const candidates = offers.map((value, i) =>
        promotion(String(i), {
          value: String(value),
          usesCoupon: i === 3,
          policy: {
            pricingOffer: false,
            automaticPromotion: Boolean(graph & (1 << i)),
            coupon: Boolean(graph & (1 << (4 + i))),
          },
        }),
      );
      let expected = 100_000_000;
      for (let mask = 0; mask < 16; mask++) {
        const selected = candidates.filter((_, i) => mask & (1 << i));
        const valid = selected.every((a, i) =>
          selected
            .slice(i + 1)
            .every((b) =>
              b.usesCoupon
                ? a.policy.coupon && b.policy.automaticPromotion
                : a.policy.automaticPromotion && b.policy.automaticPromotion,
            ),
        );
        if (!valid) continue;
        let result = 100_000_000;
        for (const p of selected)
          result = (result / 100) * (100 - Number(p.value));
        expected = Math.min(expected, result);
      }
      const actual = proposeCombination([line()], candidates);
      amount(actual.result, String(expected / 1_000_000));
      conserved(actual);
    }
  });
});
