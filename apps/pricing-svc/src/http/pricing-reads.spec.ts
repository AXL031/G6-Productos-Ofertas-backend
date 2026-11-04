import { wireMoney, wireVersion } from './pricing-reads.js';

describe('Versiones en JSON contractual', () => {
  it('nunca redondea una versión bigint que el cliente no pueda reenviar exactamente', () => {
    expect(wireVersion(1n)).toBe(1);
    expect(wireVersion(BigInt(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    for (const value of [0n, BigInt(Number.MAX_SAFE_INTEGER) + 1n])
      expect(() => wireVersion(value)).toThrow('ERROR_INTERNO');
  });
});

describe('Importes en JSON contractual', () => {
  it.each([
    ['0.01', 0.01],
    ['0.29', 0.29],
    ['12.30', 12.3],
    ['9999999999.99', 9999999999.99],
  ] as const)(
    'conserva los centavos de %s al serializar y volver a leer JSON',
    (value, expected) => {
      const numeric: unknown = JSON.parse(JSON.stringify(wireMoney(value)));
      expect(typeof numeric).toBe('number');
      expect(numeric).toBe(expected);
    },
  );

  it.each([
    '0',
    '-1',
    'NaN',
    'Infinity',
    '1e2',
    '1.001',
    '10000000000.00',
    '9007199254740993',
    ' 12.30',
    '',
  ])(
    'rechaza %s sin convertir ausencia, precisión o desborde en un precio',
    (value) => {
      expect(() => wireMoney(value)).toThrow('ERROR_INTERNO');
    },
  );
});
