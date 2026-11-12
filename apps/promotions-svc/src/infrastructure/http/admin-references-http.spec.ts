import { createServer } from 'node:http';
import { once } from 'node:events';
import { HttpAdminReferences } from './admin-references-http.js';
import type { InternalHttpOptions } from './internal-http.js';
import { CommercialDependencyError } from '../../domain/commercial-context.js';

async function fixture(
  work: (client: HttpAdminReferences, calls: string[]) => Promise<void>,
  change: (
    path: string,
    value: unknown,
  ) => { status?: number; body?: unknown } = (_p, body) => ({ body }),
  options: Omit<InternalHttpOptions, 'origin'> = { mode: 'RESTRICTED_DEMO' },
) {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    const path = req.url!;
    calls.push(path);
    expect(req.headers.authorization).toBe(
      options.mode === 'AUTHENTICATED'
        ? 'Bearer synthetic-own-service-token'
        : undefined,
    );
    const raw = path.includes('/skus/')
      ? {
          sku: '0001',
          productId: 'P',
          isVariant: false,
          active: true,
          eligible: true,
        }
      : path.includes('/categorias/')
        ? { categoriaId: 'C', nombre: 'Category', estado: 'ACTIVO', version: 1 }
        : {
            product_id: 'P',
            name: 'P',
            slug: 'p',
            categoria_id: 'C',
            marca_id: 'M',
            tipo_producto_id: 'T',
            tiene_variantes: false,
            sku_base: '0001',
            marca: { marca_id: 'M', name: 'M' },
            variants: [],
          };
    const value = change(path, raw);
    res.writeHead(value.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value.body ?? {}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error();
  try {
    await work(
      new HttpAdminReferences({
        origin: `http://127.0.0.1:${address.port}`,
        ...options,
      }),
      calls,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const refs = { products: ['P', 'P'], skus: ['0001'], categories: ['C'] };
describe('Authoritative HTTP admin references #74', () => {
  it('reads real HTTP DTOs, deduplicates and preserves opaque SKU without JWT in explicit demo', async () => {
    await fixture(async (client, calls) => {
      const result = await client.verify(refs, new AbortController().signal);
      expect([...result.products]).toEqual(['P']);
      expect([...result.skus]).toEqual(['0001']);
      expect([...result.categories]).toEqual(['C']);
      expect(calls).toEqual([
        '/api/v1/productos/P?canal=MARKETPLACE',
        '/api/v1/productos/skus/0001/contexto',
        '/api/v1/categorias/C',
      ]);
    });
  });
  it.each(['PUBLIC_READ_ONLY', 'AUTHENTICATED'] as const)(
    'supplies the required Marketplace channel in %s while preserving the credential boundary',
    async (mode) => {
      const tokens = vi.fn(async () => 'synthetic-own-service-token');
      await fixture(
        async (client, calls) => {
          const result = await client.verify(
            { products: ['P'], skus: [], categories: [] },
            new AbortController().signal,
          );
          expect([...result.products]).toEqual(['P']);
          expect(calls).toEqual(['/api/v1/productos/P?canal=MARKETPLACE']);
        },
        (path, body) => {
          if (
            new URL(path, 'http://fixture').searchParams.get('canal') !==
            'MARKETPLACE'
          )
            return { status: 400, body: { status: 400, code: 'VALIDACION' } };
          return { body };
        },
        { mode, getServiceAccessToken: tokens },
      );
      if (mode === 'AUTHENTICATED') {
        expect(tokens).toHaveBeenCalledExactlyOnceWith(
          {
            operationId: 'obtenerProducto',
            audience: 'api-productos',
            scope: 'catalogo:leer',
          },
          expect.any(AbortSignal),
        );
      } else expect(tokens).not.toHaveBeenCalled();
    },
  );
  it('treats a commercially hidden product as ineligible without claiming administrative absence', async () => {
    await fixture(
      async (client, calls) => {
        const result = await client.verify(
          { products: ['P'], skus: [], categories: [] },
          new AbortController().signal,
        );
        expect(result.products.size).toBe(0);
        expect(calls).toEqual(['/api/v1/productos/P?canal=MARKETPLACE']);
      },
      () => ({
        status: 404,
        body: { status: 404, code: 'PRODUCTO_NO_ENCONTRADO' },
      }),
      { mode: 'PUBLIC_READ_ONLY' },
    );
  });
  it('excludes inactive references while preserving their distinction from technical failure', async () => {
    await fixture(
      async (client) => {
        const result = await client.verify(refs, new AbortController().signal);
        expect(result.products.has('P')).toBe(true);
        expect(result.skus.size).toBe(0);
        expect(result.categories.size).toBe(0);
      },
      (path, body) => ({
        body: path.includes('/skus/')
          ? { ...(body as object), active: false }
          : path.includes('/categorias/')
            ? { ...(body as object), estado: 'INACTIVO' }
            : body,
      }),
    );
  });
  it('treats only the contractual 404 as an unavailable reference', async () => {
    await fixture(
      async (client) => {
        const result = await client.verify(
          { products: [], skus: [], categories: ['C'] },
          new AbortController().signal,
        );
        expect(result.categories.size).toBe(0);
      },
      () => ({
        status: 404,
        body: { status: 404, code: 'CATEGORIA_NO_ENCONTRADA' },
      }),
    );
  });
  it.each([401, 403, 503, 404])(
    'rejects technical/wrong-code response %i rather than validating absence',
    async (status) => {
      await fixture(
        async (client) => {
          await expect(
            client.verify(refs, new AbortController().signal),
          ).rejects.toBeInstanceOf(CommercialDependencyError);
        },
        () => ({ status, body: { status, code: 'WRONG_CODE' } }),
      );
    },
  );
  it('rejects mismatched category identity and corrupt DTO', async () => {
    for (const body of [
      { categoriaId: 'OTHER', nombre: 'C', estado: 'ACTIVO', version: 1 },
      { categoriaId: 'C', estado: 'ACTIVO' },
    ])
      await fixture(
        async (client) => {
          await expect(
            client.verify(
              { products: [], skus: [], categories: ['C'] },
              new AbortController().signal,
            ),
          ).rejects.toBeInstanceOf(CommercialDependencyError);
        },
        () => ({ body }),
      );
  });
  it('honors cancellation before any HTTP effects', async () => {
    await fixture(async (client, calls) => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        client.verify(refs, controller.signal),
      ).rejects.toBeInstanceOf(CommercialDependencyError);
      expect(calls).toEqual([]);
    });
  });
});
