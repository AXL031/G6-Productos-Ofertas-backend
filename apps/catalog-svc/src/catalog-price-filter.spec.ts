import { CatalogPriceFilter } from './catalog-price-filter.js';
import { compareDecimal, parseDecimalJson } from './decimal.js';
import { parseProductQuery } from './catalog-query.js';
import type { CatalogConfig } from './config.js';

describe('D-CAT price filtering (isolated HTTP fixtures, no external grant claim)', () => {
  const query = {
    canal: 'RETAIL' as const,
    pagina: 1,
    tamanio: 20,
    orden: 'NOMBRE_ASC' as const,
    precioMin: '80',
    precioMax: '100',
  };
  const identity = {
    authorization: vi.fn(async () => 'Bearer catalog-technical-fixture'),
  };
  const filter = new CatalogPriceFilter(
    { pricingOrigin: 'http://pricing-svc:3002' } as CatalogConfig,
    identity,
  );
  const row = (sku: string, price = 90) => ({
    sku,
    precio_regular: price,
    precio_oferta: null,
    currency: 'PEN',
    channel_id: 'RETAIL',
    valid_from: '2020-01-01T00:00:00Z',
    valid_until: null,
    price_version: 1,
    vigencia_id: 'validity',
    origen: 'PRODUCTO',
  });
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const response = (items: unknown[]) =>
    new Response(JSON.stringify({ items }), {
      headers: { 'content-type': 'application/json' },
    });

  it('omits authorization and never invokes G7 in restricted demo', async () => {
    fetchMock.mockResolvedValue(response([row('sku')]));
    const demo = new CatalogPriceFilter(
      {
        pricingOrigin: 'http://pricing-svc:3002',
        readDemo: { enabled: false, restricted: true },
      } as CatalogConfig,
      identity,
    );
    expect(
      await demo.matchingProducts([{ productId: 'p', sku: 'sku' }], query),
    ).toEqual(['p']);
    expect(identity.authorization).not.toHaveBeenCalled();
    const init = fetchMock.mock.calls[0][1];
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
  });

  it('preserves decimal bounds and wire numbers without binary rounding or exponent expansion', () => {
    expect(
      parseProductQuery({ canal: 'RETAIL', precioMin: '9007199254740992.01' })
        .precioMin,
    ).toBe('9007199254740992.01');
    expect(() =>
      parseProductQuery({
        canal: 'RETAIL',
        precioMin: '9007199254740992.02',
        precioMax: '9007199254740992.01',
      }),
    ).toThrow();
    expect(compareDecimal('9007199254740992.01', '9007199254740992.02')).toBe(
      -1,
    );
    expect(compareDecimal('1e-999999999999999999999', '0')).toBe(1);
    expect(compareDecimal('1.00', '100e-2')).toBe(0);
    expect(
      parseDecimalJson('{"sku":"code123","price":9007199254740992.01}'),
    ).toEqual({ sku: 'code123', price: '9007199254740992.01' });
  });

  it('uses a resolved offer, includes either variant, and deduplicates parent products', async () => {
    fetchMock.mockResolvedValue(
      response([
        { ...row('simple', 120), precio_oferta: 90 },
        row('v1', 85),
        row('v2', 95),
        row('v3', 140),
      ]),
    );
    expect(
      await filter.matchingProducts(
        [
          { productId: 'simple-p', sku: 'simple' },
          ...['v1', 'v2', 'v3'].map((sku) => ({ productId: 'parent', sku })),
        ],
        query,
      ),
    ).toEqual(['simple-p', 'parent']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/v1/precios?');
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer catalog-technical-fixture',
    });
  });

  it.each([
    { precioMin: '90' },
    { precioMax: '90' },
    { precioMin: '90', precioMax: '90' },
  ])('includes exact unilateral/bilateral bounds %j', async (bounds) => {
    fetchMock.mockResolvedValue(response([row('s')]));
    expect(
      await filter.matchingProducts([{ productId: 'p', sku: 's' }], {
        ...query,
        precioMin: undefined,
        precioMax: undefined,
        ...bounds,
      }),
    ).toEqual(['p']);
  });

  it('does not round a JSON monetary value at the limit', async () => {
    const text = JSON.stringify({ items: [row('s')] }).replace(
      '"precio_regular":90',
      '"precio_regular":9007199254740992.01',
    );
    fetchMock.mockResolvedValue(
      new Response(text, { headers: { 'content-type': 'application/json' } }),
    );
    expect(
      await filter.matchingProducts([{ productId: 'p', sku: 's' }], {
        ...query,
        precioMin: '9007199254740992.02',
        precioMax: undefined,
      }),
    ).toEqual([]);
  });

  it('excludes other currencies and absent prices without inventing a fallback', async () => {
    fetchMock.mockResolvedValue(response([{ ...row('s'), currency: 'USD' }]));
    expect(
      await filter.matchingProducts(
        [
          { productId: 'p', sku: 's' },
          { productId: 'missing', sku: 'missing' },
        ],
        query,
      ),
    ).toEqual([]);
    fetchMock.mockResolvedValue(response([]));
    expect(
      await filter.matchingProducts([{ productId: 'p', sku: 's' }], query),
    ).toEqual([]);
  });

  it('evaluates all 251 SKU in batches <=100 with one at/channel/correlation and deduplicates SKU', async () => {
    fetchMock.mockImplementation(async (url) =>
      response(
        new URL(String(url)).searchParams
          .get('skus')!
          .split(',')
          .map((sku) => row(sku)),
      ),
    );
    const candidates = Array.from({ length: 251 }, (_, i) => ({
      productId: 'p' + i,
      sku: 's' + i,
    }));
    expect(
      await filter.matchingProducts(
        [...candidates, candidates[0]],
        query,
        'fixture-correlation',
      ),
    ).toHaveLength(251);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    expect(
      urls.map((url) => url.searchParams.get('skus')!.split(',').length),
    ).toEqual([100, 100, 51]);
    expect(new Set(urls.map((url) => url.searchParams.get('at'))).size).toBe(1);
    expect(
      urls.every((url) => url.searchParams.get('canal') === 'RETAIL'),
    ).toBe(true);
  });

  it.each([
    ['duplicate', [row('s'), row('s')]],
    ['unexpected', [row('unexpected')]],
    ['string money', [{ ...row('s'), precio_regular: '90' }]],
    ['expired', [{ ...row('s'), valid_until: '2020-01-02T00:00:00Z' }]],
    ['wrong channel', [{ ...row('s'), channel_id: 'CHATBOT' }]],
    ['missing validity', [{ ...row('s'), vigencia_id: undefined }]],
  ])('rejects invalid Pricing response: %s', async (_description, items) => {
    fetchMock.mockResolvedValue(response(items));
    await expect(
      filter.matchingProducts([{ productId: 'p', sku: 's' }], query),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('fails the whole query when a later batch fails', async () => {
    fetchMock.mockImplementation(async (url) =>
      new URL(String(url)).searchParams.get('skus')!.includes('s200')
        ? new Response('', { status: 503 })
        : response(
            new URL(String(url)).searchParams
              .get('skus')!
              .split(',')
              .map((sku) => row(sku)),
          ),
    );
    await expect(
      filter.matchingProducts(
        Array.from({ length: 201 }, (_, i) => ({
          productId: 'p' + i,
          sku: 's' + i,
        })),
        query,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('requires its own configured identity, never an incoming consumer token', async () => {
    await expect(
      new CatalogPriceFilter({
        pricingOrigin: 'http://pricing-svc:3002',
      } as CatalogConfig).matchingProducts(
        [{ productId: 'p', sku: 's' }],
        query,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds a stalled token provider as well as HTTP to 5 seconds', async () => {
    vi.useFakeTimers();
    const hanging = new CatalogPriceFilter(
      { pricingOrigin: 'http://pricing-svc:3002' } as CatalogConfig,
      { authorization: () => new Promise<string>(() => {}) },
    );
    const result = expect(
      hanging.matchingProducts([{ productId: 'p', sku: 's' }], query),
    ).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(5001);
    await result;
  });

  it('omits channel for a global human query and rejects channel-specific results', async () => {
    fetchMock.mockResolvedValue(response([{ ...row('s'), channel_id: null }]));
    expect(
      await filter.matchingProducts([{ productId: 'p', sku: 's' }], {
        ...query,
        canal: undefined,
      }),
    ).toEqual(['p']);
    expect(
      new URL(String(fetchMock.mock.calls[0][0])).searchParams.has('canal'),
    ).toBe(false);
    fetchMock.mockResolvedValue(response([row('s')]));
    await expect(
      filter.matchingProducts([{ productId: 'p', sku: 's' }], {
        ...query,
        canal: undefined,
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('uses the individual published operation for an opaque SKU containing commas', async () => {
    const sku = '000,azul ?#';
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(row(sku)), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(
      await filter.matchingProducts([{ productId: 'p', sku }], query),
    ).toEqual(['p']);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe(
      '/api/v1/precios/skus/' + encodeURIComponent(sku),
    );
    expect(url.searchParams.has('skus')).toBe(false);
    expect(url.searchParams.get('canal')).toBe('RETAIL');
  });
});
