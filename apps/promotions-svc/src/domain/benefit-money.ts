import {
  ExactAmount,
  type ProposalLine,
  type ProposalResult,
} from './benefit-composition.js';

/** Internal projection of approved policy v1. Scale is explicit; this is not an
 * HTTP DTO or an adopted currency registry. Never round intermediate benefits. */
export function projectBenefitMoney(
  evaluation: ProposalResult,
  lines: readonly ProposalLine[],
  scale: number,
) {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 6)
    throw new RangeError('Explicit monetary scale required');
  if (
    !lines.length ||
    lines.length > 100 ||
    new Set(lines.map((l) => l.key)).size !== lines.length ||
    evaluation.balances.size !== lines.length
  )
    throw new RangeError('Incoherent monetary lines');
  const factor = 10n ** BigInt(scale);
  const exactUnits = (input: string) => {
    if (input.length > 128) throw new RangeError('Amount input too long');
    const value = ExactAmount.from(input);
    const scaled = value.numerator * factor;
    if (scaled < 0n || scaled % value.denominator !== 0n)
      throw new RangeError('Price not representable at monetary scale');
    return scaled / value.denominator;
  };
  const entries = lines.map((line) => {
    const original = exactUnits(line.regularSubtotal);
    if (exactUnits(line.offerSubtotal ?? line.regularSubtotal) > original)
      throw new RangeError('Incoherent offer');
    const balance = evaluation.balances.get(line.key);
    if (
      !balance ||
      balance.numerator < 0n ||
      balance.compare(ExactAmount.from(line.regularSubtotal)) > 0
    )
      throw new RangeError('Incoherent residual balance');
    const scaled = balance.numerator * factor;
    return {
      key: line.key,
      original,
      units: scaled / balance.denominator,
      remainder: scaled % balance.denominator,
      denominator: balance.denominator,
      balance,
    };
  });
  const original = entries.reduce((a, b) => a + b.original, 0n);
  const sum = entries.reduce((a, b) => a.add(b.balance), ExactAmount.from('0'));
  if (
    sum.compare(evaluation.result) !== 0 ||
    evaluation.original.numerator * factor !==
      original * evaluation.original.denominator ||
    evaluation.result.add(evaluation.discount).compare(evaluation.original) !==
      0
  )
    throw new RangeError('Nonconserving evaluation');
  const scaled = sum.numerator * factor;
  const result =
    scaled / sum.denominator +
    (2n * (scaled % sum.denominator) >= sum.denominator ? 1n : 0n);
  let remaining = result - entries.reduce((a, b) => a + b.units, 0n);
  const ordered = [...entries].sort((a, b) => {
    const difference =
      a.remainder * b.denominator - b.remainder * a.denominator;
    return difference > 0n
      ? -1
      : difference < 0n
        ? 1
        : a.key < b.key
          ? -1
          : a.key > b.key
            ? 1
            : 0;
  });
  for (const entry of ordered) {
    if (remaining === 0n) break;
    entry.units++;
    remaining--;
  }
  if (
    remaining !== 0n ||
    result > original ||
    entries.some((e) => e.units > e.original)
  )
    throw new RangeError('Nonconserving monetary projection');
  return {
    scale,
    originalMinor: original,
    resultMinor: result,
    discountMinor: original - result,
    lines: new Map(
      entries
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((e) => [
          e.key,
          { resultMinor: e.units, discountMinor: e.original - e.units },
        ]),
    ),
  };
}
