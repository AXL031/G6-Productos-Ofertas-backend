import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PostgresCatalogRepository } from './postgres-catalog.repository.js';
import type { Database } from './database.js';
import type { Canal } from './commercial.types.js';

describe('D-CAT-05/06 global eligibility SQL (isolated driver)', () => {
  const statements: { text: string; values: unknown[] }[] = [];
  let failure: Error | undefined;
  const client = {
    release() {},
    async query(config: string | { text: string }, values: unknown[] = []) {
      const text = typeof config === 'string' ? config : config.text;
      statements.push({ text, values });
      if (failure && text.startsWith('select')) throw failure;
      return { rows: text.includes('count(*)') ? [[0]] : [] };
    },
  };
  const db = drizzle({
    ...client,
    connect: async () => client,
  } as unknown as pg.Pool);
  const repository = new PostgresCatalogRepository({
    read: <T>(work: (connection: typeof db) => Promise<T>) => work(db),
  } as Database);
  const query = {
    canal: 'MARKETPLACE' as Canal,
    pagina: 2,
    tamanio: 3,
    orden: 'NOMBRE_ASC' as const,
  };
  beforeEach(() => {
    statements.length = 0;
    failure = undefined;
  });

  it.each<Canal>(['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'])(
    'uses the same SQL eligibility before count/page and for both details: %s',
    async (canal) => {
      await expect(
        repository.listCandidates({ ...query, canal }),
      ).resolves.toEqual({ items: [], total: 0, pagina: 2, tamanio: 3 });
      await expect(
        repository.findCandidateBySlug('missing', canal),
      ).resolves.toBeNull();
      await expect(
        repository.findCandidateByProductId('missing', canal),
      ).resolves.toBeNull();
      const reads = statements.filter((s) => s.text.startsWith('select'));
      expect(reads).toHaveLength(4);
      for (const statement of reads) {
        expect(statement.text).toContain(
          'exists (SELECT 1 FROM "catalog"."variants"',
        );
        expect(statement.text).toContain(
          '"product_id" = "catalog"."products"."id"',
        );
        expect(statement.text).not.toContain('sku_channel_eligibility');
        expect(statement.values).toContain('ACTIVO');
        expect(statement.values).toContain('ACTIVA');
        expect(statement.values).toContain(false);
        expect(statement.values).not.toContain(canal);
      }
      expect(reads[1].values.slice(-2)).toEqual([3, 3]);
      expect(reads[1].text).toContain(
        '"nombre" asc, "catalog"."products"."id" asc',
      );
    },
  );

  it.each(['BORRADOR', 'INACTIVO'] as const)(
    'preserves the explicit administrative state %s',
    async (estado) => {
      await repository.listCandidates({ ...query, estado });
      const count = statements.find((s) => s.text.includes('count(*)'))!;
      expect(count.values).toContain(estado);
      expect(count.text).not.toContain('exists');
    },
  );

  it('propagates database failure instead of fabricating an empty page', async () => {
    failure = new Error('isolated failure');
    await expect(repository.listCandidates(query)).rejects.toThrow();
    expect(statements.at(-1)?.text).toBe('rollback');
  });
});
