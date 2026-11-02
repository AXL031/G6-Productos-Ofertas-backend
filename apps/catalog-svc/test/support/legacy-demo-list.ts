import { ServiceUnavailableException } from '@nestjs/common';
import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { products, productAttributes } from '../../src/catalog.schema.js';
import { Database } from '../../src/database.js';
import { PostgresCatalogRepository } from '../../src/postgres-catalog.repository.js';
import type {
  ProductQuery,
  ProductSummary,
} from '../../src/commercial.types.js';

// Frozen test reference: listDemoCandidates/demoImages at 6278b686.
// Executes the previous N+1 on the SAME disposable PostgreSQL data as the candidate.
export class LegacyDemoList extends PostgresCatalogRepository {
  constructor(private readonly fixtureDatabase: Database) {
    super(fixtureDatabase);
  }
  override async listDemoCandidates(
    query: ProductQuery,
    maxCandidates: number,
  ): Promise<ProductSummary[]> {
    const valid = (value: unknown): value is string => {
      if (typeof value !== 'string' || !value.trim()) return false;
      try {
        const u = new URL(value);
        return (
          u.protocol === 'https:' &&
          u.hostname !== 'placehold.co' &&
          !u.hostname.endsWith('.placehold.co')
        );
      } catch {
        return false;
      }
    };
    const conditions: SQL[] = [];
    if (query.q !== undefined) {
      const literal = query.q.replace(/[\\%_]/g, '\\$&');
      conditions.push(
        or(
          ilike(products.nombre, '%' + literal + '%'),
          ilike(products.descripcion, '%' + literal + '%'),
        )!,
      );
    }
    if (query.categoriaId !== undefined)
      conditions.push(eq(products.categoria_id, query.categoriaId));
    if (query.marcaId !== undefined)
      conditions.push(eq(products.marca_id, query.marcaId));
    return this.fixtureDatabase.read((db) =>
      db.transaction(
        async (tx) => {
          const rows = await tx
            .select({
              product_id: products.id,
              slug: products.slug,
              name: products.nombre,
              description: products.descripcion,
              categoria_id: products.categoria_id,
              tipo_producto_id: products.tipo_producto_id,
              marca_id: products.marca_id,
              tiene_variantes: products.tiene_variantes,
              sku_base: products.sku_base,
            })
            .from(products)
            .where(and(...conditions))
            .orderBy(
              query.orden === 'NOMBRE_DESC'
                ? desc(products.nombre)
                : asc(products.nombre),
              asc(products.id),
            )
            .limit(maxCandidates + 1);
          if (rows.length > maxCandidates)
            throw new ServiceUnavailableException();
          const items: ProductSummary[] = [];
          for (const row of rows) {
            const own = await tx.execute(
              sql`SELECT url FROM catalog.product_images WHERE product_id = ${row.product_id}::uuid AND length(trim(url)) > 0 ORDER BY principal DESC, posicion ASC, id ASC`,
            );
            let images = own.rows.map((r) => r.url).filter(valid);
            if (!images.length) {
              const children = await tx.execute(
                sql`SELECT vi.url FROM catalog.variants v JOIN catalog.variant_images vi ON vi.variant_id = v.id WHERE v.product_id = ${row.product_id}::uuid AND length(trim(vi.url)) > 0 ORDER BY vi.posicion ASC, vi.id ASC, v.id ASC`,
              );
              images = children.rows.map((r) => r.url).filter(valid);
            }
            if (!images.length) continue;
            const attributes = await tx
              .select({
                caracteristica_id: productAttributes.caracteristica_id,
                nombre: productAttributes.nombre_snapshot,
                valor_id: productAttributes.valor_id,
                valor: productAttributes.valor,
              })
              .from(productAttributes)
              .where(eq(productAttributes.product_id, row.product_id))
              .orderBy(asc(productAttributes.caracteristica_id));
            items.push({ ...row, images, attributes });
          }
          return items;
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    );
  }
}
