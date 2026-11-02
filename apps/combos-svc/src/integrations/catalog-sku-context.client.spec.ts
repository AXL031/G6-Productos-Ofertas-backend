import {
  CatalogSkuContextClient,
  IntegrationFailure,
} from './catalog-sku-context.client.js';

describe('CatalogSkuContextClient', () => {
  const context = {
    sku: '000123',
    productId: 'p-1',
    isVariant: true,
    active: true,
    eligible: true,
  };
  it('encodes the opaque SKU and sends service auth and correlation unchanged', async () => {
    let target = '';
    let headers: HeadersInit | undefined;
    const client = new CatalogSkuContextClient(
      'http://catalog-svc:3001',
      () => 'service-token',
      async (url, init) => {
        target = String(url);
        headers = init?.headers;
        return Response.json(context);
      },
    );
    expect(await client.getContext('000123', 'corr-1')).toEqual(context);
    expect(target).toBe(
      'http://catalog-svc:3001/api/v1/productos/skus/000123/contexto',
    );
    expect(new Headers(headers).get('authorization')).toBe(
      'Bearer service-token',
    );
    expect(new Headers(headers).get('x-correlation-id')).toBe('corr-1');
  });
  it('encodes reserved path characters and preserves leading zeros', async () => {
    let target = '';
    const client = new CatalogSkuContextClient(
      'http://catalog-svc:3001',
      () => 't',
      async (url) => {
        target = String(url);
        return Response.json({ ...context, sku: '00/a' });
      },
    );
    await client.getContext('00/a', 'c');
    expect(target).toContain('/00%2Fa/contexto');
  });
  it('fails closed without service credentials', async () => {
    const client = new CatalogSkuContextClient(
      'http://catalog-svc:3001',
      () => undefined,
    );
    await expect(client.getContext('1', 'c')).rejects.toMatchObject({
      reason: 'AUTH_NOT_CONFIGURED',
    });
  });
  it('distinguishes unknown, inactive, ineligible and malformed references', async () => {
    const respond = (
      status: number,
      data?: unknown,
      contentType = 'application/json',
    ) =>
      new CatalogSkuContextClient(
        'http://catalog-svc',
        () => 't',
        async () =>
          new Response(data === undefined ? null : JSON.stringify(data), {
            status,
            headers: { 'content-type': contentType },
          }),
      );
    await expect(
      respond(
        404,
        { status: 404, code: 'SKU_NO_ENCONTRADO' },
        'application/problem+json',
      ).getContext('x', 'c'),
    ).rejects.toMatchObject({
      reason: 'SKU_NO_ENCONTRADO',
      upstreamStatus: 404,
    });
    await expect(respond(404).getContext('x', 'c')).rejects.toMatchObject({
      reason: 'UPSTREAM_FAILURE',
      upstreamStatus: 404,
    });
    await expect(
      respond(
        404,
        { code: 'SKU_NO_ENCONTRADO' },
        'application/json',
      ).getContext('x', 'c'),
    ).rejects.toMatchObject({ reason: 'UPSTREAM_FAILURE' });
    await expect(
      respond(200, { ...context, active: false }).getContext(context.sku, 'c'),
    ).rejects.toMatchObject({ reason: 'SKU_INACTIVO' });
    await expect(
      respond(200, { ...context, eligible: false }).getContext(
        context.sku,
        'c',
      ),
    ).rejects.toMatchObject({ reason: 'SKU_INELEGIBLE' });
    await expect(
      respond(200, { sku: context.sku }).getContext(context.sku, 'c'),
    ).rejects.toMatchObject({ reason: 'INVALID_RESPONSE' });
  });
  it.each([
    [401, 'SERVICE_AUTHENTICATION_FAILED'],
    [403, 'SERVICE_AUTHORIZATION_FAILED'],
    [503, 'UNAVAILABLE'],
  ])(
    'does not confuse upstream %i with missing SKU',
    async (status, reason) => {
      const client = new CatalogSkuContextClient(
        'http://catalog-svc',
        () => 't',
        async () => new Response(null, { status }),
      );
      await expect(client.getContext('0001', 'c')).rejects.toBeInstanceOf(
        IntegrationFailure,
      );
      await expect(client.getContext('0001', 'c')).rejects.toMatchObject({
        reason,
        upstreamStatus: status,
      });
    },
  );
  it('distinguishes timeouts and network failures', async () => {
    const timeout = new CatalogSkuContextClient(
      'http://catalog-svc',
      () => 't',
      async () => {
        throw new DOMException('timeout', 'TimeoutError');
      },
    );
    const network = new CatalogSkuContextClient(
      'http://catalog-svc',
      () => 't',
      async () => {
        throw new TypeError('network');
      },
    );
    await expect(timeout.getContext('1', 'c')).rejects.toMatchObject({
      reason: 'TIMEOUT',
    });
    await expect(network.getContext('1', 'c')).rejects.toMatchObject({
      reason: 'NETWORK_FAILURE',
    });
  });
});
