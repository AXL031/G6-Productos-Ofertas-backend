import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { Database, type CatalogTransaction } from './database.js';
import {
  activationChecks,
  outbox,
  products,
  skuIdentity,
  skuPhysicalProfiles,
  variantAttributes,
  variantImages,
  variants,
} from './catalog.schema.js';
import type { Attribute } from './commercial.types.js';
import type {
  AdminVariant,
  PhysicalSkuData,
  ProductPreparation,
  PreparationDependency,
  VariantPage,
} from './catalog-query.types.js';
import {
  activeAttempt,
  manualRetryAllowed,
  preparationTimeout,
  CATALOG_PREPARATION_CONFIG,
  type CatalogPreparationConfig,
  UnresolvedCatalogAttempt,
} from './catalog-messages.js';

type VariantRow = {
  variant_id: string;
  sku: string;
  status: 'BORRADOR' | 'ACTIVA' | 'INACTIVA';
  catalog_version: bigint;
};

function recordValue(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numericValues(values: (string | null)[]): number[] | null {
  const numbers = values.map((value) =>
    value === null ? Number.NaN : Number(value),
  );
  return numbers.every((value) => Number.isFinite(value) && value > 0)
    ? numbers
    : null;
}

@Injectable()
export class CatalogQueryRepository {
  constructor(
    private readonly database: Database,
    @Inject(CATALOG_PREPARATION_CONFIG)
    private readonly preparation: CatalogPreparationConfig = {
      timeoutMs: preparationTimeout(),
    },
  ) {}

  physicalData(skus: readonly string[]): Promise<{
    productos: PhysicalSkuData[];
    noEncontrados: string[];
  }> {
    return this.database.read((db) =>
      db.transaction(
        async (tx) => {
          const rows = await tx
            .select({
              sku: skuIdentity.sku,
              identityId: skuIdentity.id,
              variantId: skuIdentity.variant_id,
              productId: products.id,
              productHasVariants: products.tiene_variantes,
              productStatus: products.estado,
              variantStatus: variants.estado,
              weight: skuPhysicalProfiles.peso_kg,
              length: skuPhysicalProfiles.largo_cm,
              width: skuPhysicalProfiles.ancho_cm,
              height: skuPhysicalProfiles.alto_cm,
              profileUpdatedAt: skuPhysicalProfiles.updated_at,
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
            .leftJoin(
              skuPhysicalProfiles,
              eq(skuIdentity.id, skuPhysicalProfiles.sku_identity_id),
            )
            .where(inArray(skuIdentity.sku, [...new Set(skus)]));
          const bySku = new Map(rows.map((row) => [row.sku, row]));
          const productos: PhysicalSkuData[] = [];
          const noEncontrados: string[] = [];
          for (const sku of skus) {
            const row = bySku.get(sku);
            if (
              !row ||
              !row.productId ||
              (row.productHasVariants && !row.variantId)
            ) {
              noEncontrados.push(sku);
              continue;
            }
            const estado = row.variantId
              ? row.variantStatus === 'ACTIVA'
                ? 'ACTIVO'
                : row.variantStatus === 'INACTIVA'
                  ? 'INACTIVO'
                  : undefined
              : row.productStatus === 'ACTIVO'
                ? 'ACTIVO'
                : row.productStatus === 'INACTIVO'
                  ? 'INACTIVO'
                  : undefined;
            if (!estado) {
              noEncontrados.push(sku);
              continue;
            }
            const values = numericValues([
              row.weight,
              row.length,
              row.width,
              row.height,
            ]);
            if (!row.profileUpdatedAt || !values)
              throw new ServiceUnavailableException();
            productos.push({
              sku,
              estado,
              pesoKg: values[0]!,
              dimensionesCm: {
                largo: values[1]!,
                ancho: values[2]!,
                alto: values[3]!,
              },
              actualizadoEn: row.profileUpdatedAt.toISOString(),
            });
          }
          return { productos, noEncontrados };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    );
  }

  listVariants(
    productId: string,
    page: number,
    pageSize: number,
    status?: 'BORRADOR' | 'ACTIVA' | 'INACTIVA',
  ): Promise<VariantPage | null> {
    return this.database.read((db) =>
      db.transaction(
        async (tx) => {
          const [product] = await tx
            .select({ id: products.id })
            .from(products)
            .where(sql`${products.id}::text = ${productId}`)
            .limit(1);
          if (!product) return null;
          const condition = and(
            eq(variants.product_id, product.id),
            status ? eq(variants.estado, status) : undefined,
          );
          const [count] = await tx
            .select({ total: sql<number>`count(*)::integer` })
            .from(variants)
            .where(condition);
          const rows = await tx
            .select({
              variant_id: variants.id,
              sku: variants.sku,
              status: variants.estado,
              catalog_version: variants.catalog_version,
            })
            .from(variants)
            .where(condition)
            .orderBy(asc(variants.id))
            .limit(pageSize)
            .offset((page - 1) * pageSize);
          const total = count?.total ?? 0;
          return {
            items: await this.adminVariants(tx, rows),
            meta: {
              pagina: page,
              tamanio: pageSize,
              total,
              totalPaginas: total === 0 ? 0 : Math.ceil(total / pageSize),
            },
          };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    );
  }

  findVariant(
    productId: string,
    variantId: string,
  ): Promise<AdminVariant | null> {
    return this.database.read((db) =>
      db.transaction(
        async (tx) => {
          const [row] = await tx
            .select({
              variant_id: variants.id,
              sku: variants.sku,
              status: variants.estado,
              catalog_version: variants.catalog_version,
            })
            .from(variants)
            .innerJoin(products, eq(variants.product_id, products.id))
            .where(
              and(
                sql`${products.id}::text = ${productId}`,
                sql`${variants.id}::text = ${variantId}`,
              ),
            )
            .limit(1);
          if (!row) return null;
          return (await this.adminVariants(tx, [row]))[0] ?? null;
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    );
  }

  private async adminVariants(
    tx: CatalogTransaction,
    rows: VariantRow[],
  ): Promise<AdminVariant[]> {
    const items: AdminVariant[] = [];
    for (const row of rows) {
      const values = await tx
        .select({
          caracteristica_id: variantAttributes.caracteristica_id,
          nombre: variantAttributes.nombre_snapshot,
          valor_id: variantAttributes.valor_id,
          valor: variantAttributes.valor,
          identifying: variantAttributes.es_identificador,
        })
        .from(variantAttributes)
        .where(eq(variantAttributes.variant_id, row.variant_id))
        .orderBy(asc(variantAttributes.caracteristica_id));
      const images = await tx
        .select({ url: variantImages.url })
        .from(variantImages)
        .where(eq(variantImages.variant_id, row.variant_id))
        .orderBy(asc(variantImages.posicion), asc(variantImages.id));
      const [profile] = await tx
        .select({
          weight: skuPhysicalProfiles.peso_kg,
          length: skuPhysicalProfiles.largo_cm,
          width: skuPhysicalProfiles.ancho_cm,
          height: skuPhysicalProfiles.alto_cm,
          updatedAt: skuPhysicalProfiles.updated_at,
        })
        .from(skuIdentity)
        .innerJoin(
          skuPhysicalProfiles,
          eq(skuIdentity.id, skuPhysicalProfiles.sku_identity_id),
        )
        .where(eq(skuIdentity.variant_id, row.variant_id))
        .limit(1);
      const version = Number(row.catalog_version);
      if (!Number.isSafeInteger(version) || version < 0)
        throw new ServiceUnavailableException();
      const dimensions = profile
        ? numericValues([profile.length, profile.width, profile.height])
        : null;
      const weight = profile ? numericValues([profile.weight])?.[0] : undefined;
      const physicalProfile =
        profile &&
        profile.updatedAt &&
        dimensions &&
        weight !== undefined &&
        row.status !== 'BORRADOR'
          ? {
              sku: row.sku,
              estado:
                row.status === 'ACTIVA'
                  ? ('ACTIVO' as const)
                  : ('INACTIVO' as const),
              pesoKg: weight,
              dimensionesCm: {
                largo: dimensions[0]!,
                ancho: dimensions[1]!,
                alto: dimensions[2]!,
              },
              actualizadoEn: profile.updatedAt.toISOString(),
            }
          : null;
      const attributeProjection = (identifying: boolean): Attribute[] =>
        values
          .filter((value) => value.identifying === identifying)
          .map(({ identifying: _internal, ...attribute }) => attribute);
      items.push({
        variant_id: row.variant_id,
        sku: row.sku,
        status: row.status,
        identifying_attributes: attributeProjection(true),
        non_identifying_attributes: attributeProjection(false),
        images: images.map((image) => image.url),
        physical_profile: physicalProfile,
        catalog_version: version,
      });
    }
    return items;
  }

  productPreparation(productId: string): Promise<ProductPreparation | null> {
    return this.database
      .read((db) =>
        db.transaction(
          async (tx) => {
            const [product] = await tx
              .select({
                product_id: products.id,
                sku_base: products.sku_base,
                tiene_variantes: products.tiene_variantes,
              })
              .from(products)
              .where(sql`${products.id}::text = ${productId}`)
              .limit(1);
            if (!product) return null;
            const children = product.tiene_variantes
              ? await tx
                  .select({ variant_id: variants.id, sku: variants.sku })
                  .from(variants)
                  .where(eq(variants.product_id, product.product_id))
                  .orderBy(asc(variants.id))
              : [];
            const checks = await tx
              .select({
                sku: activationChecks.sku,
                dependency: activationChecks.dependency,
                state: activationChecks.state,
                resultPayload: activationChecks.result_payload,
                operationId: activationChecks.operation_id,
              })
              .from(activationChecks)
              .where(eq(activationChecks.product_id, product.product_id));
            const requests = checks.length
              ? await tx
                  .select()
                  .from(outbox)
                  .where(
                    inArray(
                      outbox.operation_id,
                      checks.map((c) => c.operationId),
                    ),
                  )
              : [];
            const timeout = this.preparation.timeoutMs;
            const byKey = new Map(
              checks.map((check) => [
                check.dependency + '\0' + check.sku,
                check,
              ]),
            );
            const dependency = (
              kind: 'PRICING' | 'INVENTORY',
              sku: string,
            ): PreparationDependency => {
              const check = byKey.get(kind + '\0' + sku);
              if (
                !check ||
                !['PENDING', 'COMPLETED', 'REJECTED'].includes(check.state)
              )
                throw new ServiceUnavailableException();
              const result = check.resultPayload;
              const code =
                recordValue(result) && typeof result.code === 'string'
                  ? result.code
                  : null;
              return {
                status: check.state as PreparationDependency['status'],
                manual_retry_allowed:
                  check.state === 'PENDING' &&
                  timeout !== undefined &&
                  manualRetryAllowed(
                    check.state,
                    activeAttempt(
                      requests.filter(
                        (r) =>
                          r.operation_id === check.operationId &&
                          r.event_name ===
                            (kind === 'PRICING'
                              ? 'pricing.product.initialization.requested'
                              : 'inventory.sku.initialization.requested'),
                      ),
                    ),
                    timeout,
                  ),
                code,
              };
            };
            return {
              product_id: product.product_id,
              tiene_variantes: product.tiene_variantes,
              pricing: dependency('PRICING', product.sku_base),
              inventario: product.tiene_variantes
                ? null
                : dependency('INVENTORY', product.sku_base),
              variantes: children.map((child) => ({
                variant_id: child.variant_id,
                sku: child.sku,
                inventario: dependency('INVENTORY', child.sku),
              })),
            };
          },
          { isolationLevel: 'repeatable read', accessMode: 'read only' },
        ),
      )
      .catch((error: unknown) => {
        if (error instanceof UnresolvedCatalogAttempt)
          throw new ServiceUnavailableException();
        throw error;
      });
  }
}
