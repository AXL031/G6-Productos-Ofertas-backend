import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Database } from './database.js';
import { PostgresCatalogRepository } from './postgres-catalog.repository.js';
import type { ProductQuery, ProductSummary } from './commercial.types.js';

// SQL driver fixture: baseline run on a3cade1 before batching the ordinary list.
// It supplies a SQL page; predicates and pagination are asserted on generated SQL.
describe('Ordinary catalog list equivalence and query growth', () => {
  let indices: number[] = [];
  let failEnrichment = false;
  const statements: { text: string; values: unknown[] }[] = [];
  const id = (i: number) =>
    `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const photos = (i: number) =>
    i % 3 === 0
      ? []
      : [
          'https://placehold.co/legacy.png',
          'https://example.test/repeated.png',
          'https://example.test/repeated.png',
        ];
  const attributes = (i: number) =>
    i % 2 === 0
      ? []
      : [
          {
            caracteristica_id: 'a',
            nombre: 'A',
            valor_id: null,
            valor: { nested: [i, false] },
          },
          {
            caracteristica_id: 'z',
            nombre: 'Z',
            valor_id: '0001',
            valor: 'Cotton',
          },
        ];
  const expected = (i: number): ProductSummary => ({
    product_id: id(i),
    slug: `item-${i}`,
    name: `Group ${Math.floor(i / 2)}`,
    description: 'Description',
    categoria_id: 'category',
    tipo_producto_id: 'type',
    marca_id: 'brand',
    tiene_variantes: i % 2 === 0,
    sku_base: `000${i}`,
    images: photos(i),
    attributes: attributes(i),
  });
  const client = {
    release() {},
    async query(config: string | { text: string }, values: unknown[] = []) {
      const text = typeof config === 'string' ? config : config.text;
      statements.push({ text, values });
      if (text.includes('count(*)')) return { rows: [[48]] };
      if (text.includes('from "catalog"."products"'))
        return {
          rows: indices.map((i) => {
            const r = expected(i);
            return [
              r.product_id,
              r.slug,
              r.name,
              r.description,
              r.categoria_id,
              r.tipo_producto_id,
              r.marca_id,
              r.tiene_variantes,
              r.sku_base,
            ];
          }),
        };
      if (/product_images|product_attribute_values/.test(text)) {
        if (failEnrichment) throw new Error('isolated enrichment failure');
        const selected = indices.filter((i) => values.includes(id(i)));
        const grouped = text.includes('"product_id",');
        if (text.includes('product_images'))
          return {
            rows: selected.flatMap((i) =>
              photos(i).map((url) => (grouped ? [id(i), url] : [url])),
            ),
          };
        return {
          rows: selected.flatMap((i) =>
            attributes(i).map((a) => [
              ...(grouped ? [id(i)] : []),
              a.caracteristica_id,
              a.nombre,
              a.valor_id,
              a.valor,
            ]),
          ),
        };
      }
      return { rows: [] };
    },
  };
  const db = drizzle({
    ...client,
    connect: async () => client,
  } as unknown as pg.Pool);
  const repo = new PostgresCatalogRepository({
    read: <T>(work: (connection: typeof db) => Promise<T>) => work(db),
  } as Database);
  const query: ProductQuery = {
    canal: 'MARKETPLACE',
    pagina: 1,
    tamanio: 4,
    orden: 'NOMBRE_ASC',
  };
  beforeEach(() => {
    indices = [];
    statements.length = 0;
    failEnrichment = false;
  });

  it.each(
    [4, 24].flatMap((tamanio) =>
      [1, 2].flatMap((pagina) =>
        ['NOMBRE_ASC', 'NOMBRE_DESC'].map((orden) => ({
          tamanio,
          pagina,
          orden: orden as ProductQuery['orden'],
        })),
      ),
    ),
  )(
    'preserves full SQL-page projection $tamanio/$pagina/$orden',
    async (page) => {
      indices = Array.from(
        { length: page.tamanio },
        (_, i) => (page.pagina - 1) * page.tamanio + i,
      );
      if (page.orden === 'NOMBRE_DESC') indices.reverse();
      expect(
        await repo.listCandidates({
          ...query,
          ...page,
          q: "x%_'",
          categoriaId: 'category',
          marcaId: 'brand',
        }),
      ).toEqual({
        items: indices.map(expected),
        pagina: page.pagina,
        tamanio: page.tamanio,
        total: 48,
      });
      const count = statements.find((s) => s.text.includes('count(*)'))!;
      const selectPage = statements.find((s) => s.text.includes('limit'))!;
      expect(count.text).toContain('exists (SELECT');
      expect(count.values).toEqual([
        'ACTIVO',
        "%x\\%\\_'%",
        "%x\\%\\_'%",
        'category',
        'brand',
        false,
        'ACTIVA',
      ]);
      const pagination =
        page.pagina === 1
          ? [page.tamanio]
          : [page.tamanio, (page.pagina - 1) * page.tamanio];
      expect(selectPage.values.slice(0, -pagination.length)).toEqual(
        count.values,
      );
      expect(selectPage.values.slice(-pagination.length)).toEqual(pagination);
      expect(selectPage.text).toContain(
        `"nombre" ${page.orden === 'NOMBRE_DESC' ? 'desc' : 'asc'}`,
      );
      expect(selectPage.text).toContain('"id" asc');
      expect(statements[0].text).toContain('repeatable read read only');
      expect(statements.at(-1)?.text).toBe('commit');
      expect(statements.some((s) => s.text.includes('variant_images'))).toBe(
        false,
      );
    },
  );

  it.each([0, 1, 4, 24])(
    'bounds SELECT count for %s page rows (baseline: 2 + 2*N)',
    async (size) => {
      indices = Array.from({ length: size }, (_, i) => i);
      const result = await repo.listCandidates(query);
      expect(result.items).toEqual(indices.map(expected));
      expect(result.total).toBe(48);
      expect(
        statements.filter((s) => s.text.startsWith('select')),
      ).toHaveLength(size === 0 ? 2 : 4);
    },
  );

  it('keeps the matched-product restriction before count/page and rolls back enrichment failures', async () => {
    indices = [1, 2];
    await repo.listCandidates(query, false, [id(1), id(2)]);
    for (const statement of statements.filter((s) =>
      s.text.includes('from "catalog"."products"'),
    )) {
      expect(statement.text).toContain('ANY(');
      expect(statement.values).toContainEqual([id(1), id(2)]);
    }
    statements.length = 0;
    failEnrichment = true;
    await expect(repo.listCandidates(query)).rejects.toMatchObject({
      cause: { message: 'isolated enrichment failure' },
    });
    expect(statements.at(-1)?.text).toBe('rollback');
  });
});
