import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { CatalogPriceFilter } from '../src/catalog-price-filter.js';
import type { CatalogConfig } from '../src/config.js';

describe('Catalog Pricing HTTP adapter (isolated provider fixture; not G7/Pricing homologation)', () => {
  let server: Server;
  let filter: CatalogPriceFilter;
  const seen: URL[] = [];
  let fail = false;
  const correlation = randomUUID();
  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      seen.push(url);
      if (
        req.headers.authorization !== 'Bearer catalog-own-fixture' ||
        req.headers['x-correlation-id'] !== correlation
      ) {
        res.writeHead(403).end();
        return;
      }
      if (fail) {
        res.writeHead(503).end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          items: url.searchParams
            .get('skus')!
            .split(',')
            .filter((sku) => sku !== 'missing')
            .map((sku) => ({
              sku,
              precio_regular: 120,
              precio_oferta: 90,
              currency: 'PEN',
              channel_id: null,
              valid_from: '2020-01-01T00:00:00Z',
              valid_until: null,
              price_version: 1,
              vigencia_id: 'fixture',
              origen: 'SKU_OVERRIDE',
            })),
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error();
    filter = new CatalogPriceFilter(
      { pricingOrigin: 'http://127.0.0.1:' + address.port } as CatalogConfig,
      { authorization: async () => 'Bearer catalog-own-fixture' },
    );
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    seen.length = 0;
    fail = false;
  });
  it('calls the existing batch route with its technical bearer, channel and one explicit at', async () => {
    const candidates = Array.from({ length: 201 }, (_, i) => ({
      sku: 'sku-' + i,
      productId: 'parent',
    }));
    expect(
      await filter.matchingProducts(
        candidates,
        {
          canal: 'CHATBOT',
          pagina: 1,
          tamanio: 1,
          orden: 'NOMBRE_ASC',
          precioMin: '90',
          precioMax: '90',
        },
        correlation,
      ),
    ).toEqual(['parent']);
    expect(seen).toHaveLength(3);
    expect(
      seen.every(
        (url) =>
          url.pathname === '/api/v1/precios' &&
          url.searchParams.get('canal') === 'CHATBOT',
      ),
    ).toBe(true);
    expect(new Set(seen.map((url) => url.searchParams.get('at'))).size).toBe(1);
  });
  it('treats omitted prices as absence and upstream failure as 503', async () => {
    const query = {
      canal: 'RETAIL' as const,
      pagina: 1,
      tamanio: 1,
      orden: 'NOMBRE_ASC' as const,
      precioMax: '100',
    };
    expect(
      await filter.matchingProducts(
        [{ productId: 'p', sku: 'missing' }],
        query,
        correlation,
      ),
    ).toEqual([]);
    fail = true;
    await expect(
      filter.matchingProducts(
        [{ productId: 'p', sku: 'valid' }],
        query,
        correlation,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
});
