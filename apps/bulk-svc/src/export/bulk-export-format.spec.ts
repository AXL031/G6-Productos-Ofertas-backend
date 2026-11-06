import { randomUUID } from 'node:crypto';
import {
  consolidateExportRows,
  createExportCsv,
  createExportXlsx,
  type ExportSnapshot,
} from './bulk-export-format.js';

const snapshot: ExportSnapshot = {
  requestedAt: '2026-11-05T00:00:00.000Z',
  catalogObservedAt: '2026-11-05T00:00:01.000Z',
  pricingObservedAt: '2026-11-05T00:00:02.000Z',
  inventoryObservedAt: '2026-11-05T00:00:03.000Z',
  catalogVersion: 'cat-1',
  pricingVersion: 'price-1',
  inventoryVersion: 'inv-1',
};

describe('Bulk export format and consolidation', () => {
  it('joins parent price to each sellable SKU and expands inventory by location', () => {
    const productId = randomUUID();
    const data = consolidateExportRows({
      catalog: [
        {
          productId,
          skuBase: 'PARENT',
          variantSku: null,
          name: 'Simple',
          description: null,
          categoryId: 'c',
          brandId: 'b',
          productTypeId: 't',
        },
        {
          productId,
          skuBase: 'PARENT',
          variantSku: 'VAR-M',
          name: '=FORMULA()',
          description: 'niño, 東京',
          categoryId: 'c',
          brandId: 'b',
          productTypeId: 't',
        },
      ],
      prices: [
        {
          productId,
          sku: null,
          regular: 10.5,
          offer: 8,
          offerStartsAt: '2026-11-01T00:00:00Z',
          offerEndsAt: '2026-11-30T00:00:00Z',
        },
      ],
      stock: [
        { sku: 'PARENT', locationId: 'L1', onHand: 5, reserved: 1, blocked: 0 },
        { sku: 'VAR-M', locationId: 'L1', onHand: 3, reserved: 0, blocked: 0 },
        { sku: 'VAR-M', locationId: 'L2', onHand: 7, reserved: 2, blocked: 1 },
      ],
      snapshot,
    });
    expect(data).toHaveLength(3);
    expect(
      data
        .filter((row) => row.productId === productId)
        .map((row) => row.price?.regular),
    ).toEqual([10.5, 10.5, 10.5]);
    const csv = createExportCsv(data).toString('utf8');
    expect(csv).toContain("'=FORMULA()");
    expect(csv).toContain('niño, 東京');
    expect(csv).toContain('2026-11-05T00:00:00.000Z');
    expect(createExportXlsx(data).subarray(0, 4).toString('hex')).toBe(
      '504b0304',
    );
    expect(createExportXlsx(data).toString('utf8')).toContain('niño, 東京');
    expect(createExportXlsx(data).toString('utf8')).toContain(
      '&apos;=FORMULA()',
    );
  });

  it('rejects duplicate identities and incompatible provider records', () => {
    const productId = randomUUID();
    const product = {
      productId,
      skuBase: 'PARENT',
      variantSku: null,
      name: 'Name',
      description: null,
      categoryId: 'c',
      brandId: 'b',
      productTypeId: 't',
    };
    expect(() =>
      consolidateExportRows({
        catalog: [product, product],
        prices: [],
        stock: [],
        snapshot,
      }),
    ).toThrow('Duplicate sellable SKU identity');
    expect(() =>
      consolidateExportRows({
        catalog: [product],
        prices: [],
        stock: [
          { sku: 'ALIEN', locationId: 'L', onHand: 1, reserved: 0, blocked: 0 },
        ],
        snapshot,
      }),
    ).toThrow('Inventory export DTO is incompatible');
  });

  it('applies SKU price overrides, strips XML-forbidden characters, and bounds rows', () => {
    const productId = randomUUID();
    const base = {
      productId,
      skuBase: 'BASE',
      variantSku: null,
      name: 'A\u0001B',
      description: null,
      categoryId: 'c',
      brandId: 'b',
      productTypeId: 't',
    };
    const rows = consolidateExportRows({
      catalog: [base],
      prices: [
        {
          productId,
          sku: null,
          regular: 10,
          offer: null,
          offerStartsAt: null,
          offerEndsAt: null,
        },
        {
          productId: null,
          sku: 'BASE',
          regular: 7,
          offer: null,
          offerStartsAt: null,
          offerEndsAt: null,
        },
      ],
      stock: [],
      snapshot,
    });
    expect(rows[0]?.price?.regular).toBe(7);
    const xlsx = createExportXlsx(rows);
    const sheetName = Buffer.from('xl/worksheets/sheet1.xml');
    const sheetNameOffset = xlsx.indexOf(sheetName);
    const sheetStart = sheetNameOffset + sheetName.length;
    const sheetLength = xlsx.readUInt32LE(sheetNameOffset - 30 + 18);
    const sheetXml = xlsx
      .subarray(sheetStart, sheetStart + sheetLength)
      .toString('utf8');
    expect(sheetXml).toContain('<t xml:space="preserve">AB</t>');
    expect(() =>
      createExportCsv(Array.from({ length: 100_001 }, () => rows[0]!)),
    ).toThrow('Export exceeds the configured safe row limit');
  });

  it('keeps a parent price and one variant override without treating the override as a duplicate parent', () => {
    const productId = randomUUID();
    const catalog = ['PARENT', 'VAR-01', 'VAR-02'].map((sku) => ({
      productId,
      skuBase: 'PARENT',
      variantSku: sku === 'PARENT' ? null : sku,
      name: sku,
      description: null,
      categoryId: 'c',
      brandId: 'b',
      productTypeId: 't',
    }));
    const rows = consolidateExportRows({
      catalog,
      prices: [
        {
          productId,
          sku: null,
          regular: 100,
          offer: null,
          offerStartsAt: null,
          offerEndsAt: null,
        },
        {
          productId,
          sku: 'VAR-01',
          regular: 80,
          offer: null,
          offerStartsAt: null,
          offerEndsAt: null,
        },
      ],
      stock: [],
      snapshot,
    });
    expect(
      rows.map((row) => [row.variantSku ?? row.skuBase, row.price?.regular]),
    ).toEqual([
      ['PARENT', 100],
      ['VAR-01', 80],
      ['VAR-02', 100],
    ]);
    expect(() =>
      consolidateExportRows({
        catalog,
        prices: [
          {
            productId,
            sku: null,
            regular: 100,
            offer: null,
            offerStartsAt: null,
            offerEndsAt: null,
          },
          {
            productId,
            sku: 'VAR-01',
            regular: 80,
            offer: null,
            offerStartsAt: null,
            offerEndsAt: null,
          },
          {
            productId,
            sku: 'VAR-01',
            regular: 70,
            offer: null,
            offerStartsAt: null,
            offerEndsAt: null,
          },
        ],
        stock: [],
        snapshot,
      }),
    ).toThrow('Duplicate price SKU identity');
    expect(() =>
      consolidateExportRows({
        catalog,
        prices: [
          {
            productId: randomUUID(),
            sku: 'VAR-01',
            regular: 80,
            offer: null,
            offerStartsAt: null,
            offerEndsAt: null,
          },
        ],
        stock: [],
        snapshot,
      }),
    ).toThrow('Pricing export DTO is incompatible');
  });
});
