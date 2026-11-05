import type {
  ExportCatalogRecord,
  ExportPriceRecord,
  ExportStockRecord,
} from './bulk-export-source.js';

export interface ExportSnapshot {
  requestedAt: string;
  catalogObservedAt: string;
  pricingObservedAt: string;
  inventoryObservedAt: string;
  catalogVersion: string;
  pricingVersion: string;
  inventoryVersion: string;
}

export type ExportDataRow = ExportCatalogRecord & {
  price: ExportPriceRecord | null;
  stock: ExportStockRecord | null;
  snapshot: ExportSnapshot;
};

export const EXPORT_HEADERS = [
  'product_id',
  'sku_base',
  'sku_variant',
  'name',
  'description',
  'category_id',
  'brand_id',
  'product_type_id',
  'regular_price',
  'offer_price',
  'offer_starts_at',
  'offer_ends_at',
  'location_id',
  'stock_on_hand',
  'stock_reserved',
  'stock_blocked',
  'stock_available',
  'requested_at',
  'catalog_observed_at',
  'pricing_observed_at',
  'inventory_observed_at',
  'catalog_version',
  'pricing_version',
  'inventory_version',
] as const;

function safeText(value: string | null): string {
  const normalized = value ?? '';
  return /^[\t\r\n ]*[=+@-]/.test(normalized) ? `'${normalized}` : normalized;
}

function cell(
  row: ExportDataRow,
  header: (typeof EXPORT_HEADERS)[number],
): string | number {
  const price = row.price;
  const stock = row.stock;
  switch (header) {
    case 'product_id':
      return safeText(row.productId);
    case 'sku_base':
      return safeText(row.skuBase);
    case 'sku_variant':
      return safeText(row.variantSku);
    case 'name':
      return safeText(row.name);
    case 'description':
      return safeText(row.description);
    case 'category_id':
      return safeText(row.categoryId);
    case 'brand_id':
      return safeText(row.brandId);
    case 'product_type_id':
      return safeText(row.productTypeId);
    case 'regular_price':
      return price?.regular ?? '';
    case 'offer_price':
      return price?.offer ?? '';
    case 'offer_starts_at':
      return safeText(price?.offerStartsAt ?? null);
    case 'offer_ends_at':
      return safeText(price?.offerEndsAt ?? null);
    case 'location_id':
      return safeText(stock?.locationId ?? null);
    case 'stock_on_hand':
      return stock?.onHand ?? '';
    case 'stock_reserved':
      return stock?.reserved ?? '';
    case 'stock_blocked':
      return stock?.blocked ?? '';
    case 'stock_available':
      return stock ? stock.onHand - stock.reserved - stock.blocked : '';
    case 'requested_at':
      return row.snapshot.requestedAt;
    case 'catalog_observed_at':
      return row.snapshot.catalogObservedAt;
    case 'pricing_observed_at':
      return row.snapshot.pricingObservedAt;
    case 'inventory_observed_at':
      return row.snapshot.inventoryObservedAt;
    case 'catalog_version':
      return row.snapshot.catalogVersion;
    case 'pricing_version':
      return row.snapshot.pricingVersion;
    case 'inventory_version':
      return row.snapshot.inventoryVersion;
  }
}

function csvField(value: string | number): string {
  const source = String(value);
  return `"${source.replaceAll('"', '""')}"`;
}

export function createExportCsv(rows: ExportDataRow[]): Buffer {
  assertExportRowLimit(rows.length);
  const lines = [EXPORT_HEADERS.map(csvField).join(',')];
  for (const row of rows)
    lines.push(
      EXPORT_HEADERS.map((header) => csvField(cell(row, header))).join(','),
    );
  return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
}

function xml(value: string): string {
  const xmlSafe = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0)!;
      return (
        codePoint === 0x9 ||
        codePoint === 0xa ||
        codePoint === 0xd ||
        (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
        (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
        (codePoint >= 0x10000 && codePoint <= 0x10ffff)
      );
    })
    .join('');
  return xmlSafe
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function columnName(index: number): string {
  let number = index + 1;
  let name = '';
  while (number > 0) {
    number -= 1;
    name = String.fromCharCode(65 + (number % 26)) + name;
    number = Math.floor(number / 26);
  }
  return name;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.content);
    const header = Buffer.alloc(30 + name.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(entry.content.length, 18);
    header.writeUInt32LE(entry.content.length, 22);
    header.writeUInt16LE(name.length, 26);
    name.copy(header, 30);
    local.push(header, entry.content);
    const directory = Buffer.alloc(46 + name.length);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(entry.content.length, 20);
    directory.writeUInt32LE(entry.content.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    name.copy(directory, 46);
    central.push(directory);
    offset += header.length + entry.content.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

export function createExportXlsx(rows: ExportDataRow[]): Buffer {
  assertExportRowLimit(rows.length);
  const matrix: Array<Array<string | number>> = [
    [...EXPORT_HEADERS],
    ...rows.map((row) => EXPORT_HEADERS.map((header) => cell(row, header))),
  ];
  const sheetRows = matrix
    .map((row, rowIndex) => {
      const cells = row
        .map((value, colIndex) => {
          const ref = `${columnName(colIndex)}${rowIndex + 1}`;
          if (typeof value === 'number' && Number.isFinite(value))
            return `<c r="${ref}"><v>${value}</v></c>`;
          const text = safeText(String(value));
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');
  const files = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ],
    [
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Productos" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ],
    [
      'xl/worksheets/sheet1.xml',
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
    ],
  ] as const;
  return zip(
    files.map(([name, content]) => ({
      name,
      content: Buffer.from(content, 'utf8'),
    })),
  );
}

export function consolidateExportRows(input: {
  catalog: ExportCatalogRecord[];
  prices: ExportPriceRecord[];
  stock: ExportStockRecord[];
  snapshot: ExportSnapshot;
}): ExportDataRow[] {
  const hasKeys = (
    value: unknown,
    expected: string[],
  ): value is Record<string, unknown> =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
  const validNullableText = (value: unknown): value is string | null =>
    value === null || (typeof value === 'string' && value.length > 0);
  const productIds = new Set<string>();
  const skuIds = new Set<string>();
  const productBySku = new Map<string, string>();
  for (const item of input.catalog) {
    if (
      !hasKeys(item, [
        'productId',
        'skuBase',
        'variantSku',
        'name',
        'description',
        'categoryId',
        'brandId',
        'productTypeId',
      ]) ||
      ![
        item.productId,
        item.skuBase,
        item.name,
        item.categoryId,
        item.brandId,
        item.productTypeId,
      ].every((v) => typeof v === 'string' && v.length > 0) ||
      !validNullableText(item.variantSku) ||
      !validNullableText(item.description)
    )
      throw new Error('Catalog export DTO is incompatible');
    const sku = item.variantSku ?? item.skuBase;
    if (skuIds.has(sku)) throw new Error('Duplicate sellable SKU identity');
    skuIds.add(sku);
    productIds.add(item.productId);
    productBySku.set(sku, item.productId);
  }
  const productPrices = new Map<string, ExportPriceRecord>();
  const skuPrices = new Map<string, ExportPriceRecord>();
  const requestedAt = Date.parse(input.snapshot.requestedAt);
  if (!Number.isFinite(requestedAt))
    throw new Error('Export requested_at is invalid');
  for (const price of input.prices) {
    if (
      !hasKeys(price, [
        'productId',
        'sku',
        'regular',
        'offer',
        'offerStartsAt',
        'offerEndsAt',
      ]) ||
      !(typeof price.productId === 'string' || price.productId === null) ||
      !(typeof price.sku === 'string' || price.sku === null) ||
      (price.productId === null && price.sku === null) ||
      (price.productId !== null && !productIds.has(price.productId)) ||
      (price.sku !== null && !skuIds.has(price.sku)) ||
      (price.productId !== null &&
        price.sku !== null &&
        productBySku.get(price.sku) !== price.productId) ||
      ![price.regular, price.offer].every(
        (value) =>
          value === null ||
          (typeof value === 'number' && Number.isFinite(value) && value >= 0),
      ) ||
      ![price.offerStartsAt, price.offerEndsAt].every(
        (value) =>
          value === null ||
          (typeof value === 'string' && Number.isFinite(Date.parse(value))),
      )
    )
      throw new Error('Pricing export DTO is incompatible');
    if (price.offer !== null) {
      const startsAt =
        price.offerStartsAt === null ? NaN : Date.parse(price.offerStartsAt);
      const endsAt =
        price.offerEndsAt === null ? NaN : Date.parse(price.offerEndsAt);
      if (
        !Number.isFinite(startsAt) ||
        !Number.isFinite(endsAt) ||
        startsAt > requestedAt ||
        endsAt < requestedAt ||
        startsAt > endsAt
      )
        throw new Error(
          'Pricing export contains an offer outside requested_at',
        );
    }
    // A record tied to a SKU is a SKU price even when Pricing includes its
    // owning productId. Only product-only records participate in inheritance.
    if (price.productId !== null && price.sku === null) {
      if (productPrices.has(price.productId))
        throw new Error('Duplicate price parent identity');
      productPrices.set(price.productId, price);
    }
    if (price.sku !== null) {
      if (skuPrices.has(price.sku))
        throw new Error('Duplicate price SKU identity');
      skuPrices.set(price.sku, price);
    }
  }
  const stockByIdentity = new Set<string>();
  const stockBySku = new Map<string, ExportStockRecord[]>();
  for (const item of input.stock) {
    if (
      !hasKeys(item, ['sku', 'locationId', 'onHand', 'reserved', 'blocked']) ||
      typeof item.sku !== 'string' ||
      !skuIds.has(item.sku) ||
      typeof item.locationId !== 'string' ||
      item.locationId.length === 0 ||
      ![item.onHand, item.reserved, item.blocked].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ) ||
      item.reserved + item.blocked > item.onHand
    )
      throw new Error('Inventory export DTO is incompatible');
    const key = `${item.sku}\u0000${item.locationId}`;
    if (stockByIdentity.has(key))
      throw new Error('Duplicate inventory SKU/location identity');
    stockByIdentity.add(key);
    const balances = stockBySku.get(item.sku) ?? [];
    balances.push(item);
    stockBySku.set(item.sku, balances);
  }
  const rows: ExportDataRow[] = [];
  const seen = new Set<string>();
  for (const product of input.catalog) {
    const key = `${product.productId}\u0000${product.variantSku ?? product.skuBase}`;
    if (seen.has(key)) throw new Error('Duplicate catalog SKU identity');
    seen.add(key);
    const sku = product.variantSku ?? product.skuBase;
    const balances = stockBySku.get(sku) ?? [];
    const price =
      skuPrices.get(sku) ?? productPrices.get(product.productId) ?? null;
    if (balances.length === 0)
      rows.push({
        ...product,
        price,
        stock: null,
        snapshot: input.snapshot,
      });
    else
      for (const balance of balances)
        rows.push({
          ...product,
          price,
          stock: balance,
          snapshot: input.snapshot,
        });
  }
  return rows;
}

const MAX_EXPORT_ROWS = 100_000;

function assertExportRowLimit(count: number): void {
  if (count > MAX_EXPORT_ROWS)
    throw new Error('Export exceeds the configured safe row limit');
}
