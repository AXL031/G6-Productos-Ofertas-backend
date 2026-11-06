import { describe, expect, it } from 'vitest';
import { selectHistoricalValidity } from './historical-price.js';
const validity = {
  id: 'real-validity',
  precioRegular: '125.50',
  precioOferta: '120.00',
  currency: 'PEN',
  motivoCambio: 'HISTORICO',
  usuarioId: 'original',
  validFrom: new Date('2000-01-01Z'),
  validUntil: null,
  priceVersion: 3n,
  isCancelled: false,
};
describe('Selección histórica sin mutaciones', () => {
  it('devuelve el objeto original y compara centavos exactos sin exigir motivo de alta', () => {
    expect(selectHistoricalValidity([validity], 'PEN', '125.5')).toBe(validity);
    expect(selectHistoricalValidity([validity], 'PEN', undefined)).toBe(
      validity,
    );
  });
  it.each([
    { precioRegular: '125.501' },
    { currency: 'PENN' },
    { precioOferta: '0' },
    { precioRegular: '0' },
    { precioRegular: 'NaN' },
    { precioOferta: '126' },
    { currency: 'USD' },
    { currency: '   ' },
    { priceVersion: 0n },
    { priceVersion: 9007199254740992n },
  ])('rechaza selección inválida %#', (changes) => {
    const candidate = { ...validity, ...changes };
    const before = { ...candidate };
    expect(
      selectHistoricalValidity([candidate], 'PEN', undefined),
    ).toBeUndefined();
    expect(candidate).toEqual(before);
  });
  it('cero o múltiples elegibles no tienen selección arbitraria', () => {
    expect(selectHistoricalValidity([], 'PEN', undefined)).toBeUndefined();
    expect(
      selectHistoricalValidity(
        [validity, { ...validity, id: 'second' }],
        'PEN',
        undefined,
      ),
    ).toBeUndefined();
  });
  it('importe exacto distinto o inválido es conflicto, sin tolerancia', () => {
    for (const amount of ['125.51', '125.5001', '-1', '0'])
      expect(
        selectHistoricalValidity([validity], 'PEN', amount),
      ).toBeUndefined();
  });
  it('admite el máximo entero seguro sin cambiar el snapshot', () => {
    const last = { ...validity, priceVersion: BigInt(Number.MAX_SAFE_INTEGER) };
    expect(selectHistoricalValidity([last], 'PEN', undefined)).toBe(last);
  });
});
