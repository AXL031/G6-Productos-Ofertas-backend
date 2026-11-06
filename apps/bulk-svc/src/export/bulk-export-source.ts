export const BULK_EXPORT_SOURCE = Symbol('BULK_EXPORT_SOURCE');

export interface ExportCatalogRecord {
  productId: string;
  skuBase: string;
  variantSku: string | null;
  name: string;
  description: string | null;
  categoryId: string;
  brandId: string;
  productTypeId: string;
}

export interface ExportPriceRecord {
  productId: string | null;
  sku: string | null;
  regular: number | null;
  offer: number | null;
  offerStartsAt: string | null;
  offerEndsAt: string | null;
}

export interface ExportStockRecord {
  sku: string;
  locationId: string;
  onHand: number;
  reserved: number;
  blocked: number;
}

export interface ExportPage<T> {
  items: T[];
  nextCursor: string | null;
  observedAt: string;
  version: string;
}

/** Internal application port. Production must bind a contract-approved adapter. */
export interface BulkExportSource {
  catalog(
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<ExportPage<ExportCatalogRecord>>;
  pricing(
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
    at: string,
  ): Promise<ExportPage<ExportPriceRecord>>;
  inventory(
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<ExportPage<ExportStockRecord>>;
}
