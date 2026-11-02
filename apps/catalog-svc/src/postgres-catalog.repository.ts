import {
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CatalogTelemetry } from './catalog-telemetry.js';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Database, type CatalogTransaction } from './database.js';
import { isDemoCatalogImage } from './catalog-read-demo.js';
import type { PriceCandidate } from './catalog-price-filter.js';
import {
  products,
  variants,
  productImages,
  variantImages,
  productAttributes,
  variantAttributes,
} from './catalog.schema.js';
import type {
  Attribute,
  ProductPage,
  ProductQuery,
  ProductSummary,
  CommercialVariant,
} from './commercial.types.js';

const projection = {
  product_id: products.id,
  slug: products.slug,
  name: products.nombre,
  description: products.descripcion,
  categoria_id: products.categoria_id,
  tipo_producto_id: products.tipo_producto_id,
  marca_id: products.marca_id,
  tiene_variantes: products.tiene_variantes,
  sku_base: products.sku_base,
};
const attributeProjection = {
  caracteristica_id: productAttributes.caracteristica_id,
  nombre: productAttributes.nombre_snapshot,
  valor_id: productAttributes.valor_id,
  valor: productAttributes.valor,
};

function isDemoImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname !== 'placehold.co' &&
      !url.hostname.endsWith('.placehold.co')
    );
  } catch {
    return false;
  }
}

@Injectable()
export class PostgresCatalogRepository {
  constructor(
    private readonly database: Database,
    @Optional()
    private readonly telemetry: CatalogTelemetry = new CatalogTelemetry(),
  ) {}

  private async groupedAttributes(tx: CatalogTransaction, ids: string[]) {
    const values = await tx
      .select({
        productId: productAttributes.product_id,
        ...attributeProjection,
      })
      .from(productAttributes)
      .where(inArray(productAttributes.product_id, ids))
      .orderBy(
        asc(productAttributes.product_id),
        asc(productAttributes.caracteristica_id),
      );
    const attributes = new Map<string, Attribute[]>();
    for (const { productId, ...attribute } of values) {
      const group = attributes.get(productId) ?? [];
      group.push(attribute);
      attributes.set(productId, group);
    }
    return attributes;
  }

  private async enrichDemoCandidates(
    tx: CatalogTransaction,
    rows: Array<Omit<ProductSummary, 'images' | 'attributes'>>,
  ): Promise<ProductSummary[]> {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.product_id);
    // Preview has its own principal-first order and URL policy. Do not reuse
    // the internal read-demo image deduplication/100-row limit here.
    const own = await tx.execute<{ product_id: string; url: string }>(sql`
      SELECT product_id, url FROM catalog.product_images
      WHERE product_id = ANY(${sql.param(ids)}::uuid[]) AND length(trim(url)) > 0
      ORDER BY product_id ASC, principal DESC, posicion ASC, id ASC`);
    const photos = new Map<string, string[]>();
    const append = (productId: string, url: string) => {
      if (!isDemoImageUrl(url)) return;
      const group = photos.get(productId) ?? [];
      group.push(url);
      photos.set(productId, group);
    };
    for (const image of own.rows) append(image.product_id, image.url);
    const missing = ids.filter((id) => !photos.has(id));
    if (missing.length) {
      const fallback = await tx.execute<{
        product_id: string;
        url: string;
      }>(sql`
        SELECT v.product_id, vi.url
        FROM catalog.variants v JOIN catalog.variant_images vi ON vi.variant_id = v.id
        WHERE v.product_id = ANY(${sql.param(missing)}::uuid[]) AND length(trim(vi.url)) > 0
        ORDER BY v.product_id ASC, vi.posicion ASC, vi.id ASC, v.id ASC`);
      for (const image of fallback.rows) append(image.product_id, image.url);
    }
    const attributes = await this.groupedAttributes(tx, ids);
    return rows
      .filter((row) => photos.has(row.product_id))
      .map((row) => ({
        ...row,
        images: photos.get(row.product_id)!,
        attributes: attributes.get(row.product_id) ?? [],
      }));
  }

  private async images(
    tx: CatalogTransaction,
    productId: string,
    readDemo: boolean,
  ) {
    const own = await tx
      .select({ url: productImages.url })
      .from(productImages)
      .where(eq(productImages.product_id, productId))
      .orderBy(asc(productImages.posicion), asc(productImages.id));
    if (!readDemo) return own;
    const photos = own.filter((image) => isDemoCatalogImage(image.url));
    if (photos.length) return photos;
    // Internal read-only presentation: actual associated variant photos, never placeholders.
    const children = await tx
      .select({ url: variantImages.url })
      .from(variantImages)
      .innerJoin(variants, eq(variants.id, variantImages.variant_id))
      .where(eq(variants.product_id, productId))
      .orderBy(
        asc(variants.id),
        asc(variantImages.posicion),
        asc(variantImages.id),
      )
      .limit(100);
    return [
      ...new Map(
        children
          .filter((image) => isDemoCatalogImage(image.url))
          .map((image) => [image.url, image]),
      ).values(),
    ];
  }

  async checkDemoReadAccess(): Promise<void> {
    await this.database.read(async (db) => {
      await db.execute(sql.raw('SELECT 1 FROM catalog.products LIMIT 0'));
      await db.execute(sql.raw('SELECT 1 FROM catalog.variants LIMIT 0'));
      await db.execute(sql.raw('SELECT 1 FROM catalog.product_images LIMIT 0'));
      await db.execute(sql.raw('SELECT 1 FROM catalog.variant_images LIMIT 0'));
    });
  }

  private demoWhere(query: ProductQuery): SQL | undefined {
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
    return conditions.length ? and(...conditions) : undefined;
  }

  private async demoImages(
    tx: CatalogTransaction,
    productId: string,
  ): Promise<string[]> {
    const own = await tx.execute(sql`SELECT url FROM catalog.product_images
      WHERE product_id = ${productId}::uuid AND length(trim(url)) > 0
      ORDER BY principal DESC, posicion ASC, id ASC`);
    const ownUrls = own.rows.map((row) => row.url).filter(isDemoImageUrl);
    if (ownUrls.length) return ownUrls;
    const variantsGallery = await tx.execute(sql`SELECT vi.url
      FROM catalog.variants v JOIN catalog.variant_images vi ON vi.variant_id = v.id
      WHERE v.product_id = ${productId}::uuid AND length(trim(vi.url)) > 0
      ORDER BY vi.posicion ASC, vi.id ASC, v.id ASC`);
    return variantsGallery.rows.map((row) => row.url).filter(isDemoImageUrl);
  }

  async listDemoCandidates(
    query: ProductQuery,
    maxCandidates: number,
    correlationId?: string,
  ): Promise<ProductSummary[]> {
    return this.database.read((db) =>
      db.transaction(
        async (tx) => {
          const rows = await this.telemetry.measure(
            'DEMO_CANDIDATES_SQL',
            async () =>
              tx
                .select(projection)
                .from(products)
                .where(this.demoWhere(query))
                .orderBy(
                  query.orden === 'NOMBRE_DESC'
                    ? desc(products.nombre)
                    : asc(products.nombre),
                  asc(products.id),
                )
                .limit(maxCandidates + 1),
            correlationId,
          );
          if (rows.length > maxCandidates)
            throw new ServiceUnavailableException();
          return this.telemetry.measure(
            'DEMO_ENRICHMENT_SQL',
            () => this.enrichDemoCandidates(tx, rows),
            correlationId,
          );
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    );
  }

  async findDemoCandidateBySlug(
    slug: string,
  ): Promise<(ProductSummary & { variants: CommercialVariant[] }) | null> {
    return this.database.read((db) =>
      db.transaction(
        async (tx) => {
          const [row] = await tx
            .select(projection)
            .from(products)
            .where(eq(products.slug, slug))
            .limit(1);
          if (!row) return null;
          const images = await this.demoImages(tx, row.product_id);
          if (!images.length) return null;
          const attributes = await tx
            .select(attributeProjection)
            .from(productAttributes)
            .where(eq(productAttributes.product_id, row.product_id))
            .orderBy(asc(productAttributes.caracteristica_id));
          const children = row.tiene_variantes
            ? await tx
                .select({ variant_id: variants.id, sku: variants.sku })
                .from(variants)
                .where(eq(variants.product_id, row.product_id))
                .orderBy(asc(variants.id))
            : [];
          const result: CommercialVariant[] = [];
          for (const child of children) {
            const values = await tx
              .select({
                caracteristica_id: variantAttributes.caracteristica_id,
                nombre: variantAttributes.nombre_snapshot,
                valor_id: variantAttributes.valor_id,
                valor: variantAttributes.valor,
                identifying: variantAttributes.es_identificador,
              })
              .from(variantAttributes)
              .where(eq(variantAttributes.variant_id, child.variant_id))
              .orderBy(asc(variantAttributes.caracteristica_id));
            const gallery = await tx
              .select({ url: variantImages.url })
              .from(variantImages)
              .where(eq(variantImages.variant_id, child.variant_id))
              .orderBy(asc(variantImages.posicion), asc(variantImages.id));
            const attrs = (identifying: boolean): Attribute[] =>
              values
                .filter((v) => v.identifying === identifying)
                .map(({ identifying: _internal, ...attribute }) => attribute);
            result.push({
              ...child,
              identifying_attributes: attrs(true),
              non_identifying_attributes: attrs(false),
              images: gallery
                .map((i) => i.url)
                .filter((url) => url.trim().length > 0),
            });
          }
          return { ...row, images, attributes, variants: result };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    );
  }

  // D-CAT-05/06: elegibilidad global, en el mismo snapshot que COUNT y página.
  private where(query: ProductQuery, readDemo = false): SQL | undefined {
    const conditions: SQL[] = [];
    if (query.estado || !readDemo)
      conditions.push(eq(products.estado, query.estado ?? 'ACTIVO'));
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
    if (
      !readDemo &&
      (query.estado === undefined || query.estado === 'ACTIVO')
    ) {
      conditions.push(
        or(
          eq(products.tiene_variantes, false),
          exists(sql`(SELECT 1 FROM ${variants} WHERE
            ${variants.product_id} = ${products.id}
            AND ${variants.estado} = ${'ACTIVA'})`),
        )!,
      );
    }
    return and(...conditions);
  }

  async listCandidates(
    query: ProductQuery,
    readDemo = false,
    productIds?: readonly string[],
  ): Promise<ProductPage> {
    if (query.precioMin !== undefined || query.precioMax !== undefined)
      throw new ServiceUnavailableException();
    return this.database.read((db) =>
      db.transaction(
        async (tx) => {
          const where = and(
            this.where(query, readDemo),
            productIds === undefined
              ? undefined
              : sql`${products.id} = ANY(${sql.param(productIds)}::uuid[])`,
          );
          const [count] = await tx
            .select({ total: sql<number>`count(*)::integer` })
            .from(products)
            .where(where);
          const rows = await tx
            .select(projection)
            .from(products)
            .where(where)
            .orderBy(
              query.orden === 'NOMBRE_DESC'
                ? desc(products.nombre)
                : asc(products.nombre),
              asc(products.id),
            )
            .limit(query.tamanio)
            .offset((query.pagina - 1) * query.tamanio);
          // Hydrate only the SQL page, in the same read-only snapshot as COUNT.
          // Ordinary reads retain every own image, without preview filtering/fallback.
          const ids = rows.map((row) => row.product_id);
          if (!ids.length)
            return {
              items: [],
              pagina: query.pagina,
              tamanio: query.tamanio,
              total: count?.total ?? 0,
            };
          const own = await tx
            .select({
              productId: productImages.product_id,
              url: productImages.url,
            })
            .from(productImages)
            .where(inArray(productImages.product_id, ids))
            .orderBy(
              asc(productImages.product_id),
              asc(productImages.posicion),
              asc(productImages.id),
            );
          const attributes = await this.groupedAttributes(tx, ids);
          const photos = new Map<string, string[]>();
          const fallback = new Map<string, string[]>();
          for (const image of own) {
            if (readDemo && !isDemoCatalogImage(image.url)) continue;
            const gallery = photos.get(image.productId) ?? [];
            gallery.push(image.url);
            photos.set(image.productId, gallery);
          }
          if (readDemo) {
            const children = await tx
              .select({
                productId: variants.product_id,
                url: variantImages.url,
              })
              .from(variantImages)
              .innerJoin(variants, eq(variants.id, variantImages.variant_id))
              .where(inArray(variants.product_id, ids))
              .orderBy(
                asc(variants.product_id),
                asc(variants.id),
                asc(variantImages.posicion),
                asc(variantImages.id),
              );
            for (const image of children) {
              if (!isDemoCatalogImage(image.url)) continue;
              const gallery = fallback.get(image.productId) ?? [];
              if (gallery.length < 100 && !gallery.includes(image.url))
                gallery.push(image.url);
              fallback.set(image.productId, gallery);
            }
          }
          return {
            items: rows.map((row) => ({
              ...row,
              images:
                photos.get(row.product_id) ??
                fallback.get(row.product_id) ??
                [],
              attributes: attributes.get(row.product_id) ?? [],
            })),
            pagina: query.pagina,
            tamanio: query.tamanio,
            total: count?.total ?? 0,
          };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    );
  }

  /** Authoritative SKU state and commercial eligibility, independent of Pricing. */
  async skuContext(sku: string) {
    return this.database.read(async (db) => {
      const result = await db.execute(sql`SELECT si.sku, p.id AS product_id,
        (si.variant_id IS NOT NULL) AS is_variant,
        (CASE WHEN si.variant_id IS NULL THEN p.estado = 'ACTIVO'
          ELSE v.estado = 'ACTIVA' END) AS active,
        (p.estado = 'ACTIVO' AND
          ((si.product_id IS NOT NULL AND NOT p.tiene_variantes)
            OR (si.variant_id IS NOT NULL AND p.tiene_variantes AND v.estado = 'ACTIVA'))) AS eligible
        FROM catalog.sku_identity si LEFT JOIN catalog.variants v ON v.id = si.variant_id
        JOIN catalog.products p ON p.id = COALESCE(si.product_id, v.product_id)
        WHERE si.sku = ${sku}`);
      const row = result.rows[0];
      if (!row) return null;
      if (
        typeof row.sku !== 'string' ||
        typeof row.product_id !== 'string' ||
        typeof row.is_variant !== 'boolean' ||
        typeof row.active !== 'boolean' ||
        typeof row.eligible !== 'boolean'
      )
        throw new Error();
      return {
        sku: row.sku,
        productId: row.product_id,
        isVariant: row.is_variant,
        active: row.active,
        eligible: row.eligible,
      };
    });
  }

  async priceCandidates(query: ProductQuery): Promise<PriceCandidate[]> {
    return this.database.read((db) =>
      db.transaction(
        async (tx) => {
          const where = this.where(query);
          const simple = await tx
            .select({ productId: products.id, sku: products.sku_base })
            .from(products)
            .where(and(where, eq(products.tiene_variantes, false)));
          const children = await tx
            .select({ productId: products.id, sku: variants.sku })
            .from(products)
            .innerJoin(variants, eq(variants.product_id, products.id))
            .where(
              and(
                where,
                eq(products.tiene_variantes, true),
                eq(variants.estado, 'ACTIVA'),
              ),
            );
          return [...simple, ...children];
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    );
  }

  async findCandidateBySlug(
    slug: string,
    canal?: ProductQuery['canal'],
    readDemo = false,
  ): Promise<(ProductSummary & { variants: CommercialVariant[] }) | null> {
    return this.database.read((db) =>
      db.transaction(
        async (tx) => {
          const [row] = await tx
            .select(projection)
            .from(products)
            .where(
              and(
                eq(products.slug, slug),
                this.where(
                  {
                    canal,
                    pagina: 1,
                    tamanio: 1,
                    orden: 'NOMBRE_ASC',
                  },
                  readDemo,
                ),
              ),
            )
            .limit(1);
          if (!row) return null;
          const images = await this.images(tx, row.product_id, readDemo);
          const attributes = await tx
            .select(attributeProjection)
            .from(productAttributes)
            .where(eq(productAttributes.product_id, row.product_id))
            .orderBy(asc(productAttributes.caracteristica_id));
          const children = row.tiene_variantes
            ? await tx
                .select({
                  variant_id: variants.id,
                  sku: variants.sku,
                })
                .from(variants)
                .where(
                  and(
                    eq(variants.product_id, row.product_id),
                    readDemo ? undefined : eq(variants.estado, 'ACTIVA'),
                  ),
                )
                .orderBy(asc(variants.id))
            : [];
          const result: CommercialVariant[] = [];
          for (const child of children) {
            const values = await tx
              .select({
                caracteristica_id: variantAttributes.caracteristica_id,
                nombre: variantAttributes.nombre_snapshot,
                valor_id: variantAttributes.valor_id,
                valor: variantAttributes.valor,
                identifying: variantAttributes.es_identificador,
              })
              .from(variantAttributes)
              .where(eq(variantAttributes.variant_id, child.variant_id))
              .orderBy(asc(variantAttributes.caracteristica_id));
            const gallery = await tx
              .select({ url: variantImages.url })
              .from(variantImages)
              .where(eq(variantImages.variant_id, child.variant_id))
              .orderBy(asc(variantImages.posicion), asc(variantImages.id));
            const attrs = (identifying: boolean): Attribute[] =>
              values
                .filter((v) => v.identifying === identifying)
                .map(({ identifying: _internal, ...attribute }) => attribute);
            result.push({
              ...child,
              identifying_attributes: attrs(true),
              non_identifying_attributes: attrs(false),
              images: gallery.map((i) => i.url),
            });
          }
          return {
            ...row,
            images: images.map((i) => i.url),
            attributes,
            variants: result,
          };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    );
  }

  async findCandidateByProductId(
    productId: string,
    canal: ProductQuery['canal'],
    readDemo = false,
  ): Promise<(ProductSummary & { variants: CommercialVariant[] }) | null> {
    return this.database.read((db) =>
      db.transaction(
        async (tx) => {
          const [row] = await tx
            .select(projection)
            .from(products)
            .where(
              and(
                sql`${products.id}::text = ${productId}`,
                this.where(
                  {
                    canal,
                    pagina: 1,
                    tamanio: 1,
                    orden: 'NOMBRE_ASC',
                  },
                  readDemo,
                ),
              ),
            )
            .limit(1);
          if (!row) return null;
          const images = await this.images(tx, row.product_id, readDemo);
          const attributes: Attribute[] = await tx
            .select(attributeProjection)
            .from(productAttributes)
            .where(eq(productAttributes.product_id, row.product_id))
            .orderBy(asc(productAttributes.caracteristica_id));
          const children = row.tiene_variantes
            ? await tx
                .select({ variant_id: variants.id, sku: variants.sku })
                .from(variants)
                .where(
                  and(
                    eq(variants.product_id, row.product_id),
                    readDemo ? undefined : eq(variants.estado, 'ACTIVA'),
                  ),
                )
                .orderBy(asc(variants.id))
            : [];
          const commercialVariants: CommercialVariant[] = [];
          for (const child of children) {
            const values = await tx
              .select({
                caracteristica_id: variantAttributes.caracteristica_id,
                nombre: variantAttributes.nombre_snapshot,
                valor_id: variantAttributes.valor_id,
                valor: variantAttributes.valor,
                identifying: variantAttributes.es_identificador,
              })
              .from(variantAttributes)
              .where(eq(variantAttributes.variant_id, child.variant_id))
              .orderBy(asc(variantAttributes.caracteristica_id));
            const gallery = await tx
              .select({ url: variantImages.url })
              .from(variantImages)
              .where(eq(variantImages.variant_id, child.variant_id))
              .orderBy(asc(variantImages.posicion), asc(variantImages.id));
            const project = (identifying: boolean): Attribute[] =>
              values
                .filter((value) => value.identifying === identifying)
                .map(({ identifying: _internal, ...attribute }) => attribute);
            commercialVariants.push({
              ...child,
              identifying_attributes: project(true),
              non_identifying_attributes: project(false),
              images: gallery.map((image) => image.url),
            });
          }
          return {
            ...row,
            images: images.map((image) => image.url),
            attributes,
            variants: commercialVariants,
          };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    );
  }
}
