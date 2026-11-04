import {
  composeBenefits,
  CompositionBudgetExceeded,
  type ProposalLine,
  type ProposalPromotion,
} from './benefit-composition.js';
import { projectBenefitMoney } from './benefit-money.js';

const line = (key: string, regularSubtotal: string): ProposalLine => ({
  key,
  regularSubtotal,
  offerSubtotal: null,
});
const campaign = (
  id: string,
  value: string,
  keys: string[],
  type: 'MONTO_FIJO' | 'PORCENTAJE' = 'MONTO_FIJO',
): ProposalPromotion => ({
  id,
  value,
  lineKeys: keys,
  priority: 1,
  usesCoupon: false,
  type,
  policy: { pricingOffer: true, automaticPromotion: true, coupon: true },
});

describe('Internal candidate composition and monetary projection', () => {
  afterEach(() => vi.restoreAllMocks());
  it('projects the exact 5/3 example once, conserving the original and line totals', () => {
    const lines = [line('A', '1'), line('B', '2')];
    const result = composeBenefits(lines, [
      campaign('first', '1', ['A', 'B']),
      { ...campaign('second', '50', ['A'], 'PORCENTAJE'), priority: 2 },
    ]);
    const money = projectBenefitMoney(result, lines, 2);
    expect(money).toMatchObject({
      originalMinor: 300n,
      resultMinor: 167n,
      discountMinor: 133n,
    });
    expect([...money.lines]).toEqual([
      // Both exact balances have remainder 1/3 cent; canonical A wins the cent.
      ['A', { resultMinor: 34n, discountMinor: 66n }],
      ['B', { resultMinor: 133n, discountMinor: 67n }],
    ]);
  });
  it('breaks equal remainders by canonical key and is independent of input order', () => {
    const lines = [line('B', '0.01'), line('A', '0.01')];
    const promotions = [campaign('half', '50', ['A', 'B'], 'PORCENTAJE')];
    const money = projectBenefitMoney(
      composeBenefits(lines, promotions),
      lines,
      2,
    );
    expect(money.resultMinor).toBe(1n);
    expect(money.lines.get('A')?.resultMinor).toBe(1n);
    expect(money.lines.get('B')?.resultMinor).toBe(0n);
    const reverse = [...lines].reverse();
    expect(
      projectBenefitMoney(composeBenefits(reverse, promotions), reverse, 2),
    ).toEqual(money);
  });
  it('rounds half up at the total, including one line and complete discounts', () => {
    const lines = [line('A', '0.01')];
    expect(
      projectBenefitMoney(
        composeBenefits(lines, [campaign('half', '50', ['A'], 'PORCENTAJE')]),
        lines,
        2,
      ).resultMinor,
    ).toBe(1n);
    expect(
      projectBenefitMoney(
        composeBenefits(lines, [campaign('all', '1', ['A'])]),
        lines,
        2,
      ),
    ).toMatchObject({ resultMinor: 0n, discountMinor: 1n });
  });
  it('conserves every cent across varying tiny baskets and successive overlapping benefits', () => {
    for (let a = 1; a <= 9; a++)
      for (let b = 1; b <= 9; b++)
        for (const percent of ['10', '33', '99']) {
          const lines = [line('A', `0.0${a}`), line('B', `0.0${b}`)];
          const result = composeBenefits(lines, [
            campaign('fixed', '0.01', ['A', 'B']),
            {
              ...campaign('percent', percent, ['B'], 'PORCENTAJE'),
              priority: 2,
            },
          ]);
          const money = projectBenefitMoney(result, lines, 2);
          expect(money.originalMinor).toBe(BigInt(a + b));
          expect(money.discountMinor + money.resultMinor).toBe(
            money.originalMinor,
          );
          expect(
            [...money.lines.values()].reduce((s, l) => s + l.resultMinor, 0n),
          ).toBe(money.resultMinor);
          expect(
            [...money.lines.values()].reduce((s, l) => s + l.discountMinor, 0n),
          ).toBe(money.discountMinor);
          expect(
            [...money.lines.values()].every(
              (l) => l.resultMinor >= 0n && l.discountMinor >= 0n,
            ),
          ).toBe(true);
        }
  });
  it('requires representable original and offer prices and an explicit scale', () => {
    for (const lines of [
      [line('A', '1.001')],
      [{ ...line('A', '2'), offerSubtotal: '1.001' }],
    ]) {
      expect(() =>
        projectBenefitMoney(composeBenefits(lines, []), lines, 2),
      ).toThrow('Price not representable');
    }
    const lines = [line('A', '1')],
      result = composeBenefits(lines, []);
    for (const scale of [NaN, -1, 0.5, 7])
      expect(() => projectBenefitMoney(result, lines, scale)).toThrow(
        'Explicit monetary scale',
      );
    expect(() =>
      projectBenefitMoney({ ...result, balances: new Map() }, lines, 2),
    ).toThrow('Incoherent monetary lines');
  });
  it('fails the entire exact search when candidate, line or work budgets are exceeded', () => {
    const lines = [line('A', '100')];
    expect(() =>
      composeBenefits(
        lines,
        Array.from({ length: 13 }, (_, i) => campaign(String(i), '1', ['A'])),
      ),
    ).toThrow(CompositionBudgetExceeded);
    expect(() =>
      composeBenefits(
        Array.from({ length: 101 }, (_, i) => line(String(i), '1')),
        [],
      ),
    ).toThrow(CompositionBudgetExceeded);
    expect(() =>
      composeBenefits(lines, [campaign('a', '1', ['A'])], {
        maxWork: 3,
        milliseconds: 100,
      }),
    ).toThrow(CompositionBudgetExceeded);
    expect(() =>
      composeBenefits(lines, [], { maxWork: 250001, milliseconds: 100 }),
    ).toThrow('Invalid composition budget');
  });
  it('uses monotonic elapsed time and refuses late computation, never a partial winner', () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(101);
    expect(() => composeBenefits([line('A', '1')], [])).toThrow(
      CompositionBudgetExceeded,
    );
  });
});
