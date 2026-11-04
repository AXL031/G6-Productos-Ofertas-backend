// Exact finite decimal arithmetic; no monetary scale or rounding is invented.
export class Decimal {
  private constructor(
    readonly coefficient: bigint,
    readonly scale: number,
  ) {}
  static from(value: string | number): Decimal {
    const raw = String(value);
    const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(raw);
    if (!m || raw.length > 1024) throw new Error('INVALID_DECIMAL');
    const exponent = Number(m[4] ?? 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1024)
      throw new Error('INVALID_DECIMAL');
    const fraction = m[3] ?? '';
    const scale = fraction.length - exponent;
    const coefficient = BigInt((m[1] === '-' ? '-' : '') + m[2] + fraction);
    return scale < 0
      ? new Decimal(coefficient * 10n ** BigInt(-scale), 0)
      : new Decimal(coefficient, scale);
  }
  private align(other: Decimal): [bigint, bigint, number] {
    const scale = Math.max(this.scale, other.scale);
    return [
      this.coefficient * 10n ** BigInt(scale - this.scale),
      other.coefficient * 10n ** BigInt(scale - other.scale),
      scale,
    ];
  }
  add(other: Decimal): Decimal {
    const [a, b, s] = this.align(other);
    return new Decimal(a + b, s);
  }
  subtract(other: Decimal): Decimal {
    const [a, b, s] = this.align(other);
    return new Decimal(a - b, s);
  }
  multiply(other: Decimal): Decimal {
    return new Decimal(
      this.coefficient * other.coefficient,
      this.scale + other.scale,
    );
  }
  percent(value: Decimal): Decimal {
    const result = this.multiply(value);
    return new Decimal(result.coefficient, result.scale + 2);
  }
  compare(other: Decimal): number {
    const [a, b] = this.align(other);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  min(other: Decimal): Decimal {
    return this.compare(other) <= 0 ? this : other;
  }
  toString(): string {
    const sign = this.coefficient < 0n ? '-' : '';
    const digits = (
      this.coefficient < 0n ? -this.coefficient : this.coefficient
    )
      .toString()
      .padStart(this.scale + 1, '0');
    return (
      sign +
      (this.scale
        ? digits.slice(0, -this.scale) + '.' + digits.slice(-this.scale)
        : digits)
    );
  }
  toNumber(): number {
    const n = Number(this.toString());
    if (!Number.isFinite(n) || (n === 0 && this.coefficient !== 0n))
      throw new Error('DECIMAL_OUT_OF_HTTP_RANGE');
    return n;
  }
}
