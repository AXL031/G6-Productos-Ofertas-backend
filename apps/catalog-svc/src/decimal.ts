/** Exact non-negative decimal comparison without expanding large exponents. */
export function compareDecimal(a: string | number, b: string | number): number {
  const parse = (input: string | number) => {
    const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(input));
    if (!match || !Number.isFinite(Number(input)))
      throw new Error('Invalid decimal');
    const digits = (match[1] + (match[2] ?? '')).replace(/^0+/, '');
    return {
      digits,
      exponent: BigInt(match[3] ?? 0) - BigInt(match[2]?.length ?? 0),
    };
  };
  const x = parse(a),
    y = parse(b);
  if (!x.digits || !y.digits) return x.digits ? 1 : y.digits ? -1 : 0;
  const orderX = BigInt(x.digits.length) + x.exponent;
  const orderY = BigInt(y.digits.length) + y.exponent;
  if (orderX !== orderY) return orderX > orderY ? 1 : -1;
  const length = Math.max(x.digits.length, y.digits.length);
  const dx = x.digits.padEnd(length, '0'),
    dy = y.digits.padEnd(length, '0');
  return dx === dy ? 0 : dx > dy ? 1 : -1;
}

/** Validate JSON first, then retain number lexemes before IEEE-754 can round money. */
export function parseDecimalJson(text: string): unknown {
  JSON.parse(text);
  return JSON.parse(
    text.replace(
      /"(?:\\.|[^"\\])*"|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (token: string, number?: string) =>
        number === undefined ? token : JSON.stringify(number),
    ),
  ) as unknown;
}
