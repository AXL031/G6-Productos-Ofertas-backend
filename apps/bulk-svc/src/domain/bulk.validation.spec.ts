import { describe, expect, it } from 'vitest';
import { BulkDomainError } from './bulk.errors.js';
import { validateBulkImport } from './bulk.validation.js';

const row = (overrides: Record<string, unknown> = {}) => ({
  rowId: '11111111-1111-4111-8111-111111111111',
  productId: '22222222-2222-4222-8222-222222222222',
  skuBase: 'SKU-1',
  variantSkus: [],
  stockInicial: 0,
  defaultLocationId: null,
  ...overrides,
});

describe('bulk import validation', () => {
  it('accepts CSV/XLSX v2 and allows identity initialization without a location at zero stock', () => {
    for (const format of ['CSV', 'XLSX']) {
      expect(
        validateBulkImport({ format, templateVersion: 2, rows: [row()] })[0]
          ?.inventoryAdjustment,
      ).toBe('NOT_REQUIRED');
    }
  });

  it('requires a location only for a positive initial stock adjustment', () => {
    expect(
      validateBulkImport({
        format: 'CSV',
        templateVersion: 2,
        rows: [row({ stockInicial: 2 })],
      })[0]?.inventoryAdjustment,
    ).toBe('LOCATION_MISSING');
  });

  it('rejects unsupported format, template version, malformed identifiers, duplicate SKUs and invalid quantities', () => {
    const base = { format: 'CSV', templateVersion: 2, rows: [row()] };
    for (const input of [
      { ...base, format: 'JSON' },
      { ...base, templateVersion: 1 },
      { ...base, rows: [row({ productId: 'bad' })] },
      {
        ...base,
        rows: [row(), row({ rowId: '33333333-3333-4333-8333-333333333333' })],
      },
      { ...base, rows: [row({ stockInicial: -1 })] },
      { ...base, rows: [row({ stockInicial: 1.5 })] },
    ])
      expect(() => validateBulkImport(input)).toThrow(BulkDomainError);
  });

  it('compares SKU identity exactly and does not impose pricing limits', () => {
    expect(
      validateBulkImport({
        format: 'CSV',
        templateVersion: 2,
        rows: [row({ precioRegular: 999999999 })],
      }),
    ).toHaveLength(1);
    expect(
      validateBulkImport({
        format: 'CSV',
        templateVersion: 2,
        rows: [
          row({ skuBase: 'sku-1' }),
          row({
            rowId: '33333333-3333-4333-8333-333333333333',
            skuBase: 'SKU-1',
          }),
        ],
      }),
    ).toHaveLength(2);
  });
});
