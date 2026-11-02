import { IntegrationFailure } from './catalog-sku-context.client.js';
import { PricingClient, sumPrice } from './pricing.client.js';

const row = (sku: string, overrides: Record<string, unknown> = {}) => ({
  sku,
  precio_regular: 10.25,
  precio_oferta: 8.5,
  currency: 'PEN',
  channel_id: null,
  valid_from: '2026-01-01T00:00:00Z',
  valid_until: null,
  price_version: 4,
  vigencia_id: `validity-${sku}`,
  origen: 'PRODUCTO',
  ...overrides,
});

describe('PricingClient', () => {
  it('queries the contractual batch operation with one instant, channel, auth and correlation', async () => {
    let requestUrl = '';
    let requestHeaders: HeadersInit | undefined;
    const client = new PricingClient(
      'http://pricing-svc:3002',
      () => 'pricing-token',
      async (url, init) => {
        requestUrl = String(url);
        requestHeaders = init?.headers;
        return Response.json({ items: [row('0001'), row('0002')] });
      },
    );
    const prices = await client.getPrices(
      ['0001', '0002'],
      '2026-11-02T00:00:00.000Z',
      'WEB',
      'corr',
    );
    const url = new URL(requestUrl);
    expect(url.pathname).toBe('/api/v1/precios');
    expect(url.searchParams.get('skus')).toBe('0001,0002');
    expect(url.searchParams.get('at')).toBe('2026-11-02T00:00:00.000Z');
    expect(url.searchParams.get('canal')).toBe('WEB');
    expect(new Headers(requestHeaders).get('authorization')).toBe(
      'Bearer pricing-token',
    );
    expect(new Headers(requestHeaders).get('x-correlation-id')).toBe('corr');
    expect(
      sumPrice(
        prices,
        new Map([
          ['0001', 2],
          ['0002', 3],
        ]),
        'precio_regular',
      ),
    ).toBe(5125n);
    expect(
      sumPrice(
        prices,
        new Map([
          ['0001', 2],
          ['0002', 3],
        ]),
        'precio_publico',
      ),
    ).toBe(4250n);
  });
  it('uses the individual contractual operation for an SKU containing a comma', async () => {
    let requestUrl = '';
    const client = new PricingClient(
      'http://pricing-svc:3002',
      () => 't',
      async (url) => {
        requestUrl = String(url);
        return Response.json(row('SKU,002'));
      },
    );
    const prices = await client.getPrices(
      ['SKU,002'],
      '2026-11-02T00:00:00Z',
      undefined,
      'c',
    );
    expect(new URL(requestUrl).pathname).toBe('/api/v1/precios/skus/SKU%2C002');
    expect(prices[0]?.sku).toBe('SKU,002');
  });
  it('uses regular as public effective price when there is no valid offer', async () => {
    const client = new PricingClient(
      'http://pricing-svc',
      () => 't',
      async () => Response.json({ items: [row('1', { precio_oferta: null })] }),
    );
    const prices = await client.getPrices(
      ['1'],
      '2026-11-02T00:00:00Z',
      undefined,
      'c',
    );
    expect(prices[0]?.precio_publico).toBe('10.25');
  });
  it('accepts omitted optional offer/end fields and uses the regular price', async () => {
    const { precio_oferta: _offer, valid_until: _end, ...wirePrice } = row('1');
    const client = new PricingClient(
      'http://pricing-svc',
      () => 't',
      async () => Response.json({ items: [wirePrice] }),
    );
    const [price] = await client.getPrices(
      ['1'],
      '2026-11-02T00:00:00Z',
      undefined,
      'c',
    );
    expect(price?.precio_publico).toBe('10.25');
  });
  it('rejects mixed currencies, incomplete results and out-of-instant prices', async () => {
    const client = (payload: unknown) =>
      new PricingClient(
        'http://pricing-svc',
        () => 't',
        async () => Response.json(payload),
      );
    await expect(
      client({ items: [row('1'), row('2', { currency: 'USD' })] }).getPrices(
        ['1', '2'],
        '2026-11-02T00:00:00Z',
        undefined,
        'c',
      ),
    ).rejects.toMatchObject({ reason: 'CONTEXT_MISMATCH' });
    await expect(
      client({ items: [row('1')] }).getPrices(
        ['1', '2'],
        '2026-11-02T00:00:00Z',
        undefined,
        'c',
      ),
    ).rejects.toMatchObject({ reason: 'PRICE_MISSING' });
    await expect(
      client({
        items: [row('1', { valid_from: '2027-01-01T00:00:00Z' })],
      }).getPrices(['1'], '2026-11-02T00:00:00Z', undefined, 'c'),
    ).rejects.toMatchObject({ reason: 'PRICE_NOT_CURRENT' });
  });
  it.each([
    ['price_version', undefined],
    ['price_version', -1],
    ['vigencia_id', undefined],
    ['vigencia_id', ''],
    ['origen', undefined],
    ['origen', 'UNKNOWN'],
  ])('rejects invalid required Precio field %s', async (field, value) => {
    const invalid = row('1');
    if (value === undefined) delete (invalid as Record<string, unknown>)[field];
    else Object.assign(invalid, { [field]: value });
    const client = new PricingClient(
      'http://pricing-svc',
      () => 't',
      async () => Response.json({ items: [invalid] }),
    );
    await expect(
      client.getPrices(['1'], '2026-11-02T00:00:00Z', undefined, 'c'),
    ).rejects.toMatchObject({ reason: 'INVALID_RESPONSE' });
  });
  it('fails closed on missing credentials and distinguishes upstream auth, 503, timeout and network', async () => {
    await expect(
      new PricingClient('http://pricing-svc', () => undefined).getPrices(
        ['1'],
        '2026-11-02T00:00:00Z',
        undefined,
        'c',
      ),
    ).rejects.toMatchObject({ reason: 'AUTH_NOT_CONFIGURED' });
    for (const [status, reason] of [
      [401, 'SERVICE_AUTH_REJECTED'],
      [403, 'SERVICE_AUTH_REJECTED'],
      [503, 'UNAVAILABLE'],
    ] as const) {
      const client = new PricingClient(
        'http://pricing-svc',
        () => 't',
        async () => new Response(null, { status }),
      );
      await expect(
        client.getPrices(['1'], '2026-11-02T00:00:00Z', undefined, 'c'),
      ).rejects.toMatchObject({ reason, upstreamStatus: status });
    }
    const timeout = new PricingClient(
      'http://pricing-svc',
      () => 't',
      async () => {
        throw new DOMException('timeout', 'TimeoutError');
      },
    );
    await expect(
      timeout.getPrices(['1'], '2026-11-02T00:00:00Z', undefined, 'c'),
    ).rejects.toBeInstanceOf(IntegrationFailure);
    await expect(
      timeout.getPrices(['1'], '2026-11-02T00:00:00Z', undefined, 'c'),
    ).rejects.toMatchObject({ reason: 'TIMEOUT' });
    const network = new PricingClient(
      'http://pricing-svc',
      () => 't',
      async () => {
        throw new TypeError('network');
      },
    );
    await expect(
      network.getPrices(['1'], '2026-11-02T00:00:00Z', undefined, 'c'),
    ).rejects.toMatchObject({ reason: 'NETWORK_FAILURE' });
  });
});
