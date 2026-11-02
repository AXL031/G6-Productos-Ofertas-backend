import { ServiceUnavailableException } from '@nestjs/common';
import { PricingClient } from './pricing.client.js';
import type { CatalogConfig } from './config.js';
import { isCorrelationId } from './correlation.js';

const productId = '88888888-8888-4888-8888-888888888888';
const current = {
  product_id: productId,
  precio_regular: 69.9,
  precio_oferta: null,
  currency: 'PEN',
  channel_id: null,
  valid_from: '2026-01-01T00:00:00.000Z',
  valid_until: null,
  price_version: 1,
};

describe('PricingClient (mock HTTP responses)', () => {
  const fetchMock = vi.fn();
  const client = new PricingClient({
    pricingOrigin: 'http://pricing-svc:3002',
  } as CatalogConfig);

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('requests the private route, rejects redirects, and returns only validated current-price fields', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(current), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(client.currentPrice(productId)).resolves.toEqual({
      precio_regular: 69.9,
      precio_oferta: null,
      currency: 'PEN',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(`http://pricing-svc:3002/api/v1/precios/productos/${productId}`),
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('treats a Pricing 404 as no price', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ code: 'PRECIO_NO_ENCONTRADO', status: 404 }),
        {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    );
    await expect(client.currentPrice(productId)).resolves.toBeNull();
  });

  it('propagates the request correlation without changing the timeout or private route', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(current), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await client.currentPrice(productId, 2500, id);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      'X-Correlation-Id': id,
    });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('generates a technical correlation for standalone readiness requests', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(current), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await client.currentPrice(productId);
    expect(
      isCorrelationId(fetchMock.mock.calls[0][1].headers?.['X-Correlation-Id']),
    ).toBe(true);
  });

  it('rejects an invalid internal correlation before HTTP without exposing it', async () => {
    await expect(
      client.currentPrice(productId, 2500, 'Bearer private'),
    ).rejects.toMatchObject({
      status: 503,
      message: 'Servicio temporalmente no disponible',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not treat an unregistered Pricing route as a missing product price', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>not found</html>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      }),
    );
    await expect(client.currentPrice(productId)).rejects.toMatchObject({
      status: 503,
    });
  });

  it('checks Pricing readiness with one operation request', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ code: 'PRECIO_NO_ENCONTRADO', status: 404 }),
        {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    );
    await expect(client.checkReady()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it.each([
    { ...current, product_id: 'wrong' },
    { ...current, precio_regular: 0 },
    { ...current, valid_from: '2999-01-01T00:00:00.000Z' },
    { ...current, valid_from: '2026-02-30T00:00:00.000Z' },
    { ...current, valid_until: '2000-01-01T00:00:00.000Z' },
    { ...current, channel_id: 'marketplace' },
  ])('fails closed for invalid Price responses', async (body) => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(client.currentPrice(productId)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('maps Pricing network failures and redirects to 503 without details', async () => {
    fetchMock.mockRejectedValueOnce(new Error('private URL detail'));
    await expect(client.currentPrice(productId)).rejects.toMatchObject({
      status: 503,
      message: 'Servicio temporalmente no disponible',
    });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302 }));
    await expect(client.currentPrice(productId)).rejects.toMatchObject({
      status: 503,
    });
  });
});
