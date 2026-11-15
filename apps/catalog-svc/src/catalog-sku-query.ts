import { eq, inArray, or } from 'drizzle-orm';
import type { CatalogTransaction } from './database.js';
import { products, skuIdentity, variants } from './catalog.schema.js';

export type CatalogSkuRecord = {
  sku: string;
  productId: string | null;
  productName: string | null;
  productStatus: string | null;
  productHasVariants: boolean | null;
  productTypeId: string | null;
  variantId: string | null;
  variantSku: string | null;
  variantStatus: string | null;
};

/** One parameterized Catalog-only lookup for a bounded, deduplicated SKU set. */
export function catalogSkuRecords(
  tx: CatalogTransaction,
  skus: readonly string[],
): Promise<CatalogSkuRecord[]> {
  const uniqueSkus = [...new Set(skus)];
  return tx
    .select({
      sku: skuIdentity.sku,
      productId: products.id,
      productName: products.nombre,
      productStatus: products.estado,
      productHasVariants: products.tiene_variantes,
      productTypeId: products.tipo_producto_id,
      variantId: variants.id,
      variantSku: variants.sku,
      variantStatus: variants.estado,
    })
    .from(skuIdentity)
    .leftJoin(variants, eq(skuIdentity.variant_id, variants.id))
    .leftJoin(
      products,
      or(
        eq(skuIdentity.product_id, products.id),
        eq(variants.product_id, products.id),
      ),
    )
    .where(inArray(skuIdentity.sku, uniqueSkus));
}

export function catalogSkuContext(row: CatalogSkuRecord) {
  if (
    row.productId === null ||
    row.productHasVariants === null ||
    row.productStatus === null ||
    row.productTypeId === null ||
    (row.variantId !== null && row.variantStatus === null)
  )
    throw new Error('CATALOG_SKU_IDENTITY_INCONSISTENT');

  const isVariant = row.variantId !== null;
  return {
    sku: row.sku,
    productId: row.productId,
    isVariant,
    // Preserve the existing five-field GET contract semantics.
    active: isVariant
      ? row.variantStatus === 'ACTIVA'
      : row.productStatus === 'ACTIVO',
    eligible:
      row.productStatus === 'ACTIVO' &&
      (isVariant
        ? row.productHasVariants && row.variantStatus === 'ACTIVA'
        : !row.productHasVariants),
  };
}
