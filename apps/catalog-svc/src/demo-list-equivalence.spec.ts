import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Database } from './database.js';
import { PostgresCatalogRepository } from './postgres-catalog.repository.js';
import { CommercialService } from './commercial.service.js';
import type { CatalogConfig } from './config.js';
import type { TaxonomyClient } from './taxonomy.client.js';
import type { ProductQuery } from './commercial.types.js';

// Controlled driver fixture, NOT PostgreSQL or a Pricing integration benchmark.
// These response assertions were run against 6278b68 before replacing the N+1.
describe('Preview list response baseline (#49)', () => {
  const ids = Array.from(
    { length: 36 },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  );
  let count = 36;
  let failure = false;
  const statements: { text: string; values: unknown[] }[] = [];
  const own = (i: number) =>
    i % 3 === 0
      ? ['https://placehold.co/no.png', 'http://example.test/no.png']
      : ['https://example.test/principal.png', 'https://example.test/own.png'];
  const children = (i: number) =>
    i % 6 === 0
      ? ['https://placehold.co/no.png']
      : ['https://example.test/child.png', 'https://example.test/child.png'];
  const attrs = (i: number) => ['material', 'Material', null, `Cotton ${i}`];
  const client = {
    release() {},
    async query(config: string | { text: string }, values: unknown[] = []) {
      const text = typeof config === 'string' ? config : config.text;
      statements.push({ text, values });
      if (failure && text !== 'rollback') throw new Error('private DB error');
      if (text.includes('from "catalog"."products"')) {
        let indices = Array.from({ length: count }, (_, i) => i);
        if (text.includes('"nombre" desc')) indices.reverse();
        const pageSize = Number(values.at(-1));
        if (text.includes('"nombre" >') || text.includes('"nombre" <')) {
          const cursorName = values.find(
            (value) => typeof value === 'string' && /^Item \d+$/.test(value),
          );
          const cursorId = values.find(
            (value) => typeof value === 'string' && ids.includes(value),
          );
          const cursorIndex = ids.indexOf(String(cursorId));
          indices = indices.filter((i) =>
            text.includes('"nombre" desc')
              ? `Item ${String(i).padStart(2, '0')}` < String(cursorName) ||
                (`Item ${String(i).padStart(2, '0')}` === cursorName &&
                  i > cursorIndex)
              : `Item ${String(i).padStart(2, '0')}` > String(cursorName) ||
                (`Item ${String(i).padStart(2, '0')}` === cursorName &&
                  i > cursorIndex),
          );
        }
        indices = indices.slice(0, pageSize);
        return {
          rows: indices.map((i) => [
            ids[i],
            `item-${i}`,
            `Item ${String(i).padStart(2, '0')}`,
            'Draft',
            'category',
            'type',
            'brand',
            false,
            `000${i}`,
          ]),
        };
      }
      const requestedIds = Array.isArray(values[0]) ? values[0] : values;
      const selected = ids
        .slice(0, count)
        .filter((id) => requestedIds.includes(id));
      if (text.includes('catalog.product_images'))
        return {
          rows: selected.flatMap((id) =>
            own(ids.indexOf(id)).map((url) => ({ product_id: id, url })),
          ),
        };
      if (text.includes('catalog.variants v JOIN catalog.variant_images'))
        return {
          rows: selected.flatMap((id) =>
            children(ids.indexOf(id)).map((url) => ({ product_id: id, url })),
          ),
        };
      if (text.includes('from "catalog"."product_attribute_values"')) {
        const grouped = text.includes('"product_id",');
        return {
          rows: selected.map((id) =>
            grouped ? [id, ...attrs(ids.indexOf(id))] : attrs(ids.indexOf(id)),
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
  const repository = new PostgresCatalogRepository({
    read: <T>(read: (connection: typeof db) => Promise<T>) => read(db),
  } as unknown as Database);
  const pricing = {
    currentPrice: vi.fn(async (id: string) =>
      ids.indexOf(id) % 7 === 0
        ? null
        : { precio_regular: 10, precio_oferta: null, currency: 'PEN' },
    ),
  };
  const service = new CommercialService(
    repository,
    { category: vi.fn(), brand: vi.fn() } as unknown as TaxonomyClient,
    { enabled: false },
    { marketplaceDemoPreview: true } as CatalogConfig,
    pricing,
  );
  const query: ProductQuery = {
    canal: 'MARKETPLACE',
    pagina: 1,
    tamanio: 4,
    orden: 'NOMBRE_ASC',
  };
  beforeEach(() => {
    count = 36;
    failure = false;
    statements.length = 0;
    vi.clearAllMocks();
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
  )('preserves full response $tamanio/$pagina/$orden', async (page) => {
    const result = await service.list({ ...query, ...page });
    const eligible = ids
      .map((_, i) => i)
      .filter((i) => i % 6 !== 0 && i % 7 !== 0);
    if (page.orden === 'NOMBRE_DESC') eligible.reverse();
    expect(result).toEqual({
      total: eligible.length,
      pagina: page.pagina,
      tamanio: page.tamanio,
      items: eligible
        .slice((page.pagina - 1) * page.tamanio, page.pagina * page.tamanio)
        .map((i) => ({
          product_id: ids[i],
          slug: `item-${i}`,
          name: `Item ${String(i).padStart(2, '0')}`,
          description: 'Draft',
          categoria_id: 'category',
          tipo_producto_id: 'type',
          marca_id: 'brand',
          tiene_variantes: false,
          sku_base: `000${i}`,
          images: i % 3 === 0 ? children(i) : own(i),
          attributes: [
            {
              caracteristica_id: 'material',
              nombre: 'Material',
              valor_id: null,
              valor: `Cotton ${i}`,
            },
          ],
          precio_regular: 10,
          precio_oferta: null,
          currency: 'PEN',
        })),
    });
    expect(pricing.currentPrice).toHaveBeenCalledTimes(30);
    expect(statements[0].text).toContain('repeatable read read only');
    expect(statements.at(-1)?.text).toBe('commit');
  });

  it('keeps filters parameterized and uses deterministic keyset pages of at most 100', async () => {
    await repository.listDemoCandidates(
      {
        ...query,
        q: "x%_\\'",
        categoriaId: 'category',
        marcaId: 'brand',
        orden: 'NOMBRE_DESC',
      },
      100,
    );
    const candidate = statements[1];
    expect(candidate.text).toContain('"nombre" desc');
    expect(candidate.text).toContain('"id" asc');
    expect(candidate.text).not.toContain("x%_\\'");
    expect(candidate.values.at(-1)).toBe(100);
    statements.length = 0;
    // Six rows lack usable images and are excluded after each keyset page is enriched.
    expect(await repository.listDemoCandidates(query, 1)).toHaveLength(30);
    expect(
      statements.filter((statement) =>
        statement.text.includes('from "catalog"."products"'),
      ),
    ).toHaveLength(37); // 36 keyset pages plus the terminating empty read.
    expect(statements.at(-1)?.text).toBe('commit');
  });

  it('keeps one correlation across all four measured stages and every Pricing candidate', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await service.list(query, id);
      const logs = output.mock.calls.map(
        ([line]) => JSON.parse(String(line)).message,
      );
      expect(logs.map((log) => log.stage)).toEqual([
        'DEMO_CANDIDATES_SQL',
        'DEMO_ENRICHMENT_SQL',
        'DEMO_PRICING',
        'DEMO_LIST_TOTAL',
      ]);
      expect(logs.every((log) => log.correlationId === id)).toBe(true);
      expect(pricing.currentPrice).toHaveBeenCalledTimes(30);
      for (const call of pricing.currentPrice.mock.calls) {
        expect(call[0]).toEqual(expect.any(String));
        expect(call[1]).toBeLessThanOrEqual(2500);
        expect(call[2]).toBe(id);
        expect(call[3]).toBeInstanceOf(AbortSignal);
      }
    } finally {
      output.mockRestore();
    }
  });

  it('handles empty candidates and technical failures without a partial success', async () => {
    count = 0;
    expect(await service.list(query)).toEqual({
      items: [],
      pagina: 1,
      tamanio: 4,
      total: 0,
    });
    expect(pricing.currentPrice).not.toHaveBeenCalled();
    failure = true;
    await expect(service.list(query)).rejects.toMatchObject({ status: 503 });
    failure = false;
    count = 36;
    pricing.currentPrice.mockRejectedValueOnce(
      new Error('private Pricing error'),
    );
    await expect(service.list(query)).rejects.toMatchObject({ status: 503 });
  });

  it('aborts all Pricing work and returns 503 at the global preview deadline', async () => {
    vi.useFakeTimers();
    count = 36;
    let observedSignal: AbortSignal | undefined;
    const bounded = new CommercialService(
      repository,
      { category: vi.fn(), brand: vi.fn() } as unknown as TaxonomyClient,
      { enabled: false },
      { marketplaceDemoPreview: true } as CatalogConfig,
      {
        currentPrice: (_id, _timeout, _correlation, signal) => {
          observedSignal = signal;
          return new Promise((_, reject) =>
            signal?.addEventListener('abort', () => reject(new Error()), {
              once: true,
            }),
          );
        },
      },
    );
    try {
      const response = bounded.list(query).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(7000);
      await expect(response).resolves.toMatchObject({ status: 503 });
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds SQL count for 4 and 36 candidates (baseline: 10 and 79)', async () => {
    for (const size of [4, 36]) {
      count = size;
      statements.length = 0;
      await repository.listDemoCandidates(query, 100);
      const selects = statements.filter((s) =>
        /^(select|SELECT)/.test(s.text.trimStart()),
      );
      expect(selects.length).toBe(4);
    }
  });
});
