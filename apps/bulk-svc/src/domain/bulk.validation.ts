import { BulkDomainError } from './bulk.errors.js';

export const BULK_TEMPLATE_VERSION = 2 as const;
export type BulkImportFormat = 'CSV' | 'XLSX';

/** Internal normalized representation. This does not parse or certify raw CSV/XLSX files. */
export interface NormalizedBulkRow {
  rowId: string;
  productId: string | null;
  mode?: 'ALTA' | 'ACTUALIZACION';
  skuIdentityRequired?: boolean;
  skuBase?: string | null;
  variantSkus?: string[];
  precioRegular?: number | null;
  stockInicial?: number | null;
  defaultLocationId?: string | null;
}

export interface ValidatedBulkRow extends NormalizedBulkRow {
  requiredDomains: Array<'CATALOGO' | 'PRICING' | 'INVENTARIO'>;
  vendibleSkus: string[];
  inventoryAdjustment: 'NOT_REQUIRED' | 'REQUIRED' | 'LOCATION_MISSING';
}

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(message: string): never {
  throw new BulkDomainError('INVALID_INPUT', message);
}

function nonNegativeInteger(
  value: number | null | undefined,
  field: string,
): void {
  if (
    value !== null &&
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < 0)
  ) {
    invalid(`${field} debe ser un entero no negativo representable.`);
  }
}

export function validateBulkImport(input: {
  format: string;
  templateVersion: number;
  rows: NormalizedBulkRow[];
}): ValidatedBulkRow[] {
  if (input.format !== 'CSV' && input.format !== 'XLSX')
    invalid('Formato de importación no permitido.');
  if (input.templateVersion !== BULK_TEMPLATE_VERSION)
    invalid('La versión de plantilla debe ser 2.');
  if (!Array.isArray(input.rows) || input.rows.length === 0)
    invalid('La importación debe contener filas.');

  const seenSkus = new Set<string>();
  return input.rows.map((row) => {
    if (
      !row ||
      !uuid.test(row.rowId) ||
      (row.mode === undefined
        ? typeof row.productId !== 'string' || !uuid.test(row.productId)
        : row.mode === 'ALTA'
          ? row.productId !== null
          : typeof row.productId !== 'string' || row.productId.length === 0)
    )
      invalid('La fila o el producto tiene identificador malformado.');
    if (!Array.isArray(row.variantSkus))
      invalid('La estructura de variantes está incompleta.');
    if (row.defaultLocationId != null && !uuid.test(row.defaultLocationId))
      invalid('default_location_id tiene formato inválido.');
    nonNegativeInteger(row.stockInicial, 'stock_inicial');
    if (
      row.precioRegular != null &&
      (!Number.isFinite(row.precioRegular) || row.precioRegular < 0)
    )
      invalid('precio_regular no es representable.');

    const skus =
      row.variantSkus.length > 0
        ? row.variantSkus
        : row.skuIdentityRequired === false
          ? []
          : row.skuBase
            ? [row.skuBase]
            : [];
    if (skus.length === 0 && row.skuIdentityRequired !== false)
      invalid('La fila no contiene un SKU vendible.');
    for (const sku of skus) {
      if (typeof sku !== 'string' || sku.length === 0)
        invalid('SKU incompleto.');
      if (seenSkus.has(sku)) invalid('SKU repetido en la importación.');
      seenSkus.add(sku);
    }
    const stock = row.stockInicial ?? 0;
    const inventoryAdjustment =
      stock === 0
        ? 'NOT_REQUIRED'
        : row.defaultLocationId
          ? 'REQUIRED'
          : 'LOCATION_MISSING';
    return {
      ...row,
      vendibleSkus: skus,
      requiredDomains: [
        'CATALOGO',
        ...(row.precioRegular == null ? [] : ['PRICING' as const]),
        'INVENTARIO',
      ],
      inventoryAdjustment,
    };
  });
}
