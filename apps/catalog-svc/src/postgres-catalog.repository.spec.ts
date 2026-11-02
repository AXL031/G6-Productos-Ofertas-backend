import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Database } from './database.js';
import { PostgresCatalogRepository } from './postgres-catalog.repository.js';

// Driver de prueba aislado: valida SQL generado y mapping, NO acredita PostgreSQL.
describe('Catalog provider SQL and projections (isolated)', () => {
  const statements: { text: string; values: unknown[] }[] = [];
  let productWithVariants = false;
  let productImageUrls = ['https://example.test/product.webp'];
  let variantImageUrls = ['https://example.test/variant.webp'];
  const client = {
    release() {},
    async query(config: string | { text: string }, values: unknown[] = []) {
      const text = typeof config === 'string' ? config : config.text;
      statements.push({ text, values });
      if (text.includes('count(*)')) return { rows: [[1]] };
      if (text.includes('from "catalog"."products"'))
        return {
          rows: [
            [
              'product-fixture',
              'fixture',
              'Fixture',
              'Fixture description',
              'cat',
              'type',
              'brand',
              productWithVariants,
              '0001',
            ],
          ],
        };
      if (text.includes('from "catalog"."variants"'))
        return { rows: [['variant-fixture', '0002']] };
      if (text.includes('from "catalog"."product_images"'))
        return {
          rows: productImageUrls.map((url) =>
            text.includes('"product_id",') ? ['product-fixture', url] : [url],
          ),
        };
      if (text.includes('from "catalog"."variant_images"'))
        return { rows: variantImageUrls.map((url) => [url]) };
      if (text.includes('SELECT url FROM catalog.product_images'))
        return { rows: productImageUrls.map((url) => ({ url })) };
      if (text.includes('SELECT product_id, url FROM catalog.product_images'))
        return {
          rows: productImageUrls.map((url) => ({
            product_id: 'product-fixture',
            url,
          })),
        };
      if (text.includes('SELECT v.product_id, vi.url'))
        return {
          rows: variantImageUrls.map((url) => ({
            product_id: 'product-fixture',
            url,
          })),
        };
      if (text.includes('SELECT vi.url'))
        return { rows: variantImageUrls.map((url) => ({ url })) };
      if (text.includes('from "catalog"."product_attribute_values"'))
        return {
          rows: [
            text.includes('"product_id",')
              ? ['product-fixture', 'c1', 'Material', null, 'Cotton']
              : ['c1', 'Material', null, 'Cotton'],
          ],
        };
      if (text.includes('from "catalog"."variant_attribute_values"'))
        return {
          rows: [
            ['c2', 'Size', 'value-M', 'M', true],
            ['c3', 'Material', null, 'Cotton', false],
          ],
        };
      return { rows: [] };
    },
  };
  const pool = { ...client, connect: async () => client };
  const db = drizzle(pool as unknown as pg.Pool);
  const database = {
    read: <T>(read: (connection: typeof db) => Promise<T>) => read(db),
  };
  const repo = new PostgresCatalogRepository(database as Database);
  beforeEach(() => {
    statements.length = 0;
    productWithVariants = false;
    productImageUrls = ['https://example.test/product.webp'];
    variantImageUrls = ['https://example.test/variant.webp'];
  });
  it('looks up an opaque context SKU as a SQL parameter within Catalog only', async () => {
    const sku = " 000-' OR true -- ";
    expect(await repo.skuContext(sku)).toBeNull();
    expect(statements).toHaveLength(1);
    expect(statements[0].values).toEqual([sku]);
    expect(statements[0].text).not.toContain(sku);
    expect(statements[0].text).not.toMatch(/taxonomy\.|pricing\./);
  });
  it('parameterizes literal text and filters eligibility in COUNT before LIMIT/OFFSET', async () => {
    await repo.listCandidates({
      canal: 'MARKETPLACE',
      q: "x%' OR true --",
      pagina: 2,
      tamanio: 10,
      orden: 'NOMBRE_DESC',
    });
    const count = statements.find((s) => s.text.includes('count(*)'))!;
    expect(count.text).toContain('exists (SELECT');
    expect(count.text).not.toContain('OR true --');
    expect(count.values).toContain("%x\\%' OR true --%");
    expect(count.values).toContain('ACTIVO');
    expect(count.values).toContain('ACTIVA');
    expect(count.text).not.toContain('sku_channel_eligibility');
    expect(count.text).toContain('"product_id" = "catalog"."products"."id"');
    const page = statements.find((s) => s.text.includes('limit'))!;
    expect(page.text).toContain('"nombre" desc');
    expect(page.values.slice(-2)).toEqual([10, 10]);
    expect(statements[0].text).toContain('read only');
    expect(statements.at(-1)?.text).toBe('commit');
    expect(statements.every((s) => !s.text.includes('"taxonomy"'))).toBe(true);
  });
  it('composes simple/variant DTOs with exact identities and no administrative columns', async () => {
    const simple = await repo.findCandidateBySlug('fixture');
    expect(simple?.sku_base).toBe('0001');
    expect(simple?.variants).toEqual([]);
    productWithVariants = true;
    const detail = await repo.findCandidateBySlug('fixture');
    expect(detail?.variants).toEqual([
      {
        variant_id: 'variant-fixture',
        sku: '0002',
        identifying_attributes: [
          {
            caracteristica_id: 'c2',
            nombre: 'Size',
            valor_id: 'value-M',
            valor: 'M',
          },
        ],
        non_identifying_attributes: [
          {
            caracteristica_id: 'c3',
            nombre: 'Material',
            valor_id: null,
            valor: 'Cotton',
          },
        ],
        images: ['https://example.test/variant.webp'],
      },
    ]);
    expect(detail).not.toHaveProperty('estado');
    expect(detail?.attributes).toEqual([
      {
        caracteristica_id: 'c1',
        nombre: 'Material',
        valor_id: null,
        valor: 'Cotton',
      },
    ]);
  });

  it('collects lightweight sellable candidates before hydration and applies matched IDs before count/page', async () => {
    const query = {
      canal: 'MARKETPLACE' as const,
      pagina: 1,
      tamanio: 1,
      orden: 'NOMBRE_ASC' as const,
      q: 'fixture',
    };
    await repo.priceCandidates(query);
    expect(statements.filter((s) => s.text.startsWith('select'))).toHaveLength(
      2,
    );
    expect(
      statements.every(
        (s) => !/images|attribute_values|limit|offset/.test(s.text),
      ),
    ).toBe(true);
    expect(
      statements.some((s) =>
        s.text.includes('inner join "catalog"."variants"'),
      ),
    ).toBe(true);
    statements.length = 0;
    await repo.listCandidates(query, false, [
      '00000000-0000-4000-8000-000000000001',
    ]);
    const count = statements.find((s) => s.text.includes('count(*)'))!;
    expect(count.text).toContain('ANY(');
    expect(count.values).toContainEqual([
      '00000000-0000-4000-8000-000000000001',
    ]);
  });

  it('checks demo read access with bounded SELECT-only probes on the four required tables', async () => {
    await repo.checkDemoReadAccess();
    const checks = statements.filter((statement) =>
      /SELECT 1 FROM catalog\.(products|variants|product_images|variant_images) LIMIT 0/.test(
        statement.text,
      ),
    );
    expect(checks.map((statement) => statement.text)).toEqual([
      'SELECT 1 FROM catalog.products LIMIT 0',
      'SELECT 1 FROM catalog.variants LIMIT 0',
      'SELECT 1 FROM catalog.product_images LIMIT 0',
      'SELECT 1 FROM catalog.variant_images LIMIT 0',
    ]);
    expect(checks.every((statement) => statement.values.length === 0)).toBe(
      true,
    );
  });

  it('falls back from placeholder product images to valid variant images', async () => {
    productImageUrls = ['https://placehold.co/800x800/png?text=placeholder'];
    const page = await repo.listDemoCandidates(
      {
        canal: 'MARKETPLACE',
        pagina: 1,
        tamanio: 20,
        orden: 'NOMBRE_ASC',
      },
      100,
    );
    expect(page[0].images).toEqual(['https://example.test/variant.webp']);
  });

  it('excludes candidates with only placeholder images', async () => {
    productImageUrls = ['https://placehold.co/800x800/png?text=placeholder'];
    variantImageUrls = ['https://placehold.co/800x800/png?text=placeholder'];
    const page = await repo.listDemoCandidates(
      {
        canal: 'MARKETPLACE',
        pagina: 1,
        tamanio: 20,
        orden: 'NOMBRE_ASC',
      },
      100,
    );
    expect(page).toEqual([]);
  });
});
