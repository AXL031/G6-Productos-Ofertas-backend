import { createServer } from 'node:http';
import { once } from 'node:events';
import { HttpCommercialContext } from './commercial-http.js';
import {
  CommercialDependencyError,
  CommercialInputError,
} from '../../domain/commercial-context.js';

// Explicit synthetic DTO server. It proves real HTTP transport and internal
// contract mapping only; neither G7 grants nor provider deployment is claimed.
const at = '2026-10-23T12:00:00Z';
const simple = (id = 'P') => ({
  product_id: id,
  slug: id,
  name: id,
  tipo_producto_id: 'TYPE',
  marca_id: 'BRAND',
  categoria_id: 'CAT',
  marca: { marca_id: 'BRAND', name: 'Synthetic Brand' },
  tiene_variantes: false,
  sku_base: 'S-' + id,
  variants: [],
});
const price = (sku = 'S-P') => ({
  sku,
  precio_regular: 100,
  precio_oferta: 80,
  currency: 'PEN',
  channel_id: null,
  valid_from: '2026-01-01T00:00:00Z',
  valid_until: null,
  price_version: 0,
  vigencia_id: 'VERSION',
  origen: 'PRODUCTO',
});
const basket = {
  channel_id: 'MARKETPLACE',
  lines: [{ sku: 'S-P', product_id: 'P', quantity: 2 }],
};
async function fixture(
  work: (
    client: HttpCommercialContext,
    calls: URL[],
    correlations: string[],
  ) => Promise<void>,
  change: (
    url: URL,
    value: unknown,
  ) => { status?: number; body?: unknown; location?: string } = (_u, body) => ({
    body,
  }),
) {
  const calls: URL[] = [];
  const correlations: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://fixture.invalid');
    calls.push(url);
    correlations.push(String(request.headers['x-correlation-id']));
    expect(request.method).toBe('GET');
    expect(request.headers.authorization).toBe(
      'Bearer synthetic-service-token',
    );
    expect(request.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/i);
    const raw =
      url.pathname.startsWith('/api/v1/productos/skus/') &&
      url.pathname.endsWith('/contexto')
        ? {
            sku: decodeURIComponent(
              url.pathname.slice(
                '/api/v1/productos/skus/'.length,
                -'/contexto'.length,
              ),
            ),
            productId: 'P',
            isVariant: false,
            active: true,
            eligible: true,
          }
        : url.pathname.startsWith('/api/v1/productos/')
          ? simple(
              decodeURIComponent(
                url.pathname.slice('/api/v1/productos/'.length),
              ),
            )
          : url.pathname.startsWith('/api/v1/precios/')
            ? price(
                decodeURIComponent(
                  url.pathname.slice('/api/v1/precios/skus/'.length),
                ),
              )
            : {
                items: (url.searchParams.get('skus') ?? '')
                  .split(',')
                  .map((sku) => ({ sku, status: 'STOCK_BAJO' })),
              };
    const result = change(url, raw);
    response.writeHead(result.status ?? 200, {
      'content-type': 'application/json',
      ...(result.location ? { location: result.location } : {}),
    });
    response.end(JSON.stringify(result.body ?? {}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const client = new HttpCommercialContext({
    origin: 'http://127.0.0.1:' + address.port,
    getServiceAccessToken: async (request) => {
      expect(request.audience).toBe('api-productos');
      expect([
        'catalogo:leer',
        'precios:leer',
        'inventario:disponibilidad:leer',
      ]).toContain(request.scope);
      return 'synthetic-service-token';
    },
  });
  try {
    await work(client, calls, correlations);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

describe('Candidate commercial HTTP client #72/#73', () => {
  it('uses one caller instant and correlation across origin, inventory and prices', async () => {
    await fixture(async (client, calls, traces) => {
      const context = {
        correlationId: '11111111-1111-4111-8111-111111111111',
        at,
      };
      await client.recommendationOrigin(
        'ORIGIN',
        'MARKETPLACE',
        undefined,
        context,
      );
      await client.recommendationProducts(
        ['P', 'Q'],
        'MARKETPLACE',
        undefined,
        context,
      );
      expect(traces.length).toBeGreaterThan(3);
      expect(new Set(traces)).toEqual(new Set([context.correlationId]));
      expect(
        calls
          .filter((u) => u.pathname.includes('/precios/'))
          .map((u) => u.searchParams.get('at')),
      ).toEqual([at, at]);
    });
  });
  it('keeps concurrent basket correlations isolated without shared request state', async () => {
    await fixture(async (client, _calls, traces) => {
      const first = '11111111-1111-4111-8111-111111111111',
        second = '22222222-2222-4222-8222-222222222222';
      await Promise.all(
        [first, second].map((correlationId) =>
          client.basket(
            { ...basket, lines: [{ sku: 'S-P', quantity: 1 }] },
            at,
            undefined,
            { at, correlationId },
          ),
        ),
      );
      expect(traces.filter((t) => t === first)).toHaveLength(3);
      expect(traces.filter((t) => t === second)).toHaveLength(3);
    });
  });
  it('resolves canonical product/SKU, channel and historical instant with exact decimal strings and per-call dedupe', async () => {
    await fixture(async (client, calls) => {
      const result = await client.basket(
        {
          ...basket,
          lines: [...basket.lines, { ...basket.lines[0], quantity: 1 }],
        },
        at,
      );
      expect(result.lines.map((l) => l.quantity)).toEqual([2, 1]);
      expect(result.lines[0]).toMatchObject({
        productId: 'P',
        sku: 'S-P',
        regular: '100',
        offer: '80',
        currency: 'PEN',
        active: true,
        channelEligible: true,
      });
      expect(calls).toHaveLength(2);
      expect(calls[1].searchParams.get('at')).toBe(at);
      expect(
        calls.every((u) => u.searchParams.get('canal') === 'MARKETPLACE'),
      ).toBe(true);
    });
  });
  it('resolves a published variant SKU without treating its variant ID as the SKU', async () => {
    await fixture(
      async (client) => {
        expect(
          (
            await client.basket(
              {
                ...basket,
                lines: [{ product_id: 'P', sku: 'VARIANT-SKU', quantity: 1 }],
              },
              at,
            )
          ).lines[0].sku,
        ).toBe('VARIANT-SKU');
      },
      (url, body) => ({
        body: url.pathname.includes('/productos/')
          ? {
              ...simple(),
              tiene_variantes: true,
              sku_base: null,
              variants: [{ variant_id: 'V', sku: 'VARIANT-SKU' }],
            }
          : body,
      }),
    );
  });
  it('resolves missing product_id through the newly authorized skuContext and preserves VENTAS rejection', async () => {
    await fixture(async (client, calls) => {
      const resolved = await client.basket(
        { ...basket, lines: [{ sku: 'S-P', quantity: 1 }] },
        at,
      );
      expect(resolved.lines[0].productId).toBe('P');
      expect(calls[0].pathname).toBe('/api/v1/productos/skus/S-P/contexto');
      await expect(
        client.basket({ ...basket, channel_id: 'VENTAS' }, at),
      ).rejects.toBeInstanceOf(CommercialDependencyError);
      expect(calls).toHaveLength(3);
    });
  });
  it('maps simple-product recommendation facts from independent price and commercial availability calls', async () => {
    await fixture(async (client, calls) => {
      expect(await client.recommendationOrigin('P', 'MARKETPLACE')).toEqual({
        active: true,
        channelEligible: true,
        categoryId: 'CAT',
      });
      const facts = await client.recommendationProducts(
        ['P', 'P'],
        'MARKETPLACE',
      );
      expect(facts.get('P')).toEqual({
        active: true,
        channelEligible: true,
        currentPrice: 80,
        availability: 'STOCK_BAJO',
      });
      expect(facts.size).toBe(1);
      expect(
        calls.some(
          (u) => u.pathname === '/api/v1/inventario/disponibilidad/comercial',
        ),
      ).toBe(true);
    });
  });
  it('uses the minimum price of positive variants without selecting a SKU or summing stock', async () => {
    await fixture(
      async (client, calls) => {
        const result = await client.recommendationProducts(
          ['P'],
          'MARKETPLACE',
        );
        expect(result.get('P')).toMatchObject({
          availability: 'DISPONIBLE',
          currentPrice: 50,
        });
        const instants = calls
          .filter((u) => u.pathname.includes('/precios/'))
          .map((u) => u.searchParams.get('at'));
        expect(new Set(instants).size).toBe(1);
        expect(
          calls.some((u) => u.searchParams.get('skus') === 'SKU-A,SKU-B'),
        ).toBe(true);
      },
      (url, body) => ({
        body: url.pathname.includes('/productos/')
          ? {
              ...(body as object),
              tiene_variantes: true,
              sku_base: null,
              variants: [
                { variant_id: 'A', sku: 'SKU-A' },
                { variant_id: 'B', sku: 'SKU-B' },
              ],
            }
          : url.pathname.includes('/inventario/')
            ? {
                items: [
                  { sku: 'SKU-A', status: 'DISPONIBLE' },
                  { sku: 'SKU-B', status: 'STOCK_BAJO' },
                ],
              }
            : url.pathname.endsWith('SKU-A')
              ? { ...price('SKU-A'), precio_oferta: 70 }
              : { ...price('SKU-B'), precio_oferta: 50 },
      }),
    );
  });
  it('excludes candidates with no positive availability without fabricating AGOTADO', async () => {
    for (const items of [
      [],
      [{ sku: 'S-P', status: 'INDETERMINADO' }],
      [{ sku: 'S-P', status: 'AGOTADO' }],
    ])
      await fixture(
        async (client) => {
          const result = await client.recommendationProducts(
            ['P'],
            'MARKETPLACE',
          );
          expect(result.has('P')).toBe(true);
          expect(result.get('P')).toBeNull();
        },
        (url, body) => ({
          body: url.pathname.includes('/inventario/') ? { items } : body,
        }),
      );
  });
  it('rejects corrupt or duplicate availability instead of hiding a dependency error', async () => {
    for (const items of [
      [{ sku: 'OTHER', status: 'AGOTADO' }],
      [
        { sku: 'S-P', status: 'DISPONIBLE' },
        { sku: 'S-P', status: 'DISPONIBLE' },
      ],
    ]) {
      await fixture(
        async (client) => {
          await expect(
            client.recommendationProducts(['P'], 'MARKETPLACE'),
          ).rejects.toBeInstanceOf(CommercialDependencyError);
        },
        (url, body) => ({
          body: url.pathname.includes('/inventario/') ? { items } : body,
        }),
      );
    }
  });
  it('does not price unknown-stock SKU when another variant has positive stock', async () => {
    await fixture(
      async (client, calls) => {
        expect(
          (await client.recommendationProducts(['P'], 'MARKETPLACE')).get('P'),
        ).toMatchObject({ availability: 'STOCK_BAJO', currentPrice: 80 });
        expect(
          calls
            .filter((u) => u.pathname.includes('/precios/'))
            .map((u) => u.pathname),
        ).toEqual(['/api/v1/precios/skus/A']);
      },
      (url, body) => ({
        body: url.pathname.includes('/productos/')
          ? {
              ...simple(),
              tiene_variantes: true,
              sku_base: null,
              variants: [
                { variant_id: '1', sku: 'A' },
                { variant_id: '2', sku: 'B' },
              ],
            }
          : url.pathname.includes('/inventario/')
            ? {
                items: [
                  { sku: 'A', status: 'STOCK_BAJO' },
                  { sku: 'B', status: 'INDETERMINADO' },
                ],
              }
            : body,
      }),
    );
  });
  it('excludes a legitimate missing price but propagates a technical pricing failure', async () => {
    for (const status of [404, 503])
      await fixture(
        async (client) => {
          const response = client.recommendationProducts(['P'], 'MARKETPLACE');
          if (status === 404) expect((await response).get('P')).toBeNull();
          else
            await expect(response).rejects.toBeInstanceOf(
              CommercialDependencyError,
            );
        },
        (url, body) => ({
          status: url.pathname.includes('/precios/') ? status : 200,
          body:
            url.pathname.includes('/precios/') && status === 404
              ? { status: 404, code: 'PRECIO_NO_ENCONTRADO' }
              : body,
        }),
      );
  });
  it('rejects mixed currencies across positive candidates', async () => {
    await fixture(
      async (client) => {
        await expect(
          client.recommendationProducts(['P', 'Q'], 'MARKETPLACE'),
        ).rejects.toBeInstanceOf(CommercialDependencyError);
      },
      (url, body) => ({
        body: url.pathname.endsWith('S-Q')
          ? { ...price('S-Q'), currency: 'USD' }
          : body,
      }),
    );
  });
  it('rejects ineligible context before resolving a missing product or querying prices', async () => {
    await fixture(
      async (client, calls) => {
        await expect(
          client.basket(
            { ...basket, lines: [{ sku: 'S-P', quantity: 1 }] },
            at,
          ),
        ).rejects.toBeInstanceOf(CommercialDependencyError);
        expect(calls).toHaveLength(1);
      },
      (url, body) => ({
        body: url.pathname.endsWith('/contexto')
          ? { ...(body as object), active: false }
          : body,
      }),
    );
  });
  it('classifies a mismatched product/SKU as invalid input', async () => {
    await fixture(async (client) => {
      await expect(
        client.basket(
          { ...basket, lines: [{ product_id: 'P', sku: 'S-Q', quantity: 1 }] },
          at,
        ),
      ).rejects.toBeInstanceOf(CommercialInputError);
    });
  });
  it.each([401, 403, 429, 500, 503])(
    'sanitizes HTTP %i without retrying or exposing provider errors',
    async (status) => {
      await fixture(
        async (client, calls) => {
          await expect(client.basket(basket, at)).rejects.toMatchObject({
            message: 'COMMERCIAL_CONTEXT_UNAVAILABLE',
          });
          expect(calls).toHaveLength(1);
        },
        () => ({ status, body: { detail: 'private-diagnostic' } }),
      );
    },
  );
  it('treats product 404 as not commercially visible for origin, not an admin absence or a zero price', async () => {
    await fixture(
      async (client) => {
        expect(
          await client.recommendationOrigin('P', 'MARKETPLACE'),
        ).toMatchObject({ active: false, channelEligible: false });
        await expect(client.basket(basket, at)).rejects.toBeInstanceOf(
          CommercialDependencyError,
        );
      },
      () => ({
        status: 404,
        body: { status: 404, code: 'PRODUCTO_NO_ENCONTRADO' },
      }),
    );
  });
  it.each([
    { sku: 'WRONG' },
    { channel_id: 'RETAIL' },
    { precio_regular: 0 },
    { precio_oferta: 101 },
    { valid_from: '2027-01-01T00:00:00Z' },
    { valid_until: at },
    { price_version: -1 },
    { vigencia_id: '' },
  ])('rejects incoherent price response %j', async (changes) => {
    await fixture(
      async (client) => {
        await expect(client.basket(basket, at)).rejects.toBeInstanceOf(
          CommercialDependencyError,
        );
      },
      (url, body) => ({
        body: url.pathname.includes('/precios/')
          ? { ...price(), ...changes }
          : body,
      }),
    );
  });
  it('rejects noncanonical SKU, duplicate variants and mismatching product identities', async () => {
    for (const changes of [
      { sku_base: 'OTHER' },
      { product_id: 'OTHER' },
      { marca: {} },
      {
        tiene_variantes: true,
        variants: [
          { variant_id: 'V', sku: 'S-P' },
          { variant_id: 'W', sku: 'S-P' },
        ],
      },
    ]) {
      await fixture(
        async (client) => {
          await expect(client.basket(basket, at)).rejects.toBeInstanceOf(
            'sku_base' in changes
              ? CommercialInputError
              : CommercialDependencyError,
          );
        },
        (url, body) => ({
          body: url.pathname.includes('/productos/')
            ? { ...simple(), ...changes }
            : body,
        }),
      );
    }
  });
  it('rejects cross-origin redirects without forwarding its token', async () => {
    await fixture(
      async (client, calls) => {
        await expect(client.basket(basket, at)).rejects.toBeInstanceOf(
          CommercialDependencyError,
        );
        expect(calls).toHaveLength(1);
      },
      () => ({ status: 302, location: 'https://untrusted.invalid/' }),
    );
  });
  it('bounds a hanging token provider without a network request', async () => {
    const client = new HttpCommercialContext({
      origin: 'https://fixture.invalid',
      getServiceAccessToken: async () => new Promise(() => {}),
    });
    await expect(client.basket(basket, at)).rejects.toBeInstanceOf(
      CommercialDependencyError,
    );
  });
  it('does not invoke the credential provider for an already canceled call', async () => {
    const getServiceAccessToken = vi.fn(async () => 'synthetic-token');
    const client = new HttpCommercialContext({
      origin: 'https://fixture.invalid',
      getServiceAccessToken,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.basket(basket, at, controller.signal),
    ).rejects.toBeInstanceOf(CommercialDependencyError);
    expect(getServiceAccessToken).not.toHaveBeenCalled();
  });
  it('rejects an oversized HTTP response without exposing the body or returning partial facts', async () => {
    await fixture(
      async (client, calls) => {
        await expect(client.basket(basket, at)).rejects.toMatchObject({
          message: 'COMMERCIAL_CONTEXT_UNAVAILABLE',
        });
        expect(calls).toHaveLength(1);
      },
      () => ({ body: { oversized: 'x'.repeat(1_048_577) } }),
    );
  });
  it.each([
    'http://example.org',
    'https://name:password@example.org',
    'https://example.org/api',
    'https://example.org?key=value',
  ])('rejects unsafe configured origin %s', (origin) => {
    expect(
      () =>
        new HttpCommercialContext({
          origin,
          getServiceAccessToken: async () => null,
        }),
    ).toThrow();
  });
});
